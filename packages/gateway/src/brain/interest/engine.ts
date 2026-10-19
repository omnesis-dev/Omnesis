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
 * held on the embedder. The lookup fails open: any error, a missing embedder
 * or an empty ledger all answer null, and the gate asks its question as it
 * always has.
 */

import {
  countUnembeddedInterestSignals,
  listLiveInterestSignals,
  listUnembeddedInterestSignals,
  type InterestKind,
  type InterestPolarity,
  type InterestSignal,
  type InterestSource,
  type NewInterestSignal,
} from "../storage/interest.js";
import {
  DEFAULT_LOOKUP_OPTIONS,
  hasOwnerInterest,
  lookupOwnerInterest,
  type InterestLookupOptions,
  type OwnerInterest,
} from "./lookup.js";
import type { Logger } from "@omnesis/core";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

/** The main-thread embedder, when one is assigned and loaded. */
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
  /** `brain.interest.enabled`, read live. */
  enabled: () => boolean;
  clock: () => number;
  idGen: () => string;
  log: Logger;
  lookupOptions?: Partial<InterestLookupOptions>;
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
  /** Supersede the live signals about this loop or observation first. */
  replaces?: { loopId?: string; observationId?: string; kind?: InterestKind };
}

/** What a gate asks about: the text of the thing it is judging. */
export interface InterestLookupQuery {
  text: string;
}

/** Signals kept for lookup: newest first, bounded so a lookup stays a few milliseconds. */
const LOOKUP_SIGNAL_LIMIT = 2_000;
/** Signals embedded per backlog pass; a pass runs again while any remain. */
const EMBED_BATCH = 16;
const EMBED_TIMEOUT_MS = 30_000;

export class InterestEngine {
  private readonly options: InterestLookupOptions;
  private draining: Promise<void> | null = null;
  private pendingDrain = false;
  private readonly queryVectors = new Map<string, { values: Float32Array; model: string }>();

  constructor(private readonly deps: InterestEngineDeps) {
    this.options = { ...DEFAULT_LOOKUP_OPTIONS, ...deps.lookupOptions };
  }

  enabled(): boolean {
    return this.deps.enabled();
  }

  /** Record one reaction. Nothing is written when the ledger is off. */
  async record(input: RecordInterestInput): Promise<InterestSignal | null> {
    if (!this.enabled()) return null;
    const signal: NewInterestSignal = {
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
    const stored = await this.deps.writeGate.recordInterestSignal(signal, input.replaces ?? null);
    this.kick();
    return stored;
  }

  /** Take back the live signals about a loop or observation. */
  async supersede(by: {
    loopId?: string;
    observationId?: string;
    kind?: InterestKind;
  }): Promise<number> {
    return this.deps.writeGate.supersedeInterestSignals(by, this.deps.clock());
  }

  /**
   * The owner's past reactions that resemble `query.text`, or null when there
   * are none worth showing. Never throws.
   */
  async lookup(query: InterestLookupQuery): Promise<OwnerInterest | null> {
    if (!this.enabled()) return null;
    try {
      const signals = listLiveInterestSignals(this.deps.db, { limit: LOOKUP_SIGNAL_LIMIT });
      if (signals.length === 0) return null;
      const vector = signals.some((s) => s.embedding) ? await this.queryVector(query.text) : null;
      const block = lookupOwnerInterest(signals, { text: query.text, vector }, this.deps.clock(), {
        ...this.options,
      });
      return hasOwnerInterest(block) ? block : null;
    } catch (error) {
      this.deps.log.warn(
        `Interest lookup failed; deciding without it: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** Whether any live signal still waits for its vector. */
  hasBacklog(): boolean {
    return this.enabled() && countUnembeddedInterestSignals(this.deps.db) > 0;
  }

  /**
   * Embed the signals that have no vector yet. One pass at a time; a kick
   * during a pass runs another after it, and the returned promise covers both.
   * Resolves when the backlog is empty, the embedder is absent, or every
   * remaining row has used its attempts.
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

  private async drain(): Promise<void> {
    if (!this.enabled()) return;
    const embedder = this.deps.getEmbedder();
    if (!embedder) return;
    // A vector from another embedder is not comparable with the live one.
    const reset = await this.deps.writeGate.resetInterestEmbeddingsNotFrom(embedder.modelId);
    if (reset > 0) {
      this.queryVectors.clear();
      this.deps.log.info(`Interest ledger: ${reset} vectors from another embedder dropped`);
    }
    // A row gets one attempt per pass, so an embedder outage costs each row
    // one of its attempts rather than all of them.
    const attempted = new Set<string>();
    for (;;) {
      const batch = listUnembeddedInterestSignals(this.deps.db, EMBED_BATCH).filter(
        (signal) => !attempted.has(signal.id),
      );
      if (batch.length === 0) return;
      for (const signal of batch) {
        attempted.add(signal.id);
        const text = signal.note ? `${signal.subjectText}\n${signal.note}` : signal.subjectText;
        try {
          const vector = await withTimeout(embedder.embedQuery(text), EMBED_TIMEOUT_MS);
          await this.deps.writeGate.setInterestSignalEmbedding(signal.id, {
            vector,
            model: embedder.modelId,
          });
        } catch (error) {
          this.deps.log.warn(
            `Interest signal ${signal.id} not embedded: ${error instanceof Error ? error.message : String(error)}`,
          );
          await this.deps.writeGate.setInterestSignalEmbedding(signal.id, null);
        }
      }
    }
  }

  private async queryVector(text: string): Promise<{ values: Float32Array; model: string } | null> {
    const embedder = this.deps.getEmbedder();
    if (!embedder) return null;
    const key = `${embedder.modelId}\u0000${text}`;
    const cached = this.queryVectors.get(key);
    if (cached) return cached;
    const values = Float32Array.from(
      await withTimeout(embedder.embedQuery(text), EMBED_TIMEOUT_MS),
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
