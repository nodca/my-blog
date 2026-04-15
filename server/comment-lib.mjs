import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_DB_PATH = path.resolve(
  process.env.COMMENT_DB_PATH ?? "data/comments.sqlite",
);

export function openCommentDatabase(databasePath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      page_title TEXT NOT NULL DEFAULT '',
      parent_id INTEGER REFERENCES comments(id) ON DELETE SET NULL,
      author TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'spam')),
      ip_hash TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      approved_at INTEGER,
      legacy_source TEXT NOT NULL DEFAULT '',
      legacy_id TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS comments_slug_status_created_idx
      ON comments (slug, status, created_at);

    CREATE INDEX IF NOT EXISTS comments_status_created_idx
      ON comments (status, created_at DESC);

    CREATE INDEX IF NOT EXISTS comments_parent_idx
      ON comments (parent_id);

    CREATE UNIQUE INDEX IF NOT EXISTS comments_legacy_source_id_idx
      ON comments (legacy_source, legacy_id)
      WHERE legacy_source <> '' AND legacy_id <> '';
  `);

  return db;
}

export function normalizeSlug(input) {
  if (!input) {
    return "";
  }

  let value = String(input).trim();

  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return "";
    }
  }

  value = value.split("?")[0].split("#")[0].trim();

  if (!value) {
    return "";
  }

  if (!value.startsWith("/")) {
    value = `/${value}`;
  }

  value = value.replace(/\/{2,}/g, "/");

  if (value.length > 1 && !value.endsWith("/")) {
    value = `${value}/`;
  }

  return value;
}

export function normalizePlainText(input, maxLength) {
  const text = String(input ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\0")
    .join("")
    .trim()
    .replace(/\n{3,}/g, "\n\n");

  if (!maxLength) {
    return text;
  }

  return text.slice(0, maxLength).trim();
}

export function normalizeEmail(input) {
  return String(input ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

export function stripHtml(input) {
  return decodeHtmlEntities(
    String(input ?? "")
      .replace(
        /<img\b[^>]*\batk-emoticon="([^"]+)"[^>]*>/gi,
        (_match, label) => `[表情: ${label}]`,
      )
      .replace(
        /<img\b[^>]*\balt="([^"]+)"[^>]*>/gi,
        (_match, label) => `[图片: ${label}]`,
      )
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n"),
  );
}

export function decodeHtmlEntities(input) {
  return String(input)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

export function toUnixTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return Math.floor(Date.now() / 1000);
  }

  return Math.floor(date.getTime() / 1000);
}

export function hashIp(ip, salt) {
  return crypto
    .createHash("sha256")
    .update(`${salt}:${ip || "unknown"}`)
    .digest("hex");
}

export function serializeCommentRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    pageTitle: row.page_title,
    parentId: row.parent_id,
    author: row.author,
    email: row.email,
    content: row.content,
    status: row.status,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    approvedAt: row.approved_at
      ? new Date(row.approved_at * 1000).toISOString()
      : null,
  };
}

export function safeInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
