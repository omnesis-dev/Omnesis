// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The ranked observations chosen for one morning brief. The morning recheck
 * replaces a day's list; sending the brief stamps it with the conversation
 * message that carried it and ships its observations in the same transaction.
 */

import { knowledgeOwnerReadPredicate } from "../knowledge/storage-fence.js";
import { transitionObservation } from "./observations.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface MorningBriefItem {
  day: string;
  rank: number;
  observationId: string;
  runId: string;
  conversationId: string | null;
  messageId: string | null;
}

interface ItemRow {
  day: string;
  rank: number;
  observation_id: string;
  run_id: string;
  conversation_id: string | null;
  message_id: string | null;
}

function toItem(r: ItemRow): MorningBriefItem {
  return {
    day: r.day,
    rank: r.rank,
    observationId: r.observation_id,
    runId: r.run_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
  };
}

/**
 * Replace the unsent item list for `day`. A list already stamped with a
 * message is history and is never replaced; returns false in that case.
 */
export function replaceMorningBriefItems(
  db: Db,
  day: string,
  runId: string,
  observationIds: readonly string[],
): boolean {
  return db.transaction(() => {
    if (morningBriefSent(db, day)) return false;
    db.prepare<[string]>("DELETE FROM morning_brief_items WHERE day = ?").run(day);
    const insert = db.prepare<[string, number, string, string]>(
      "INSERT INTO morning_brief_items (day, rank, observation_id, run_id) VALUES (?, ?, ?, ?)",
    );
    observationIds.forEach((id, i) => insert.run(day, i + 1, id, runId));
    return true;
  })();
}

export function listMorningBriefItems(db: Db, day: string): MorningBriefItem[] {
  return db
    .prepare<[string], ItemRow>(
      `SELECT * FROM morning_brief_items
        WHERE day = ? AND ${knowledgeOwnerReadPredicate(db, "morning_brief_items.observation_id")}
        ORDER BY rank ASC`,
    )
    .all(day)
    .map(toItem);
}

/** The item list a sent message carried, in rank order. */
export function listMorningBriefItemsForMessage(db: Db, messageId: string): MorningBriefItem[] {
  return db
    .prepare<[string], ItemRow>(
      `SELECT * FROM morning_brief_items
        WHERE message_id = ? AND ${knowledgeOwnerReadPredicate(db, "morning_brief_items.observation_id")}
        ORDER BY rank ASC`,
    )
    .all(messageId)
    .map(toItem);
}

export interface SentMorningBrief {
  day: string;
  runId: string;
  conversationId: string;
  messageId: string;
  itemCount: number;
  sentAt: number;
}

export type MarkMorningBriefSentResult =
  | { ok: true; shippedObservationIds: string[] }
  | { ok: false; reason: "already_sent" };

/**
 * Record that `day`'s brief was sent as `messageId`, stamp its item list and
 * ship every listed observation that is still open. At most one brief per
 * day: a second send for the same day is refused.
 */
export function markMorningBriefSent(
  db: Db,
  input: { day: string; runId: string; conversationId: string; messageId: string },
  now: number,
): MarkMorningBriefSentResult {
  return db.transaction((): MarkMorningBriefSentResult => {
    if (morningBriefSent(db, input.day)) return { ok: false, reason: "already_sent" };
    const items = db
      .prepare<
        [string],
        { observation_id: string }
      >("SELECT observation_id FROM morning_brief_items WHERE day = ? ORDER BY rank")
      .all(input.day);
    db.prepare(
      `INSERT INTO morning_briefs (day, run_id, conversation_id, message_id, item_count, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.day, input.runId, input.conversationId, input.messageId, items.length, now);
    db.prepare<[string, string, string]>(
      "UPDATE morning_brief_items SET conversation_id = ?, message_id = ? WHERE day = ?",
    ).run(input.conversationId, input.messageId, input.day);
    const shippedObservationIds: string[] = [];
    for (const row of items) {
      if (
        transitionObservation(
          db,
          row.observation_id,
          {
            state: "shipped",
            shipped: { conversationId: input.conversationId, messageId: input.messageId },
          },
          now,
        )
      )
        shippedObservationIds.push(row.observation_id);
    }
    return { ok: true, shippedObservationIds };
  })();
}

/** Whether `day`'s brief has already been sent. */
export function morningBriefSent(db: Db, day: string): boolean {
  return (
    db
      .prepare<[string], { one: number }>("SELECT 1 AS one FROM morning_briefs WHERE day = ?")
      .get(day) !== undefined
  );
}

export function getSentMorningBrief(db: Db, day: string): SentMorningBrief | null {
  const row = db
    .prepare<
      [string],
      {
        day: string;
        run_id: string;
        conversation_id: string;
        message_id: string;
        item_count: number;
        sent_at: number;
      }
    >("SELECT * FROM morning_briefs WHERE day = ?")
    .get(day);
  return row
    ? {
        day: row.day,
        runId: row.run_id,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        itemCount: row.item_count,
        sentAt: row.sent_at,
      }
    : null;
}

/** The newest sent morning brief, if any. */
export function latestSentMorningBrief(db: Db): SentMorningBrief | null {
  const row = db
    .prepare<[], { day: string }>("SELECT day FROM morning_briefs ORDER BY day DESC LIMIT 1")
    .get();
  return row ? getSentMorningBrief(db, row.day) : null;
}

/**
 * Sent briefs that showed an observation since removed by a privacy delete:
 * its row is gone and, unlike one retired by age, it left no outcome record.
 * Such a brief's text may quote the deleted source.
 */
export function listTaintedMorningBriefs(
  db: Db,
): Array<{ conversationId: string; messageId: string }> {
  return db
    .prepare<[], { conversation_id: string; message_id: string }>(
      `SELECT DISTINCT i.conversation_id, i.message_id FROM morning_brief_items i
        WHERE i.message_id IS NOT NULL AND i.conversation_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = i.observation_id)
          AND NOT EXISTS (SELECT 1 FROM observation_outcomes x WHERE x.id = i.observation_id)`,
    )
    .all()
    .map((r) => ({ conversationId: r.conversation_id, messageId: r.message_id }));
}

/** Forget a redacted brief's items, so it is redacted once and lists nothing. */
export function clearMorningBriefMessageItems(db: Db, messageId: string): number {
  return db.prepare<[string]>("DELETE FROM morning_brief_items WHERE message_id = ?").run(messageId)
    .changes;
}
