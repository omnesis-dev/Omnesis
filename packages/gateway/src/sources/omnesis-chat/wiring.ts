// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-boot wiring for the omnesis-chat source. Owns the side-effects:
 *   - Seeds the source's display identity (`sync_state.icon/label/…`).
 *   - Builds a `ConversationUpserter` bound to the live writeGate + read
 *     handle and exposes the `onTurnEnd` / `onSessionClose` hooks the
 *     AgentService subscribes to.
 *   - Schedules the one-shot backfill of pre-existing JSON transcripts.
 *
 * The boot caller hands in everything from outside (writeGate, db
 * handle, conversations dir, JSON-loader fn). This module owns no
 * shared globals — every dependency is explicit so tests can swap any
 * piece in isolation.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "@omnesis/core";
import { runConversationBackfill, BACKFILL_FLAG_KEY } from "./backfill.js";
import { ConversationUpserter, type ConversationUpserterDeps } from "./upsert.js";
import { findConversationDocId } from "./citation-writer.js";
import { seedOmnesisChatSourceMeta, OMNESIS_CHAT_SOURCE_ID } from "./source-meta.js";
import {
  ensureConversationMemoryEvidence,
  type ConversationMemoryEvidence,
} from "./memory-evidence.js";
import type Database from "better-sqlite3";

import type { ConversationRecord } from "../../agent/conversation-store.js";
import type { WriteGate } from "../../write-gate.js";
import type { IndexWriteGate } from "../../indexer/index-write-gate.js";

const log = createLogger("gateway:omnesis-chat");

export interface OmnesisChatBootDeps {
  writeGate: WriteGate;
  /**
   * Companion gate for `index.db`. When a conversation document is
   * deleted, its `chunks` / `indexed_documents` rows in `index.db` must
   * be removed too — `omnesis.db` and `index.db` are separate SQLite
   * files so the cascade can't be a pure foreign-key trigger. Optional:
   * when absent, the index-side rows linger and the conversation
   * continues to surface in search results.
   */
  indexWriteGate?: IndexWriteGate;
  retentionIndexDeleteBatch?: (
    documentId: string,
    limit: number,
    sourceDeleted: boolean,
  ) => Promise<{
    deletedChunks: number;
    complete: boolean;
    readyForSourceDelete: boolean;
  }>;
  /** Read-side SQLite handle. Used for the post-upsert doc-id lookup. */
  readDb: Database.Database;
  /** Absolute path to <configDir>/conversations/. */
  conversationsDir: string;
  /** Loader the upserter uses on flush — reads the freshest transcript. */
  loadConversation: (id: string) => Promise<ConversationRecord | null>;
  /** Optional override of the debounce window. Tests pass 0. */
  debounceMs?: number;
  /** Optional scheduler override for unit tests with fake timers. */
  scheduler?: ConversationUpserterDeps["scheduler"];
}

export interface OmnesisChatRuntime {
  ensureConversationEvidence: (sessionId: string) => Promise<ConversationMemoryEvidence | null>;
  upserter: ConversationUpserter;
  /** Hook the AgentService calls on `agent.message.end`. */
  onTurnEnd: (sessionId: string) => void;
  /** Hook the AgentService calls on session close / cancellation. */
  onSessionClose: (sessionId: string) => Promise<void>;
  /**
   * Cascade for `DELETE /agent/conversations/:id` — drops the
   * gateway-side document so the corpus stays in sync with the
   * deleted JSON file. Returns the docId that was deleted, or null
   * when there was nothing to delete.
   */
  onConversationDeleted: (sessionId: string) => Promise<string | null>;
  /** Bounded retention cascade; false asks the scheduler to resume next tick. */
  onConversationRetained: (sessionId: string) => Promise<boolean>;
  /**
   * Flush every pending debounce timer and await every in-flight
   * upsert. Call before `dispose()` so a turn that finished within the
   * debounce window before SIGTERM still lands as a corpus document.
   */
  flushAll: () => Promise<void>;
  /** Tear-down on gateway shutdown. Drops timers; does NOT flush. */
  dispose: () => void;
}

export interface OmnesisChatRetentionDeps {
  writeGate: WriteGate;
  indexWriteGate?: Pick<IndexWriteGate, "deleteChunksByDocumentBatch">;
  retentionIndexDeleteBatch?: OmnesisChatBootDeps["retentionIndexDeleteBatch"];
  readDb: Database.Database;
}

/** Recover document ids left behind by a crash during the retention cascade. */
export function listInterruptedOmnesisChatRetentionDocumentIds(
  readDb: Database.Database,
): string[] {
  return readDb
    .prepare<[string], { original_document_id: string }>(
      `SELECT original_document_id
         FROM removed_documents
        WHERE provider_id = 'system'
          AND source_id = ?
          AND original_document_id IS NOT NULL
        ORDER BY removed_at, external_id`,
    )
    .all(OMNESIS_CHAT_SOURCE_ID)
    .map((row) => row.original_document_id);
}

export async function retainOmnesisChatConversation(
  deps: OmnesisChatRetentionDeps,
  sessionId: string,
): Promise<boolean> {
  const activeDocumentId = findConversationDocId(
    deps.readDb,
    "system",
    OMNESIS_CHAT_SOURCE_ID,
    sessionId,
  );
  const retainedDocumentId =
    activeDocumentId ??
    deps.readDb
      .prepare<[string, string, string], { original_document_id: string | null }>(
        `SELECT original_document_id
           FROM removed_documents
          WHERE provider_id = ? AND source_id = ? AND external_id = ?`,
      )
      .get("system", OMNESIS_CHAT_SOURCE_ID, sessionId)?.original_document_id ??
    null;
  const sourceDeleted = activeDocumentId === null;
  if (retainedDocumentId) {
    const deleteBatch =
      deps.retentionIndexDeleteBatch ??
      (deps.indexWriteGate
        ? (id: string, limit: number, sourceDeleted: boolean) =>
            deps.indexWriteGate!.deleteChunksByDocumentBatch(id, limit, sourceDeleted)
        : undefined);
    if (deleteBatch) {
      const indexResult = await deleteBatch(retainedDocumentId, 64, sourceDeleted);
      if (indexResult.readyForSourceDelete) {
        await deps.writeGate.deleteDocumentForRetention(
          "system",
          OMNESIS_CHAT_SOURCE_ID,
          sessionId,
        );
        const finalResult = await deleteBatch(retainedDocumentId, 64, true);
        if (!finalResult.complete) return false;
        await deps.writeGate.completeDocumentRetention("system", OMNESIS_CHAT_SOURCE_ID, sessionId);
        return true;
      }
      if (!indexResult.complete) return false;
      await deps.writeGate.completeDocumentRetention("system", OMNESIS_CHAT_SOURCE_ID, sessionId);
      return true;
    }
  }
  if (!sourceDeleted) {
    await deps.writeGate.deleteDocumentForRetention("system", OMNESIS_CHAT_SOURCE_ID, sessionId);
    return false;
  }
  await deps.writeGate.completeDocumentRetention("system", OMNESIS_CHAT_SOURCE_ID, sessionId);
  return true;
}

/** Shared corpus/index cascade for interactive and retention deletions. */
export async function deleteOmnesisChatConversation(
  deps: Pick<
    OmnesisChatBootDeps,
    "writeGate" | "indexWriteGate" | "retentionIndexDeleteBatch" | "readDb"
  > & {
    cancelPending?: (() => Promise<void>) | undefined;
  },
  sessionId: string,
): Promise<string | null> {
  await deps.cancelPending?.();
  // index.db and omnesis.db cannot share a transaction. Remove the derived
  // chunks first: it is idempotent, and a failure leaves the authoritative
  // document + transcript intact so retention can retry. Reversing this order
  // would strand searchable chunks once the document row had been committed
  // away.
  const documentId = findConversationDocId(
    deps.readDb,
    "system",
    OMNESIS_CHAT_SOURCE_ID,
    sessionId,
  );
  if (documentId && deps.retentionIndexDeleteBatch) {
    const prepared = await deps.retentionIndexDeleteBatch(documentId, 64, false);
    if (!prepared.readyForSourceDelete) {
      throw new Error("conversation index cleanup is incomplete; retry deletion");
    }
    const deletedIds = await deps.writeGate.deleteDocuments("system", OMNESIS_CHAT_SOURCE_ID, [
      sessionId,
    ]);
    // Persist the source-deleted obligation before the transcript disappears.
    // A false completion only means an in-flight index job must settle; the
    // worker-owned durable queue is now sufficient to finish after success or
    // restart.
    await deps.retentionIndexDeleteBatch(documentId, 64, true);
    return deletedIds[0] ?? documentId;
  }
  if (documentId && deps.indexWriteGate) {
    await deps.indexWriteGate.deleteChunksByDocuments([documentId]);
  }
  const deletedIds = await deps.writeGate.deleteDocuments("system", OMNESIS_CHAT_SOURCE_ID, [
    sessionId,
  ]);
  return deletedIds[0] ?? documentId;
}

/**
 * Set everything up. Returns the runtime handles the gateway needs to
 * keep alive. The boot caller is responsible for:
 *   - Subscribing `onTurnEnd` / `onSessionClose` to the AgentService
 *     event surface (typically: pass an `onTurnComplete` callback to
 *     `AgentServiceDeps`).
 *   - Routing `DELETE /agent/conversations/:id` through
 *     `onConversationDeleted` after the transcript file is removed.
 *   - Calling `dispose()` on SIGTERM.
 */
export async function bootOmnesisChat(deps: OmnesisChatBootDeps): Promise<OmnesisChatRuntime> {
  await seedOmnesisChatSourceMeta(deps.writeGate);

  const lookupDocId = (providerId: string, sourceId: string, externalId: string) =>
    findConversationDocId(deps.readDb, providerId, sourceId, externalId);

  const upserter = new ConversationUpserter({
    writeGate: deps.writeGate,
    lookupDocId,
    debounceMs: deps.debounceMs,
    scheduler: deps.scheduler,
  });

  // Backfill runs in the background — don't block boot on it. The flag
  // persists across restarts, so a crash mid-backfill resumes cleanly.
  void runConversationBackfill({
    conversationsDir: deps.conversationsDir,
    writeGate: deps.writeGate,
    hasFlag: () => hasBackfillFlag(deps.conversationsDir),
    setFlag: () => writeBackfillFlag(deps.conversationsDir),
    lookupDocId,
  }).catch((err) => log.warn(`backfill threw: ${(err as Error).message ?? err}`));

  return {
    upserter,
    ensureConversationEvidence: (sessionId) =>
      ensureConversationMemoryEvidence({ ...deps, upserter }, sessionId),
    onTurnEnd: (sessionId) => upserter.enqueue(sessionId, () => deps.loadConversation(sessionId)),
    onSessionClose: (sessionId) => upserter.flush(sessionId),
    onConversationDeleted: (sessionId) => {
      // Drop only this session's pending timer so we don't recreate the
      // doc after deletion — leave other sessions' timers in place.
      // Awaits any in-flight runUpsert so a fired-but-running timer
      // can't resurrect the doc after the DELETE commits.
      return deleteOmnesisChatConversation(
        {
          writeGate: deps.writeGate,
          indexWriteGate: deps.indexWriteGate,
          retentionIndexDeleteBatch: deps.retentionIndexDeleteBatch,
          readDb: deps.readDb,
          cancelPending: () => upserter.cancelPending(sessionId),
        },
        sessionId,
      );
    },
    onConversationRetained: async (sessionId) => {
      await upserter.cancelPending(sessionId);
      return retainOmnesisChatConversation(deps, sessionId);
    },
    flushAll: () => upserter.flushAll(),
    dispose: () => upserter.dispose(),
  };
}

/**
 * Flag persistence. Stored as a sentinel file in the SAME directory as
 * the transcripts because we already manage that directory and don't
 * want a stray flag file in the parent config dir. The filename
 * starts with `.` so a casual `ls` doesn't surface it next to the
 * transcripts.
 */
function flagPath(conversationsDir: string): string {
  return join(conversationsDir, `.${BACKFILL_FLAG_KEY}`);
}

function hasBackfillFlag(conversationsDir: string): boolean {
  return existsSync(flagPath(conversationsDir));
}

function writeBackfillFlag(conversationsDir: string): void {
  // Best-effort: a failure here just means the next boot re-runs the
  // backfill (upsertDocuments is keyed on (provider, source, externalId)
  // so re-running is idempotent). Crashing boot over a sentinel-file
  // write would be worse than the duplicate work.
  try {
    mkdirSync(conversationsDir, { recursive: true });
    writeFileSync(flagPath(conversationsDir), new Date().toISOString(), "utf8");
  } catch (err) {
    log.warn(
      `failed to write backfill flag at ${flagPath(conversationsDir)}: ${
        (err as Error).message ?? err
      } — next boot will redo the backfill`,
    );
  }
}
