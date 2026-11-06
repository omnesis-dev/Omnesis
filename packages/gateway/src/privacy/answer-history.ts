// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  createAnswerScopeReadObserver,
  answerTaskScopeReads,
  answerTaskRequiresScopeProof,
  scopeChanged,
  type AnswerScopeReadSet,
} from "./answer-scope.js";
import { AnswerStoreError, type PrivacyDb } from "./store-types.js";
import type { AnswerHistoryReads } from "./context-reads.js";

export const ANSWER_HISTORY_PAGE_ROWS = 80;
export const ANSWER_HISTORY_PAGE_PROOFS = 16;
const PAGE_WORK_MS = 10;
export const SCOPE_HISTORY_PAGE_SQL = `SELECT m.id,m.task_id,m.role,m.content,CASE WHEN m.role='assistant' THEN r.citations_json END AS citations_json
  FROM answer_messages m LEFT JOIN answer_releases r ON r.task_id=m.task_id
  WHERE m.conversation_id=? AND m.id<=? ORDER BY m.id DESC LIMIT ${ANSWER_HISTORY_PAGE_ROWS}`;
export interface ScopedHistoryMessage {
  id: number;
  task_id: string;
  role: "user" | "assistant";
  content: string;
  citations_json: string | null;
}
export interface ScopedAnswerHistory {
  messages: ScopedHistoryMessage[];
  reads: AnswerScopeReadSet;
  withheld: boolean;
  taskIds: string[];
}
export interface ScopeHistoryPageRequest {
  taskId: string;
  conversationId: string;
  ownerId: string;
  limit: number;
  highWater?: number;
  cursor?: number;
}
export type ScopeHistoryPage =
  | { kind: "unfiltered" }
  | { kind: "error"; code: "conversation_not_found" | "owner_mismatch" | "authority_changed" }
  | {
      kind: "page";
      highWater: number;
      cursor: number;
      exhausted: boolean;
      examined: number;
      proofs: number;
      history: ScopedAnswerHistory;
    };

/** One independently consistent, bounded worker snapshot; no model sees intermediate pages. */
export function readScopeHistoryPage(
  db: PrivacyDb,
  request: ScopeHistoryPageRequest,
): ScopeHistoryPage {
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    (request.cursor !== undefined &&
      (!Number.isSafeInteger(request.cursor) || request.cursor < 0)) ||
    (request.highWater !== undefined &&
      (!Number.isSafeInteger(request.highWater) || request.highWater < 0))
  )
    throw new Error("Invalid Answer history continuation.");
  return db.transaction((): ScopeHistoryPage => {
    const conversation = db
      .prepare<[string], { owner_id: string }>(
        "SELECT owner_id FROM answer_conversations WHERE id=?",
      )
      .get(request.conversationId);
    if (!conversation) return { kind: "error", code: "conversation_not_found" };
    const task = db
      .prepare<[string, string], { owner_id: string }>(
        "SELECT owner_id FROM answer_tasks WHERE id=? AND conversation_id=?",
      )
      .get(request.taskId, request.conversationId);
    if (conversation.owner_id !== request.ownerId || task?.owner_id !== request.ownerId)
      return { kind: "error", code: "owner_mismatch" };
    if (!db.prepare("SELECT 1 FROM answer_task_scope WHERE task_id=?").get(request.taskId))
      return answerTaskRequiresScopeProof(db, request.taskId)
        ? { kind: "error", code: "authority_changed" }
        : { kind: "unfiltered" };
    const highWater =
      request.highWater ??
      db
        .prepare<[string], { id: number }>(
          "SELECT coalesce(max(id),0) AS id FROM answer_messages WHERE conversation_id=?",
        )
        .get(request.conversationId)!.id;
    // Bind the continuation itself as the index range, never as a residual OR
    // predicate that could repeatedly scan an already-withheld prefix.
    const upper =
      request.cursor === undefined ? highWater : Math.min(highWater, request.cursor - 1);
    const rows = db
      .prepare<[string, number], ScopedHistoryMessage>(SCOPE_HISTORY_PAGE_SQL)
      .all(request.conversationId, upper);
    const observer = createAnswerScopeReadObserver();
    observer.markComplete();
    const proofs = new Map<string, AnswerScopeReadSet | null>();
    const messages: ScopedHistoryMessage[] = [];
    let withheld = false,
      examined = 0,
      cursor = request.cursor ?? highWater + 1;
    const started = performance.now();
    for (const row of rows) {
      if (messages.length >= request.limit) break;
      let proof = proofs.get(row.task_id);
      if (proof === undefined) {
        if (
          proofs.size &&
          (proofs.size >= ANSWER_HISTORY_PAGE_PROOFS || performance.now() - started >= PAGE_WORK_MS)
        )
          break;
        try {
          proof = answerTaskScopeReads(db, row.task_id);
        } catch (error) {
          if (!(error instanceof AnswerStoreError) || error.code !== "authority_changed")
            throw error;
          proof = null;
        }
        proofs.set(row.task_id, proof);
      }
      cursor = row.id;
      examined++;
      if (!proof) {
        withheld = true;
        continue;
      }
      observer.inherit(proof);
      messages.push(row);
    }
    return {
      kind: "page",
      highWater,
      cursor,
      examined,
      proofs: proofs.size,
      exhausted: examined === rows.length && rows.length < ANSWER_HISTORY_PAGE_ROWS,
      history: {
        messages,
        reads: observer.snapshot(),
        withheld,
        taskIds: [...new Set(messages.map((row) => row.task_id))],
      },
    };
  })();
}

/** Eligible turns precede the context limit; continuation awaits keep work off the main reader. */
export async function scopedAnswerHistory(
  db: PrivacyDb,
  taskId: string,
  conversationId: string,
  ownerId: string,
  limit: number,
  options: {
    reads?: Pick<AnswerHistoryReads, "scopeHistoryPage">;
    signal?: AbortSignal;
    includeTaskIds?: boolean;
  } = {},
): Promise<ScopedAnswerHistory | null> {
  const observer = createAnswerScopeReadObserver();
  observer.markComplete();
  const messages: ScopedHistoryMessage[] = [];
  const taskIds = new Set<string>();
  let cursor: number | undefined,
    highWater: number | undefined,
    withheld = false;
  while (messages.length < limit) {
    options.signal?.throwIfAborted();
    const request = {
      taskId,
      conversationId,
      ownerId,
      limit: limit - messages.length,
      highWater,
      cursor,
    };
    const page = options.reads
      ? await options.reads.scopeHistoryPage(request)
      : readScopeHistoryPage(db, request);
    if (page.kind === "unfiltered") return null;
    if (page.kind === "error") {
      if (page.code === "authority_changed") throw scopeChanged();
      throw new AnswerStoreError(page.code, "Answer conversation is unavailable.");
    }
    observer.inherit(page.history.reads);
    messages.push(...page.history.messages);
    if (options.includeTaskIds !== false) for (const id of page.history.taskIds) taskIds.add(id);
    withheld ||= page.history.withheld;
    if (page.exhausted || messages.length >= limit) break;
    if (!page.examined || page.cursor === cursor)
      throw new Error("Answer history continuation did not advance.");
    cursor = page.cursor;
    highWater = page.highWater;
    await yieldToEventLoop();
  }
  const chronological: ScopedHistoryMessage[] = [];
  for (let end = messages.length; end > 0; end -= ANSWER_HISTORY_PAGE_ROWS) {
    chronological.push(
      ...messages.slice(Math.max(0, end - ANSWER_HISTORY_PAGE_ROWS), end).reverse(),
    );
    if (end > ANSWER_HISTORY_PAGE_ROWS) await yieldToEventLoop();
  }
  return {
    messages: chronological,
    reads: observer.snapshot(),
    withheld,
    taskIds: [...taskIds],
  };
}
