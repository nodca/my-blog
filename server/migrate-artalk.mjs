import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import {
  DEFAULT_DB_PATH,
  hashIp,
  normalizeEmail,
  normalizePlainText,
  normalizeSlug,
  openCommentDatabase,
  stripHtml,
  toUnixTimestamp,
} from "./comment-lib.mjs";

const EXPORT_PATH = process.env.ARTALK_EXPORT_PATH
  ? path.resolve(process.env.ARTALK_EXPORT_PATH)
  : "";
const DATABASE_URL = process.env.ARTALK_DATABASE_URL ?? "";
const IP_SALT =
  process.env.COMMENT_IP_SALT ??
  process.env.COMMENT_ADMIN_TOKEN ??
  "blog-comment-salt";

const db = openCommentDatabase(DEFAULT_DB_PATH);

const lookupLegacyStmt = db.prepare(`
  SELECT id
  FROM comments
  WHERE legacy_source = ? AND legacy_id = ?
  LIMIT 1
`);

const insertLegacyStmt = db.prepare(`
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
  ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const updateParentStmt = db.prepare(`
  UPDATE comments
  SET parent_id = ?
  WHERE id = ?
`);

async function loadRows() {
  if (EXPORT_PATH) {
    const raw = fs.readFileSync(EXPORT_PATH, "utf8");
    return JSON.parse(raw);
  }

  if (!DATABASE_URL) {
    throw new Error(
      "缺少 ARTALK_DATABASE_URL 或 ARTALK_EXPORT_PATH，无法执行迁移",
    );
  }

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    const result = await client.query(`
      SELECT
        c.id,
        c.page_key,
        c.rid,
        c.content,
        c.is_pending,
        c.created_at,
        c.ip,
        c.ua,
        p.title AS page_title,
        u.name AS author,
        u.email
      FROM comments c
      LEFT JOIN users u ON u.id = c.user_id
      LEFT JOIN pages p ON p.key = c.page_key
      WHERE c.deleted_at IS NULL
      ORDER BY c.id ASC
    `);

    return result.rows;
  } finally {
    await client.end();
  }
}

function normalizeLegacyRow(row) {
  const slug = normalizeSlug(row.page_key);
  const content = normalizePlainText(stripHtml(row.content), 2000);

  if (!slug || !content) {
    return null;
  }

  const createdAt = toUnixTimestamp(row.created_at);
  const status = row.is_pending ? "pending" : "approved";

  return {
    legacyId: String(row.id),
    legacyReplyId: row.rid ? String(row.rid) : "",
    slug,
    pageTitle: normalizePlainText(row.page_title, 160),
    author: normalizePlainText(row.author || "匿名用户", 32) || "匿名用户",
    email: normalizeEmail(row.email),
    content,
    status,
    ipHash: hashIp(row.ip || `legacy-${row.id}`, IP_SALT),
    userAgent: String(row.ua ?? "").slice(0, 500),
    createdAt,
    approvedAt: status === "approved" ? createdAt : null,
  };
}

async function main() {
  const rows = await loadRows();
  const normalizedRows = rows.map(normalizeLegacyRow).filter(Boolean);

  const legacyIdMap = new Map();
  let imported = 0;
  let skipped = 0;

  db.exec("BEGIN");

  try {
    for (const item of normalizedRows) {
      const existing = lookupLegacyStmt.get("artalk", item.legacyId);
      if (existing) {
        legacyIdMap.set(item.legacyId, existing.id);
        skipped += 1;
        continue;
      }

      const metadataJson = JSON.stringify({
        migratedFrom: "artalk",
        legacyId: item.legacyId,
      });

      const result = insertLegacyStmt.run(
        item.slug,
        item.pageTitle,
        item.author,
        item.email,
        item.content,
        item.status,
        item.ipHash,
        item.userAgent,
        item.createdAt,
        item.approvedAt,
        "artalk",
        item.legacyId,
        metadataJson,
      );

      legacyIdMap.set(item.legacyId, Number(result.lastInsertRowid));
      imported += 1;
    }

    for (const item of normalizedRows) {
      if (!item.legacyReplyId) {
        continue;
      }

      const localId = legacyIdMap.get(item.legacyId);
      const localParentId = legacyIdMap.get(item.legacyReplyId);
      if (!localId || !localParentId || localId === localParentId) {
        continue;
      }

      updateParentStmt.run(localParentId, localId);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  console.log(
    JSON.stringify(
      {
        imported,
        skipped,
        total: normalizedRows.length,
        dbPath: DEFAULT_DB_PATH,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[artalk-migrate]", error);
  process.exitCode = 1;
});
