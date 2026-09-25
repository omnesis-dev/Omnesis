// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * SQLite storage for the pushed agent-conversation ledger: `agent_messages`,
 * the append-only record of every turn a harness plugin (OpenClaw / Hermes)
 * pushes to `POST /agent-messages`. One row per turn; the projector
 * (`upsert.ts`) renders one corpus document per (harness, channel, chat,
 * local day) — the same shape, and the same shared renderer, as the
 * collector-hosted reader sources, so a plugin transport and a reader
 * transport produce byte-identical documents.
 *
 * Pure SQL over a better-sqlite3 handle. Writes route through the WriteGate
 * (`agentMessages.appendMessage`); reads run on the gateway read handle.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/** One pushed turn, as stored in `agent_messages`. */
export interface AgentMessageRow {
  /** Stable idempotency key (harness-supplied or server-synthesized). */
  id: string;
  /** Harness id: `openclaw` / `hermes`. */
  harness: string;
  /** Channel id: `whatsapp`, `slack`, `telegram`, `local`, … */
  channel: string;
  /** Chat id within the channel; `""` for a host-local surface. */
  chatId: string;
  chatName: string | null;
  chatType: string | null;
  /** Gateway-local calendar day (`YYYY-MM-DD`) of `occurredAt`. */
  day: string;
  role: "user" | "assistant";
  text: string;
  /** ISO-8601 instant the turn occurred. */
  occurredAt: string;
  /** Trust marker; `harness-pushed` for everything on this path. */
  provenance: string;
}

/** The (harness, channel, chat, day) identity of one projected document. */
export interface Bucket {
  harness: string;
  channel: string;
  chatId: string;
  day: string;
}

export function createAgentMessagesTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      channel TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      chat_name TEXT,
      chat_type TEXT,
      day TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      provenance TEXT NOT NULL DEFAULT 'harness-pushed'
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_bucket
      ON agent_messages (harness, channel, chat_id, day);
  `);
}

interface AgentMessageDbRow {
  id: string;
  harness: string;
  channel: string;
  chat_id: string;
  chat_name: string | null;
  chat_type: string | null;
  day: string;
  role: string;
  text: string;
  occurred_at: string;
  provenance: string;
}

function rowToMessage(r: AgentMessageDbRow): AgentMessageRow {
  return {
    id: r.id,
    harness: r.harness,
    channel: r.channel,
    chatId: r.chat_id,
    chatName: r.chat_name,
    chatType: r.chat_type,
    day: r.day,
    role: r.role === "user" ? "user" : "assistant",
    text: r.text,
    occurredAt: r.occurred_at,
    provenance: r.provenance,
  };
}

/**
 * Insert one turn. `INSERT OR IGNORE` because the id doubles as the client
 * idempotency key: a retried push (or a live message the install-time
 * backfill also read) re-sends the same id and must not duplicate. Returns
 * whether a new row was actually inserted, so the caller only re-projects a
 * bucket that genuinely changed. Chat display metadata is not refreshed here
 * — the projector resolves it from the bucket's freshest non-null row.
 */
export function insertAgentMessage(db: Db, m: AgentMessageRow): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO agent_messages
         (id, harness, channel, chat_id, chat_name, chat_type, day, role, text, occurred_at, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.id,
      m.harness,
      m.channel,
      m.chatId,
      m.chatName,
      m.chatType,
      m.day,
      m.role,
      m.text,
      m.occurredAt,
      m.provenance,
    );
  return result.changes > 0;
}

/** All turns in one bucket, in occurrence order. */
export function listBucketMessages(db: Db, b: Bucket): AgentMessageRow[] {
  const rows = db
    .prepare<[string, string, string, string], AgentMessageDbRow>(
      `SELECT * FROM agent_messages
       WHERE harness = ? AND channel = ? AND chat_id = ? AND day = ?
       ORDER BY occurred_at, rowid`,
    )
    .all(b.harness, b.channel, b.chatId, b.day);
  return rows.map(rowToMessage);
}

/** Distinct buckets present in the ledger — used for boot reconciliation. */
export function listAllBuckets(db: Db): Bucket[] {
  const rows = db
    .prepare<
      [],
      { harness: string; channel: string; chat_id: string; day: string }
    >(`SELECT DISTINCT harness, channel, chat_id, day FROM agent_messages`)
    .all();
  return rows.map((r) => ({
    harness: r.harness,
    channel: r.channel,
    chatId: r.chat_id,
    day: r.day,
  }));
}
