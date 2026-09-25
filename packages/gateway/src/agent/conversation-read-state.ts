// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Conversation read state — which agent conversations hold something the
 * operator has not seen yet.
 *
 * The table is the set of unread conversations: a row exists exactly while a
 * conversation has unseen agent content, and reading the conversation removes
 * it. There is no "read" row to keep, so a conversation the operator has been
 * through costs nothing, and a mark naming a conversation that no longer
 * exists deletes nothing rather than leaving a record behind.
 *
 * A conversation becomes unread when the agent writes into it while nobody is
 * looking, and becomes read again the moment the operator has it open on
 * screen. "Open on screen" is the whole definition: a client that merely
 * fetched or synced the transcript has not read it, so the signal is an
 * explicit mark from the surface that rendered it, not a side effect of the
 * GET. Because the mark lands on the gateway rather than in each client, every
 * surface that reports what it is showing shares one answer.
 *
 * The state lives here rather than on `ConversationRecord` because that record
 * is rebuilt wholesale from the live session on every turn (see
 * `AgentService.persistConversation`): a field written by a route would be
 * dropped by the next save, and a read-modify-write from a route would race
 * the streaming turn that owns the file. A side table also lets the list
 * answer "which of these are unread" in one query instead of one lookup per
 * row.
 *
 * Whether the operator is looking *right now* is deliberately not stored here.
 * That is ephemeral and tied to a live client, so it is held in memory by
 * `ConversationReadStateService`; this table records only durable facts.
 *
 * House style matches the sibling stores: plain functions over a
 * better-sqlite3 handle, explicit `now`, single-writer in production.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * DDL — idempotent, so it is called both from `runSchemaSetup` (fresh
 * installs) and from the numbered migration that introduced it (upgrades).
 *
 * No secondary index: every read is a lookup by `conversation_id`, which the
 * primary key already serves.
 */
export function createConversationReadStateTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_read_state (
      conversation_id TEXT PRIMARY KEY,
      unread_since INTEGER NOT NULL
    )
  `);
}

/**
 * Record that agent-authored content landed in a conversation the operator is
 * not watching, opening an unread episode if one is not already open.
 *
 * `unread_since` keeps the moment the episode began rather than the moment of
 * the latest arrival: an episode is a single "there is something new here",
 * not a count of messages.
 *
 * Returns whether this arrival *opened* the episode. That is the entire
 * notification-coalescing rule: the operator is told once that a conversation
 * has something new, and anything else the agent adds before they read it is
 * silent. No separate "already notified" bookkeeping is needed, because the episode
 * and the row are the same thing — a second arrival conflicts and changes
 * nothing, so it reports false.
 */
export function recordAgentMessage(
  db: Db,
  conversationId: string,
  now: number,
): { openedEpisode: boolean } {
  const info = db
    .prepare(
      `INSERT INTO conversation_read_state (conversation_id, unread_since)
       VALUES (?, ?)
       ON CONFLICT(conversation_id) DO NOTHING`,
    )
    .run(conversationId, now);
  return { openedEpisode: info.changes > 0 };
}

/**
 * Record that the operator has the conversation open on screen, ending any
 * unread episode. Idempotent, and a no-op for a conversation that was already
 * read or never existed.
 */
export function markConversationOpened(db: Db, conversationId: string): void {
  db.prepare("DELETE FROM conversation_read_state WHERE conversation_id = ?").run(conversationId);
}

/**
 * The unread subset of `conversationIds` — the conversation list's single
 * read. Callers pass the page they are about to render, so the query stays
 * bounded by the page rather than by the whole history.
 */
export function readUnreadConversationIds(db: Db, conversationIds: readonly string[]): Set<string> {
  const unread = new Set<string>();
  if (conversationIds.length === 0) return unread;
  // SQLite's variable limit is far above any page size a client asks for, but
  // chunking keeps a pathological caller from tripping it.
  const chunkSize = 500;
  for (let i = 0; i < conversationIds.length; i += chunkSize) {
    const chunk = conversationIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare<
        string[],
        { conversation_id: string }
      >(`SELECT conversation_id FROM conversation_read_state WHERE conversation_id IN (${placeholders})`)
      .all(...chunk);
    for (const row of rows) unread.add(row.conversation_id);
  }
  return unread;
}

/** Whether a single conversation holds something unseen. */
export function isConversationUnread(db: Db, conversationId: string): boolean {
  return (
    db
      .prepare<
        [string],
        { one: number }
      >("SELECT 1 AS one FROM conversation_read_state WHERE conversation_id = ?")
      .get(conversationId) !== undefined
  );
}

/**
 * Drop read state for conversations that no longer exist. Takes a batch
 * because the retention sweep deletes conversations in batches, and one write
 * op per conversation would put a bulk background cleanup in front of
 * interactive work in the writer queue.
 */
export function forgetConversationReadState(db: Db, conversationIds: readonly string[]): void {
  if (conversationIds.length === 0) return;
  const chunkSize = 500;
  for (let i = 0; i < conversationIds.length; i += chunkSize) {
    const chunk = conversationIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(
      `DELETE FROM conversation_read_state WHERE conversation_id IN (${placeholders})`,
    ).run(...chunk);
  }
}
