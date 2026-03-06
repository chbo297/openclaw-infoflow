/**
 * SQLite-backed persistent store for sent message IDs.
 * Records messageid + msgseqid for every outbound message so that
 * recall (撤回) can look up any sub-message, including those from split sends.
 *
 * Uses Node 22+ built-in `node:sqlite` (DatabaseSync, synchronous API).
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getInfoflowRuntime } from "./runtime.js";
import type { InfoflowMessageContentItem } from "./types.js";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DB_FILENAME = "sent-messages.db";
const AUTO_CLEANUP_DAYS = 7;
const AUTO_CLEANUP_MS = AUTO_CLEANUP_DAYS * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// DB singleton (lazy-init)
// ---------------------------------------------------------------------------

let db: DatabaseSync | null = null;

function resolveDbPath(): string {
  const env = process.env;
  const stateDir = getInfoflowRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(stateDir, "infoflow", DB_FILENAME);
}

function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath = resolveDbPath();
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const sqlite = require("node:sqlite") as typeof import("node:sqlite");
  db = new sqlite.DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      target TEXT NOT NULL,
      messageid TEXT NOT NULL,
      msgseqid TEXT NOT NULL DEFAULT '',
      digest TEXT NOT NULL DEFAULT '',
      sent_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_target_sent
      ON sent_messages(account_id, target, sent_at DESC);
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type SentMessageRecord = {
  target: string;
  messageid: string;
  msgseqid: string;
  digest: string;
  sentAt: number;
};

/**
 * Records a sent message. Also runs auto-cleanup of old records.
 * Synchronous (DatabaseSync); failures are swallowed so sending is never blocked.
 */
export function recordSentMessage(accountId: string, record: SentMessageRecord): void {
  try {
    const d = getDb();
    d.prepare(
      `INSERT INTO sent_messages (account_id, target, messageid, msgseqid, digest, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      record.target,
      record.messageid,
      record.msgseqid,
      record.digest,
      record.sentAt,
    );

    // Auto-cleanup: delete records older than 7 days
    const cutoff = Date.now() - AUTO_CLEANUP_MS;
    d.prepare(`DELETE FROM sent_messages WHERE sent_at < ? AND account_id = ?`).run(
      cutoff,
      accountId,
    );
  } catch {
    // Silently ignore — do not block sending
  }
}

/**
 * Queries the most recent N sent messages for a given target, ordered by sent_at DESC.
 */
export function querySentMessages(
  accountId: string,
  params: { target: string; count: number },
): SentMessageRecord[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT target, messageid, msgseqid, digest, sent_at
       FROM sent_messages
       WHERE account_id = ? AND target = ?
       ORDER BY sent_at DESC
       LIMIT ?`,
    )
    .all(accountId, params.target, params.count) as Array<{
    target: string;
    messageid: string;
    msgseqid: string;
    digest: string;
    sent_at: number;
  }>;

  return rows.map((r) => ({
    target: r.target,
    messageid: r.messageid,
    msgseqid: r.msgseqid,
    digest: r.digest,
    sentAt: r.sent_at,
  }));
}

/**
 * Finds a single sent message by messageid.
 */
export function findSentMessage(
  accountId: string,
  messageid: string,
): SentMessageRecord | undefined {
  const d = getDb();
  const row = d
    .prepare(
      `SELECT target, messageid, msgseqid, digest, sent_at
       FROM sent_messages
       WHERE account_id = ? AND messageid = ?
       LIMIT 1`,
    )
    .get(accountId, messageid) as
    | { target: string; messageid: string; msgseqid: string; digest: string; sent_at: number }
    | undefined;

  if (!row) return undefined;
  return {
    target: row.target,
    messageid: row.messageid,
    msgseqid: row.msgseqid,
    digest: row.digest,
    sentAt: row.sent_at,
  };
}

/**
 * Removes recalled messages from the store by their messageids.
 */
export function removeRecalledMessages(accountId: string, messageids: string[]): void {
  if (messageids.length === 0) return;
  const d = getDb();
  const placeholders = messageids.map(() => "?").join(",");
  d.prepare(
    `DELETE FROM sent_messages WHERE account_id = ? AND messageid IN (${placeholders})`,
  ).run(accountId, ...messageids);
}

// ---------------------------------------------------------------------------
// Digest builder
// ---------------------------------------------------------------------------

const DIGEST_MAX_LEN = 100;

/**
 * Builds a short digest string from message contents.
 * - Text/markdown/link: first 100 chars, truncated with "…"
 * - Image only: "image"
 * - Empty: ""
 */
export function buildMessageDigest(contents: InfoflowMessageContentItem[]): string {
  const textParts: string[] = [];
  let hasImage = false;

  for (const item of contents) {
    const type = item.type.toLowerCase();
    if (type === "text" || type === "md" || type === "markdown") {
      textParts.push(item.content);
    } else if (type === "link") {
      textParts.push(item.content);
    } else if (type === "image") {
      hasImage = true;
    }
  }

  const merged = textParts.join(" ").trim();
  if (merged) {
    return merged.length > DIGEST_MAX_LEN ? merged.slice(0, DIGEST_MAX_LEN) + "…" : merged;
  }
  if (hasImage) return "image";
  return "";
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal)
// ---------------------------------------------------------------------------

/** @internal — Close and reset the DB singleton. Only use in tests. */
export function _resetStore(): void {
  if (db) {
    try {
      db.close();
    } catch {
      // ignore
    }
    db = null;
  }
}

/** @internal — Override the DB instance for testing. */
export function _setDb(next: DatabaseSync): void {
  db = next;
}
