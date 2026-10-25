// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Conversation upserter. Builds a `DocumentInput` from a
 * `ConversationRecord` and writes it through the gateway's WriteGate,
 * then attaches citation edges via `upsertConversationCitations`.
 *
 * Per-session debouncing lets a fast back-and-forth conversation
 * coalesce many `enqueue` calls into one upsert at the end of an idle
 * window (default 30s). `flush(id)` runs the pending upsert now.
 * `cancelPending(id)` drops a pending timer AND awaits any
 * already-started run so a follow-up delete can rely on no resurrection.
 * `flushAll()` is the shutdown entry point. The timer/serialization
 * machinery lives in the shared `KeyedDebouncedRunner` (key = session
 * id); this class owns the loader bookkeeping and the write itself.
 *
 * Inside `runUpsert`: load the freshest transcript, render dialogue-only
 * markdown, source-owned authority and harvested citations, then publish them
 * atomically through the writer. Runs per
 * session are serialized by the runner so concurrent enqueues / flushes
 * never produce two concurrent writes targeting the same conversation.
 */

import { createHash } from "node:crypto";

import { conversationEvidenceProjection } from "./evidence-projection.js";
import { createLogger } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput, type PersonMention } from "@omnesis/types";

import { KeyedDebouncedRunner } from "../../keyed-debounced-runner.js";
import { renderConversation, type RenderedCitation } from "./render.js";
import { findConversationDocId, type ConversationCitationInput } from "./citation-writer.js";
import { OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID } from "./source-meta.js";
import type { WriteGate } from "../../write-gate.js";
import type { ConversationRecord } from "../../agent/conversation-store.js";

const log = createLogger("gateway:omnesis-chat").child("upsert");

/** Default per-session debounce window. */
export const DEFAULT_DEBOUNCE_MS = 30_000;

export interface ConversationUpserterDeps {
  writeGate: WriteGate;
  /** Override the debounce window. Tests pass 0 for synchronous flushes. */
  debounceMs?: number;
  /** Pluggable timer for unit tests. */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export class ConversationUpserter {
  private readonly writeGate: WriteGate;
  /** Debounce + per-key serialization machinery. */
  private readonly runner: KeyedDebouncedRunner;
  /**
   * Latest loader per session. The runner's `run` callback looks it up
   * at fire time, so the eventual write always sees the freshest
   * transcript regardless of how many enqueues coalesced.
   */
  private readonly loaders = new Map<string, () => Promise<ConversationRecord | null>>();

  constructor(deps: ConversationUpserterDeps) {
    this.writeGate = deps.writeGate;
    this.runner = new KeyedDebouncedRunner({
      debounceMs: deps.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      scheduler: deps.scheduler,
      run: (sessionId) => {
        const loader = this.loaders.get(sessionId);
        this.loaders.delete(sessionId);
        // No loader means an earlier run for the same session already
        // consumed the freshest one — nothing newer to write.
        return loader ? this.runUpsert(sessionId, loader) : Promise.resolve();
      },
      onError: (sessionId, err) => {
        log.warn(`upsert failed for ${sessionId}: ${(err as Error).message ?? err}`);
      },
    });
  }

  /**
   * Schedule an upsert for `sessionId` to run after the debounce
   * window. Subsequent enqueues for the same session cancel the prior
   * timer and install a new one. The loader is invoked when the timer
   * fires so the eventual write always sees the freshest transcript.
   */
  enqueue(sessionId: string, loader: () => Promise<ConversationRecord | null>): void {
    this.loaders.set(sessionId, loader);
    this.runner.enqueue(sessionId);
  }

  /**
   * Run the pending upsert for `sessionId` now and await its writes.
   * Idempotent — no pending timer means no-op (but any in-flight run
   * still gets awaited so callers can rely on quiescence on return).
   */
  flush(sessionId: string): Promise<void> {
    return this.runner.flush(sessionId);
  }

  /**
   * Drop the pending timer for one session without running the upsert
   * AND await any already-started run. After this resolves, no further
   * writes will be issued for `sessionId` until a new `enqueue` arrives.
   * Caller relies on that quiescence to delete the row downstream.
   */
  cancelPending(sessionId: string): Promise<void> {
    return this.runner.cancelPending(sessionId);
  }

  /**
   * Flush every pending session and await every in-flight run.
   * Shutdown hook — call this before `dispose()` so a turn that
   * finished within the debounce window before SIGTERM still lands as
   * a corpus document.
   */
  flushAll(): Promise<void> {
    return this.runner.flushAll();
  }

  /**
   * Cancel every pending timer and refuse further enqueues. Does NOT
   * await in-flight runs — pair with `flushAll()` before this when
   * graceful shutdown matters.
   */
  dispose(): void {
    this.runner.dispose();
    this.loaders.clear();
  }

  /** Visible for tests. */
  pendingCount(): number {
    return this.runner.pendingCount();
  }

  /** Visible for tests. */
  inflightCount(): number {
    return this.runner.inflightCount();
  }

  private async runUpsert(
    sessionId: string,
    loader: () => Promise<ConversationRecord | null>,
  ): Promise<void> {
    const record = await loader();
    if (!record) return; // deleted between enqueue and run
    const doc = buildDocumentInput(record);
    const rendered = renderConversation(record);
    await this.writeGate.upsertConversationDocument(
      doc,
      conversationEvidenceProjection(rendered),
      renderedCitationsToInputs(rendered.citations),
    );
  }
}

/**
 * Build a DocumentInput from a ConversationRecord. Pure projection —
 * deterministic given the same record. Exposed for the backfill task
 * which writes records inline without going through the debouncer.
 */
export function buildDocumentInput(record: ConversationRecord): DocumentInput {
  const { body } = renderConversation(record);
  const contentHash = createHash("sha256").update(body).digest("hex");
  const people: PersonMention[] = [
    // Resolves to the canonical self person at people-resolution time.
    // Silently dropped when no self person exists.
    { name: "You", role: "participant", isSelf: true },
  ];
  return {
    providerId: ProviderId(OMNESIS_CHAT_PROVIDER_ID),
    sourceId: SourceId(OMNESIS_CHAT_SOURCE_ID),
    externalId: record.id,
    title: record.title || "(untitled)",
    content: body,
    contentHash,
    sourceCreatedAt: record.createdAt,
    sourceUpdatedAt: record.updatedAt,
    metadata: {
      documentType: "conversation",
      people,
      extra: {
        backend: record.backend,
        model: record.model,
        messageCount: record.messages.length,
      },
    },
  };
}

export function renderedCitationsToInputs(
  citations: ReadonlyArray<RenderedCitation>,
): ConversationCitationInput[] {
  return citations.map((c): ConversationCitationInput => {
    if (c.kind === "record") {
      return {
        kind: "record",
        table: c.table,
        recordKey: c.recordKey,
        primaryKeyColumns: c.primaryKeyColumns,
        title: c.title,
        keyFields: c.keyFields,
        semanticTime: c.semanticTime,
        snapshot: c.snapshot,
        sourceId: c.sourceId,
        sourceType: c.sourceType,
        tableDisplayName: c.tableDisplayName,
        boundDocumentId: c.boundDocumentId,
      };
    }
    return {
      kind: "document",
      targetDocId: c.documentId,
      quote: c.quote,
      quoteAuthor: c.quoteAuthor,
      note: c.note,
    };
  });
}

// Re-export for the boot wiring to forward.
export { findConversationDocId };
