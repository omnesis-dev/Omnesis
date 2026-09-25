// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Notes day upserter. Projects one day's `note_entries` into a single
 * corpus document (`externalId` = the `YYYY-MM-DD` day key) and keeps
 * that projection current as entries arrive, change, or disappear.
 *
 * Per-day debouncing coalesces a burst of captures into one write at
 * the end of a short idle window (default 3s — a capture should surface
 * fast, but a dictated multi-part note shouldn't re-render per
 * sentence). `flushAll()` is the shutdown entry point. The
 * timer/serialization machinery lives in the shared
 * `KeyedDebouncedRunner` (key = day), so concurrent enqueues / flushes
 * never produce two concurrent writes targeting the same day document.
 *
 * Inside `runUpsert`: load the day's entries via the injected reader;
 * zero entries → delete the day document (last note of the day was
 * removed); otherwise render + build the `DocumentInput` and write it
 * via the injected `ingest`. Writes go through `DocumentService.ingest`
 * — NOT `writeGate.upsertDocuments` directly — so the upsert emits
 * `document.upserted` (the briefs waker's signal) and wakes the indexer.
 */

import { createHash } from "node:crypto";

import { createLogger } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput, type PersonMention } from "@omnesis/types";

import { KeyedDebouncedRunner } from "../../keyed-debounced-runner.js";
import { principalDisplayName, renderNotesDay } from "./render.js";
import { OMNESIS_NOTES_PROVIDER_ID, OMNESIS_NOTES_SOURCE_ID } from "./source-meta.js";
import type { NoteEntry } from "./storage.js";

const log = createLogger("gateway:omnesis-notes").child("upsert");

/** Default per-day debounce window. */
export const DEFAULT_DEBOUNCE_MS = 3_000;

export interface NotesDayUpserterDeps {
  /** Reads the day's entries at flush time (freshest ledger state). */
  listEntries: (day: string) => NoteEntry[] | Promise<NoteEntry[]>;
  /**
   * Document write path. `DocumentService.ingest` in production — it
   * emits `document.upserted` and wakes the indexer, which the direct
   * WriteGate path would skip.
   */
  ingest: (docs: DocumentInput[]) => Promise<unknown>;
  /** Drops the day's projected document when its last entry is deleted. */
  deleteDayDoc: (day: string) => Promise<void>;
  /** Override the debounce window. Tests pass 0 for synchronous flushes. */
  debounceMs?: number;
  /** Pluggable timer for unit tests. */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export class NotesDayUpserter {
  private readonly deps: NotesDayUpserterDeps;
  /** Debounce + per-key serialization machinery (key = day). */
  private readonly runner: KeyedDebouncedRunner;

  constructor(deps: NotesDayUpserterDeps) {
    this.deps = deps;
    this.runner = new KeyedDebouncedRunner({
      debounceMs: deps.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      scheduler: deps.scheduler,
      run: (day) => this.runUpsert(day),
      onError: (day, err) => {
        log.warn(`upsert failed for day ${day}: ${(err as Error).message ?? err}`);
      },
    });
  }

  /**
   * Schedule an upsert for `day` after the debounce window. Subsequent
   * enqueues for the same day cancel the prior timer and install a new
   * one; the entries are read when the timer fires so the eventual
   * write always sees the freshest ledger.
   */
  enqueue(day: string): void {
    this.runner.enqueue(day);
  }

  /**
   * Flush every pending day and await every in-flight run. Shutdown
   * hook — call this before `dispose()` so a capture that landed within
   * the debounce window before SIGTERM still lands as a corpus document.
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
  }

  private async runUpsert(day: string): Promise<void> {
    const entries = await this.deps.listEntries(day);
    if (entries.length === 0) {
      // Last entry of the day was deleted — drop the projected document.
      await this.deps.deleteDayDoc(day);
      return;
    }
    await this.deps.ingest([buildNotesDayDocument(day, entries)]);
  }
}

/**
 * Who wrote the day's notes and who received them. The operator authors the
 * entries they captured themselves; an entry captured through an access grant
 * is authored by that grant's principal — an agent, never a person, so people
 * resolution leaves it unresolved — and received by the operator. The `You`
 * mentions resolve to the canonical self person at people-resolution time and
 * are silently dropped when no self person exists.
 */
function notesDayPeople(entries: readonly NoteEntry[]): PersonMention[] {
  const agents = new Set<string>();
  let operatorAuthored = false;
  for (const entry of entries) {
    if (entry.captureContext) agents.add(principalDisplayName(entry.captureContext));
    else operatorAuthored = true;
  }
  const people: PersonMention[] = [];
  if (operatorAuthored) people.push({ name: "You", role: "author", isSelf: true });
  for (const name of agents) people.push({ name, role: "author", isSelf: false, kind: "agent" });
  if (agents.size > 0) people.push({ name: "You", role: "recipient", isSelf: true });
  return people;
}

/**
 * Build the day document from its entries. Pure projection —
 * deterministic given the same entries. Callers pass them in capture
 * order (as `listNoteEntriesForDay` returns them).
 */
export function buildNotesDayDocument(day: string, entries: readonly NoteEntry[]): DocumentInput {
  if (entries.length === 0) {
    throw new Error(`buildNotesDayDocument: no entries for day ${day}`);
  }
  const { title, body } = renderNotesDay(day, entries);
  const contentHash = createHash("sha256").update(body).digest("hex");
  // First capture opens the day; the newest capture-or-edit instant is
  // the update stamp (an edit to an old entry must bump it so consumers
  // keyed on sourceUpdatedAt notice the change).
  let sourceUpdatedAt = "";
  for (const entry of entries) {
    if (entry.capturedAt > sourceUpdatedAt) sourceUpdatedAt = entry.capturedAt;
    if (entry.updatedAt > sourceUpdatedAt) sourceUpdatedAt = entry.updatedAt;
  }
  return {
    providerId: ProviderId(OMNESIS_NOTES_PROVIDER_ID),
    sourceId: SourceId(OMNESIS_NOTES_SOURCE_ID),
    externalId: day,
    title,
    content: body,
    contentHash,
    sourceCreatedAt: entries[0]!.capturedAt,
    sourceUpdatedAt,
    metadata: {
      documentType: "note",
      people: notesDayPeople(entries),
      // The whole point of the source: the user explicitly addressed
      // these notes to the assistant — consumers (the briefs waker)
      // treat the document as maximally high-signal.
      addressedToAgent: true,
      addressedEntries: entries.map((entry) => ({
        ...(entry.captureContext ? { captureContext: entry.captureContext } : {}),
        id: entry.id,
        capturedAt: entry.capturedAt,
        updatedAt: entry.updatedAt,
        ...(entry.capturedTimeZoneId ? { capturedTimeZoneId: entry.capturedTimeZoneId } : {}),
        ...(entry.capturedUtcOffsetSeconds !== null
          ? { capturedUtcOffsetSeconds: entry.capturedUtcOffsetSeconds }
          : {}),
        ...(entry.receivedAt ? { receivedAt: entry.receivedAt } : {}),
        ...(entry.surface ? { surface: entry.surface } : {}),
        ...(entry.placeName ? { placeName: entry.placeName } : {}),
      })),
      extra: { entryCount: entries.length },
    },
  };
}
