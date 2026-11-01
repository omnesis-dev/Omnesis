// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Durable, revision-fenced outbox for Note clarification conversations. */
import { recordAgentMessage } from "../../agent/conversation-read-state.js";
import { createHash } from "node:crypto";
import type { NoteAgentReceipt } from "./storage.js";
import type Database from "better-sqlite3";

export interface NoteHandoff {
  conversationId: string;
  noteId: string;
  revision: number;
  attempt: number;
  text: string;
  capturedAt: string;
  day: string;
  instructionAt: string;
  timeZone?: string;
  taskId?: string;
  question: string;
  /** Agent-produced evidence and receipts, never user testimony. */
  context: string;
  requiresReview?: boolean;
  changes: NoteAgentReceipt["changes"];
}
export function createNoteHandoffTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS note_agent_handoffs (
    entry_id TEXT NOT NULL, revision INTEGER NOT NULL, conversation_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending', payload_json TEXT NOT NULL,
    PRIMARY KEY(entry_id,revision), FOREIGN KEY(entry_id) REFERENCES note_entries(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_note_handoffs_active ON note_agent_handoffs(state)
    WHERE state IN ('pending','publishing')`);
}
export function noteHandoffId(noteId: string, revision: number): string {
  return `s_note_${createHash("sha256")
    .update(JSON.stringify([noteId, revision]))
    .digest("hex")}`;
}
export function reserveNoteHandoff(db: Database.Database, input: NoteHandoff): boolean {
  return db.transaction(() => {
    const eligible = db
      .prepare(
        `SELECT 1 FROM note_entries n JOIN note_agent_runs r ON r.entry_id=n.id
      WHERE n.id=? AND n.from_owner=1 AND n.text=? AND r.revision=? AND r.attempts=? AND r.state='running'
      AND NOT EXISTS(SELECT 1 FROM note_agent_runs newer WHERE newer.entry_id=n.id AND newer.revision>r.revision)`,
      )
      .get(input.noteId, input.text, input.revision, input.attempt);
    if (!eligible) return false;
    db.prepare(
      `INSERT OR IGNORE INTO note_agent_handoffs(entry_id,revision,conversation_id,payload_json) VALUES(?,?,?,?)`,
    ).run(input.noteId, input.revision, input.conversationId, JSON.stringify(input));
    return !!db
      .prepare(
        "SELECT 1 FROM note_agent_handoffs WHERE entry_id=? AND revision=? AND state IN ('pending','publishing')",
      )
      .get(input.noteId, input.revision);
  })();
}
export function claimNoteHandoff(db: Database.Database, now: number): NoteHandoff | null {
  return db.transaction(() => {
    db.prepare(
      `UPDATE note_agent_handoffs SET state='canceled',payload_json=json_object('changes',json_extract(payload_json,'$.changes')) WHERE state IN ('pending','publishing') AND state='pending' AND NOT EXISTS(
      SELECT 1 FROM note_entries n JOIN note_agent_runs r ON r.entry_id=n.id
      WHERE n.id=note_agent_handoffs.entry_id AND n.from_owner=1 AND r.revision=note_agent_handoffs.revision
      AND n.text=r.input_text AND NOT EXISTS(SELECT 1 FROM note_agent_runs newer WHERE newer.entry_id=n.id AND newer.revision>r.revision))`,
    ).run();
    db.prepare(
      `UPDATE note_agent_runs SET state='done',baseline=1,receipt_json=(SELECT json_object('text','The continuation chat is no longer available. Review any work already applied.','changes',json_extract(h.payload_json,'$.changes')) FROM note_agent_handoffs h WHERE h.entry_id=note_agent_runs.entry_id AND h.revision=note_agent_runs.revision) WHERE state='running' AND EXISTS(SELECT 1 FROM note_agent_handoffs h WHERE h.entry_id=note_agent_runs.entry_id AND h.revision=note_agent_runs.revision AND h.state='canceled')`,
    ).run();
    const row = db
      .prepare<
        [],
        {
          entry_id: string;
          revision: number;
          payload_json: string;
          state: string;
          conversation_id: string;
        }
      >(
        "SELECT entry_id,revision,payload_json,state,conversation_id FROM note_agent_handoffs WHERE state IN ('pending','publishing') ORDER BY rowid LIMIT 1",
      )
      .get();
    if (!row) return null;
    if (row.state === "pending") recordAgentMessage(db, row.conversation_id, now);
    db.prepare(
      "UPDATE note_agent_handoffs SET state='publishing' WHERE entry_id=? AND revision=?",
    ).run(row.entry_id, row.revision);
    return JSON.parse(row.payload_json) as NoteHandoff;
  })();
}
export function completeNoteHandoff(db: Database.Database, input: NoteHandoff, now: number): void {
  db.transaction(() => {
    const changed = db
      .prepare(
        "UPDATE note_agent_handoffs SET state='ready',payload_json=json_object('changes',json_extract(payload_json,'$.changes')) WHERE conversation_id=? AND state='publishing'",
      )
      .run(input.conversationId).changes;
    if (!changed) return;
    const receipt: NoteAgentReceipt = {
      text: input.requiresReview
        ? "An earlier action may have applied or may still be running. Continue in chat to review it and clarify the remaining work."
        : "Continue in chat to clarify the remaining work.",
      changes: input.changes,
      conversationId: input.conversationId,
    };
    db.prepare(
      "UPDATE note_agent_runs SET state='done',baseline=1,receipt_json=?,error=NULL,updated_at=? WHERE entry_id=? AND revision=? AND attempts=?",
    ).run(JSON.stringify(receipt), now, input.noteId, input.revision, input.attempt);
  })();
}
export function cancelNoteHandoff(db: Database.Database, conversationId: string): void {
  db.transaction(() => {
    const row = db
      .prepare<[string], { entry_id: string; revision: number }>(
        "SELECT entry_id,revision FROM note_agent_handoffs WHERE conversation_id=?",
      )
      .get(conversationId);
    if (!row) return;
    db.prepare(
      "UPDATE note_agent_handoffs SET state='canceled',payload_json=json_object('changes',json_extract(payload_json,'$.changes')) WHERE conversation_id=?",
    ).run(conversationId);
    db.prepare(
      "UPDATE note_agent_runs SET receipt_json=json_set(json_remove(receipt_json,'$.conversationId'),'$.text','The continuation chat was deleted. Completed work is preserved.') WHERE entry_id=? AND revision=? AND json_extract(receipt_json,'$.conversationId')=?",
    ).run(row.entry_id, row.revision, conversationId);
    db.prepare("DELETE FROM notifications WHERE kind='conversation' AND target_id=?").run(
      conversationId,
    );
    db.prepare("DELETE FROM conversation_read_state WHERE conversation_id=?").run(conversationId);
  })();
}

export function pendingNoteHandoff(
  db: Database.Database,
  noteId: string,
  revision: number,
): boolean {
  return !!db
    .prepare(
      "SELECT 1 FROM note_agent_handoffs WHERE entry_id=? AND revision=? AND state IN ('pending','publishing')",
    )
    .get(noteId, revision);
}
