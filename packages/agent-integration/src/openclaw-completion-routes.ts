// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The channel name a route uses when its destination is a native session
 * rather than a conversation.
 *
 * A firing wake runs as a background subagent with no channel and nobody to
 * post to, so the only place an answer released after it ended can go is a
 * continuation of the run that asked. Carried in the existing `channel` column
 * rather than a new one so a live store needs no migration: this store is
 * private to the plugin and no path has ever written this value, so no
 * existing row can collide. The name is reserved by convention rather than by
 * the channel-id type, which permits a colon — so `put` refuses to file
 * channel addressing under it, and every read dispatches on the kind.
 */
export const SESSION_ROUTE_CHANNEL = "omnesis:session";

/** Whether this route resumes a run rather than replying in a conversation. */
export function isSessionRoute(route: { channel: string }): boolean {
  return route.channel === SESSION_ROUTE_CHANNEL;
}

export interface OpenClawCompletionRoute {
  nativeConversationId: string;
  taskId: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
}

/** Durable mapping from an opaque gateway callback handle to an OpenClaw route. */
export class OpenClawCompletionRoutes {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS openclaw_answer_completion_routes (
        native_conversation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        destination TEXT NOT NULL,
        account_id TEXT,
        thread_id_json TEXT,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_openclaw_answer_completion_routes_task
        ON openclaw_answer_completion_routes(task_id);
    `);
  }

  put(route: OpenClawCompletionRoute): void {
    // A session route's destination is a session key, and a conversation
    // route's is an address on a channel. Filing one under the other's name
    // would send an approved answer somewhere nobody asked from.
    if (
      route.channel === SESSION_ROUTE_CHANNEL &&
      (route.accountId !== undefined || route.threadId !== undefined)
    ) {
      throw new Error("a session completion route carries no channel addressing");
    }
    this.db
      .prepare(
        `INSERT INTO openclaw_answer_completion_routes (
          native_conversation_id, task_id, channel, destination, account_id, thread_id_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(native_conversation_id) DO UPDATE SET
          task_id = excluded.task_id,
          channel = excluded.channel,
          destination = excluded.destination,
          account_id = excluded.account_id,
          thread_id_json = excluded.thread_id_json`,
      )
      .run(
        route.nativeConversationId,
        route.taskId,
        route.channel,
        route.to,
        route.accountId ?? null,
        route.threadId === undefined ? null : JSON.stringify(route.threadId),
        Date.now(),
      );
  }

  get(nativeConversationId: string): OpenClawCompletionRoute | null {
    const row = this.db
      .prepare(
        `SELECT native_conversation_id, task_id, channel, destination, account_id, thread_id_json
         FROM openclaw_answer_completion_routes WHERE native_conversation_id = ?`,
      )
      .get(nativeConversationId) as
      | {
          native_conversation_id: string;
          task_id: string;
          channel: string;
          destination: string;
          account_id: string | null;
          thread_id_json: string | null;
        }
      | undefined;
    if (!row) return null;
    let threadId: string | number | undefined;
    if (row.thread_id_json !== null) {
      try {
        const parsed = JSON.parse(row.thread_id_json) as unknown;
        if (typeof parsed === "string" || typeof parsed === "number") threadId = parsed;
      } catch {
        return null;
      }
    }
    return {
      nativeConversationId: row.native_conversation_id,
      taskId: row.task_id,
      channel: row.channel,
      to: row.destination,
      ...(row.account_id ? { accountId: row.account_id } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
    };
  }

  delete(nativeConversationId: string): void {
    this.db
      .prepare("DELETE FROM openclaw_answer_completion_routes WHERE native_conversation_id = ?")
      .run(nativeConversationId);
  }

  /**
   * Drop routes too old to be needed. A route exists to receive one answer;
   * once the gateway's approval window has passed, the answer it was filed for
   * can no longer arrive, so the row is unreachable rather than merely idle.
   * Without this, every ask that fails after filing its route — a lost
   * connection, a rejected request, an answer abandoned at the deadline —
   * leaves a row that nothing will ever collect.
   */
  prune(olderThanMs: number, now: number = Date.now()): number {
    const result = this.db
      .prepare("DELETE FROM openclaw_answer_completion_routes WHERE created_at < ?")
      .run(now - olderThanMs);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}
