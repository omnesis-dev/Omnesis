// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The interest engine: the one place that writes the owner's reactions to the
 * ledger, keeps their vectors current, and answers "what did the owner do
 * about things like this?" for the decision gates.
 *
 * Writes go through the writer; the gates read through the main-thread
 * handle. A new signal lands without a vector, and the embedding backlog
 * fills it in afterwards, one `embedQuery` at a time, so a reaction is never
 * held on the embedder. A lookup decodes the live ledger once and keeps it
 * until a cheap fingerprint says it changed, so a planner tick asking about
 * many documents in a row does not re-read the table for each. The lookup
 * fails open: any error, a missing embedder or an empty ledger all answer
 * null, and the gate asks its question as it always has.
 */

import {
  countUnembeddedInterestSignals,
  hasInterestEmbeddingsNotFrom,
  interestLedgerFingerprint,
  listLiveInterestSignals,
  listUnembeddedInterestSignals,
  type InterestKind,
  type InterestPolarity,
  type InterestSignal,
  type InterestSource,
  type InterestSupersedeScope,
  type NewInterestSignal,
} from "../storage/interest.js";
import {
  DEFAULT_LOOKUP_OPTIONS,
  lookupOwnerInterest,
  type InterestLookupOptions,
  type OwnerInterest,
} from "./lookup.js";
import type { Logger } from "@omnesis/core";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

/**
 * The main-thread embedder, when one is assigned and loaded. `modelId` names
 * the model that answers `embedQuery` right now, which during a graceful
 * model swap is still the outgoing one; vectors are labelled with it so two
 * models' vectors are never compared.
 */
export interface InterestEmbedder {
  modelId: string;
  embedQuery(text: string): Promise<ArrayLike<number>>;
}

export interface InterestEngineDeps {
  db: Database.Database;
  writeGate: Pick<
    WriteGate,
    | "recordInterestSignal"
    | "supersedeInterestSignals"
    | "setInterestSignalEmbedding"
    | "resetInterestEmbeddingsNotFrom"
  >;
  /** Resolved per call; null while the indexer loads or when no embedder is assigned. */
  getEmbedder: () => InterestEmbedder | null;
  /** Whether the ledger records and is shown: experimental mode and `brain.interest.enabled`, read live. */
  enabled: () => boolean;
  /** The lookup's floors and example count (`brain.interest.lookup`), read live. */
  lookupOptions?: () => Partial<InterestLookupOptions>;
  clock: () => number;
  idGen: () => string;
  log: Logger;
}

export interface RecordInterestInput {
  polarity: InterestPolarity;
  kind: InterestKind;
  source: InterestSource;
  subjectText: string;
  note?: string | null;
  loopId?: string;
  observationId?: string;
  conversationId?: string;
  /**
   * Supersede the live signals this one replaces first. Applied even while
   * the ledger is off: a reaction the owner took back must not come back
   * when the ledger is switched on again.
   */
  replaces?: InterestSupersedeScope;
}

/** Signals kept for lookup: newest first, bounded so a lookup stays a few milliseconds. */
const LOOKUP_SIGNAL_LIMIT = 2_000;
/** Signals embedded per backlog page; a pass pages on while any remain. */
const EMBED_BATCH = 16;
const EMBED_TIMEOUT_MS = 30_000;
/**
 * How long a lookup waits for its query vector. A gate is waiting on the
 * answer, so an embedder that is slow or stalled gives way to matching by
 * shared words.
 */
const QUERY_EMBED_TIMEOUT_MS = 10_000;

export class InterestEngine {
  private draining: Promise<void> | null = null;
  private pendingDrain = false;
  private readonly queryVectors = new Map<string, { values: Float32Array; model: string }>();
  /** The decoded live ledger, valid while its fingerprint matches the table. */
  private ledger: { fingerprint: string; signals: InterestSignal[] } | null = null;

  constructor(private readonly deps: InterestEngineDeps) {}

  enabled(): boolean {
    return this.deps.enabled();
  }

  /** Record one reaction. Nothing new is written while the ledger is off. */
  async record(input: RecordInterestInput): Promise<InterestSignal | null> {
    const signal = this.draft(input);
    if (!signal) {
      if (input.replaces)
        await this.deps.writeGate.supersedeInterestSignals(input.replaces, this.deps.clock());
      return null;
    }
    const stored = await this.deps.writeGate.recordInterestSignal(signal, input.replaces ?? null);
    this.kick();
    return stored;
  }

  /**
   * A signal row without a vector, for a caller that lands it in a transaction
   * of its own; null while the ledger is off.
   */
  draft(input: Omit<RecordInterestInput, "replaces">): NewInterestSignal | null {
    if (!this.enabled()) return null;
    return {
      id: `int_${this.deps.idGen()}`,
      polarity: input.polarity,
      kind: input.kind,
      source: input.source,
      subjectText: input.subjectText,
      note: input.note ?? null,
      loopId: input.loopId ?? null,
      observationId: input.observationId ?? null,
      conversationId: input.conversationId ?? null,
      ledgerSeq: null,
      createdAt: this.deps.clock(),
    };
  }

  /** Take back the live signals a scope names. */
  async supersede(by: InterestSupersedeScope): Promise<number> {
    return this.deps.writeGate.supersedeInterestSignals(by, this.deps.clock());
  }

  /**
   * The owner's past reactions that resemble `query.text`, or null when there
   * are none worth showing. Never throws.
   */
  async lookup(query: { text: string }): Promise<OwnerInterest | null> {
    if (!this.enabled()) return null;
    try {
      const signals = this.liveSignals();
      if (signals.length === 0) return null;
      const embedder = this.deps.getEmbedder();
      const comparable =
        embedder !== null && signals.some((s) => s.embeddingModel === embedder.modelId);
      const vector = comparable ? await this.queryVectorOrWords(query.text) : null;
      return lookupOwnerInterest(signals, { text: query.text, vector }, this.deps.clock(), {
        ...DEFAULT_LOOKUP_OPTIONS,
        ...this.deps.lookupOptions?.(),
      });
    } catch (error) {
      this.deps.log.warn(
        `Interest lookup failed; deciding without it: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Whether any live signal is due a try at a vector. */
  hasBacklog(): boolean {
    return this.enabled() && countUnembeddedInterestSignals(this.deps.db, this.deps.clock()) > 0;
  }

  /**
   * Embed the signals that have no vector yet. One pass at a time; a kick
   * during a pass runs another after it, and the returned promise covers both.
   * Resolves when nothing is due, or the embedder is absent.
   */
  embedBacklog(): Promise<void> {
    if (this.draining) {
      this.pendingDrain = true;
      return this.draining;
    }
    this.draining = (async () => {
      do {
        this.pendingDrain = false;
        await this.drain();
      } while (this.pendingDrain);
    })().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  /** Start a backlog pass without waiting for it. */
  kick(): void {
    void this.embedBacklog().catch((error: unknown) => {
      this.deps.log.warn(
        `Interest embedding pass failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private liveSignals(): InterestSignal[] {
    const fingerprint = interestLedgerFingerprint(this.deps.db);
    if (this.ledger?.fingerprint !== fingerprint)
      this.ledger = {
        fingerprint,
        signals: listLiveInterestSignals(this.deps.db, { limit: LOOKUP_SIGNAL_LIMIT }),
      };
    return this.ledger.signals;
  }

  private async drain(): Promise<void> {
    if (!this.enabled()) return;
    const embedder = this.deps.getEmbedder();
    if (!embedder) return;
    // A vector from another embedder is not comparable with the live one.
    if (hasInterestEmbeddingsNotFrom(this.deps.db, embedder.modelId)) {
      const reset = await this.deps.writeGate.resetInterestEmbeddingsNotFrom(embedder.modelId);
      this.queryVectors.clear();
      this.deps.log.info(`Interest ledger: ${reset} vectors from another embedder dropped`);
    }
    // Pages through the rows due at the start of the pass; a row that fails
    // is pushed out by its backoff and not seen again this pass.
    const now = this.deps.clock();
    let after: { createdAt: number; id: string } | undefined;
    for (;;) {
      const batch = listUnembeddedInterestSignals(this.deps.db, { limit: EMBED_BATCH, now, after });
      if (batch.length === 0) return;
      for (const signal of batch) {
        after = { createdAt: signal.createdAt, id: signal.id };
        const text = signal.note ? `${signal.subjectText}\n${signal.note}` : signal.subjectText;
        try {
          const vector = await withTimeout(embedder.embedQuery(text), EMBED_TIMEOUT_MS);
          await this.deps.writeGate.setInterestSignalEmbedding(
            signal.id,
            { vector, model: embedder.modelId },
            this.deps.clock(),
          );
        } catch (error) {
          this.deps.log.warn(
            `Interest signal ${signal.id} not embedded: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.deps.writeGate.setInterestSignalEmbedding(signal.id, null, this.deps.clock());
        }
      }
    }
  }

  /** The query's vector, or null to match by words when it cannot be had in time. */
  private async queryVectorOrWords(
    text: string,
  ): Promise<{ values: Float32Array; model: string } | null> {
    try {
      return await this.queryVector(text);
    } catch (error) {
      this.deps.log.warn(
        `Interest query not embedded; matching by words: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async queryVector(text: string): Promise<{ values: Float32Array; model: string } | null> {
    const embedder = this.deps.getEmbedder();
    if (!embedder) return null;
    const key = `${embedder.modelId}\u0000${text}`;
    const cached = this.queryVectors.get(key);
    if (cached) return cached;
    const values = Float32Array.from(
      await withTimeout(embedder.embedQuery(text), QUERY_EMBED_TIMEOUT_MS),
    );
    const entry = { values, model: embedder.modelId };
    // Bounded: a gate asks about each item once, so the cache only has to
    // cover the few items a pass judges in a row.
    if (this.queryVectors.size >= 256) this.queryVectors.clear();
    this.queryVectors.set(key, entry);
    return entry;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** The lookup seam the gates depend on, so tests can substitute a stub. */
export type InterestLookup = Pick<InterestEngine, "lookup">;
