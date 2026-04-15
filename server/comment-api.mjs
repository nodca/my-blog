import "dotenv/config";
import crypto from "node:crypto";
import http from "node:http";
import {
  DEFAULT_DB_PATH,
  hashIp,
  normalizeEmail,
  normalizePlainText,
  normalizeSlug,
  openCommentDatabase,
  safeInteger,
  serializeCommentRow,
} from "./comment-lib.mjs";

const PORT = Number.parseInt(process.env.COMMENT_PORT ?? "4322", 10);
const COMMENT_AUTO_APPROVE = /^(1|true|yes)$/i.test(
  process.env.COMMENT_AUTO_APPROVE ?? "",
);
const COMMENT_ADMIN_TOKEN = process.env.COMMENT_ADMIN_TOKEN ?? "";
const COMMENT_IP_SALT =
  process.env.COMMENT_IP_SALT ?? COMMENT_ADMIN_TOKEN ?? "blog-comment-salt";
const BODY_LIMIT = 24 * 1024;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const RATE_LIMIT_MAX_REQUESTS = 3;
const allowedOrigins = new Set(
  (
    process.env.COMMENT_ALLOWED_ORIGINS ??
    "http://localhost:4321,http://127.0.0.1:4321,https://blog.cyb1.org"
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

const db = openCommentDatabase(DEFAULT_DB_PATH);
const rateLimitHits = new Map();

const publicListStmt = db.prepare(`
  SELECT *
  FROM comments
  WHERE slug = ? AND status = 'approved'
  ORDER BY created_at ASC, id ASC
`);

const publicCountStmt = db.prepare(`
  SELECT COUNT(*) AS total
  FROM comments
  WHERE slug = ? AND status = 'approved'
`);

const parentLookupStmt = db.prepare(`
  SELECT id, slug, status
  FROM comments
  WHERE id = ?
`);

const duplicateStmt = db.prepare(`
  SELECT id, status
  FROM comments
  WHERE slug = ?
    AND ip_hash = ?
    AND content = ?
    AND created_at >= ?
  LIMIT 1
`);

const insertStmt = db.prepare(`
  INSERT INTO comments (
    slug,
    page_title,
    parent_id,
    author,
    email,
    content,
    status,
    ip_hash,
    user_agent,
    created_at,
    approved_at,
    legacy_source,
    legacy_id,
    metadata_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '{}')
`);

const summaryStmt = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
    SUM(CASE WHEN status = 'spam' THEN 1 ELSE 0 END) AS spam
  FROM comments
`);

const topPagesStmt = db.prepare(`
  SELECT
    slug,
    page_title,
    COUNT(*) AS total
  FROM comments
  WHERE status = 'approved'
  GROUP BY slug, page_title
  ORDER BY total DESC, slug ASC
  LIMIT 10
`);

const moderateApproveStmt = db.prepare(`
  UPDATE comments
  SET status = 'approved', approved_at = ?
  WHERE id = ?
`);

const moderatePendingStmt = db.prepare(`
  UPDATE comments
  SET status = 'pending', approved_at = NULL
  WHERE id = ?
`);

const moderateSpamStmt = db.prepare(`
  UPDATE comments
  SET status = 'spam', approved_at = NULL
  WHERE id = ?
`);

const deleteStmt = db.prepare(`
  DELETE FROM comments
  WHERE id = ?
`);

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket.remoteAddress ?? "";
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function respondJson(req, res, statusCode, payload) {
  setCorsHeaders(req, res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function respondEmpty(req, res, statusCode) {
  setCorsHeaders(req, res);
  res.writeHead(statusCode);
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > BODY_LIMIT) {
        reject(new Error("body_too_large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid_json"));
      }
    });

    req.on("error", reject);
  });
}

function validateCommentInput(body) {
  const slug = normalizeSlug(body.slug ?? body.pageKey);
  const pageTitle = normalizePlainText(body.pageTitle, 160);
  const author = normalizePlainText(body.author, 32);
  const email = normalizeEmail(body.email);
  const content = normalizePlainText(body.content, 2000);
  const website = String(body.website ?? "").trim();
  const parentId = safeInteger(body.parentId);

  if (!slug) {
    return { error: "缺少文章标识" };
  }

  if (!author || author.length < 2) {
    return { error: "昵称至少 2 个字符" };
  }

  if (!content || content.length < 3) {
    return { error: "评论内容至少 3 个字符" };
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "邮箱格式不正确" };
  }

  if (website) {
    return { error: "提交失败" };
  }

  return {
    value: {
      slug,
      pageTitle,
      author,
      email,
      content,
      parentId,
    },
  };
}

function checkRateLimit(ipHash) {
  const now = Math.floor(Date.now() / 1000);
  const hits = rateLimitHits.get(ipHash) ?? [];
  const recentHits = hits.filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_SECONDS,
  );

  if (recentHits.length >= RATE_LIMIT_MAX_REQUESTS) {
    rateLimitHits.set(ipHash, recentHits);
    return false;
  }

  recentHits.push(now);
  rateLimitHits.set(ipHash, recentHits);
  return true;
}

function safeCompareToken(input, expected) {
  const left = Buffer.from(input ?? "");
  const right = Buffer.from(expected ?? "");

  if (!left.length || left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function requireAdmin(req, res) {
  if (!COMMENT_ADMIN_TOKEN) {
    respondJson(req, res, 503, { message: "服务端未配置管理令牌" });
    return false;
  }

  const authorization = req.headers.authorization ?? "";
  if (!authorization.startsWith("Bearer ")) {
    respondJson(req, res, 401, { message: "缺少管理令牌" });
    return false;
  }

  const token = authorization.slice(7).trim();
  if (!safeCompareToken(token, COMMENT_ADMIN_TOKEN)) {
    respondJson(req, res, 401, { message: "管理令牌无效" });
    return false;
  }

  return true;
}

function listAdminComments(url) {
  const status = url.searchParams.get("status") ?? "all";
  const search = normalizePlainText(url.searchParams.get("q") ?? "", 120);
  const limit = Math.min(
    Math.max(
      Number.parseInt(url.searchParams.get("limit") ?? "50", 10) || 50,
      1,
    ),
    200,
  );
  const offset = Math.max(
    Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
    0,
  );

  const params = [];
  const conditions = [];

  if (status !== "all") {
    conditions.push("status = ?");
    params.push(status);
  }

  if (search) {
    const keyword = `%${search}%`;
    conditions.push("(slug LIKE ? OR author LIKE ? OR content LIKE ?)");
    params.push(keyword, keyword, keyword);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .prepare(`
      SELECT *
      FROM comments
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset);

  const totalRow = db
    .prepare(`
      SELECT COUNT(*) AS total
      FROM comments
      ${whereSql}
    `)
    .get(...params);

  return {
    comments: rows.map(serializeCommentRow),
    total: totalRow.total,
  };
}

async function handlePublicCreate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error.message === "body_too_large") {
      respondJson(req, res, 413, { message: "请求体过大" });
      return;
    }

    respondJson(req, res, 400, { message: "请求体不是合法 JSON" });
    return;
  }

  const validation = validateCommentInput(body);
  if (validation.error) {
    respondJson(req, res, 400, { message: validation.error });
    return;
  }

  const ipHash = hashIp(getClientIp(req), COMMENT_IP_SALT);
  if (!checkRateLimit(ipHash)) {
    respondJson(req, res, 429, {
      message: "提交过于频繁，请 10 分钟后再试",
    });
    return;
  }

  const duplicate = duplicateStmt.get(
    validation.value.slug,
    ipHash,
    validation.value.content,
    Math.floor(Date.now() / 1000) - RATE_LIMIT_WINDOW_SECONDS,
  );

  if (duplicate) {
    respondJson(req, res, 409, {
      message:
        duplicate.status === "approved"
          ? "评论已存在"
          : "评论已提交，请勿重复发送",
    });
    return;
  }

  let parentId = validation.value.parentId;
  if (parentId) {
    const parent = parentLookupStmt.get(parentId);
    if (
      !parent ||
      parent.slug !== validation.value.slug ||
      parent.status === "spam"
    ) {
      parentId = null;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const status = COMMENT_AUTO_APPROVE ? "approved" : "pending";
  const approvedAt = COMMENT_AUTO_APPROVE ? now : null;

  const result = insertStmt.run(
    validation.value.slug,
    validation.value.pageTitle,
    parentId,
    validation.value.author,
    validation.value.email,
    validation.value.content,
    status,
    ipHash,
    String(req.headers["user-agent"] ?? "").slice(0, 500),
    now,
    approvedAt,
  );

  respondJson(req, res, COMMENT_AUTO_APPROVE ? 201 : 202, {
    id: result.lastInsertRowid,
    status,
    message: COMMENT_AUTO_APPROVE ? "评论已发布" : "评论已提交，审核后显示",
  });
}

async function handleAdminModerate(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    respondJson(req, res, 400, { message: "请求体不是合法 JSON" });
    return;
  }

  const id = safeInteger(body.id);
  const action = String(body.action ?? "");

  if (!id) {
    respondJson(req, res, 400, { message: "缺少评论 ID" });
    return;
  }

  if (!["approve", "pending", "spam", "delete"].includes(action)) {
    respondJson(req, res, 400, { message: "不支持的操作" });
    return;
  }

  if (action === "approve") {
    moderateApproveStmt.run(Math.floor(Date.now() / 1000), id);
  } else if (action === "pending") {
    moderatePendingStmt.run(id);
  } else if (action === "spam") {
    moderateSpamStmt.run(id);
  } else {
    deleteStmt.run(id);
  }

  respondJson(req, res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    respondEmpty(req, res, 204);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/comments/health") {
    respondJson(req, res, 200, {
      ok: true,
      autoApprove: COMMENT_AUTO_APPROVE,
      dbPath: DEFAULT_DB_PATH,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/comments") {
    const slug = normalizeSlug(url.searchParams.get("slug"));
    if (!slug) {
      respondJson(req, res, 400, { message: "缺少文章标识" });
      return;
    }

    const comments = publicListStmt.all(slug).map(serializeCommentRow);
    const total = publicCountStmt.get(slug).total;
    respondJson(req, res, 200, { comments, total });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/comments") {
    await handlePublicCreate(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/comments/admin/")) {
    if (!requireAdmin(req, res)) {
      return;
    }

    if (
      req.method === "GET" &&
      url.pathname === "/api/comments/admin/summary"
    ) {
      const counts = summaryStmt.get();
      const topPages = topPagesStmt.all();
      respondJson(req, res, 200, {
        counts: {
          total: counts.total ?? 0,
          pending: counts.pending ?? 0,
          approved: counts.approved ?? 0,
          spam: counts.spam ?? 0,
        },
        topPages,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/comments/admin/list") {
      respondJson(req, res, 200, listAdminComments(url));
      return;
    }

    if (
      req.method === "POST" &&
      url.pathname === "/api/comments/admin/moderate"
    ) {
      await handleAdminModerate(req, res);
      return;
    }
  }

  respondJson(req, res, 404, { message: "Not Found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[comments] listening on http://0.0.0.0:${PORT} using ${DEFAULT_DB_PATH}`,
  );
});
