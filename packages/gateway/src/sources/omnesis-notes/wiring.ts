// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-boot wiring for the omnesis-notes source. Owns the side-effects:
 *   - Seeds the source's display identity (`sync_state.icon/label/…`) in
 *     the background (idempotent; capture never depends on it).
 *   - Reconciles the ledger and the day-doc projections in the
 *     background (crash recovery; see the comment on the pass below).
 *   - Builds a `NotesDayUpserter` bound to the live writeGate + read
 *     handle + document-ingest/delete paths, and exposes the capture/
 *     edit/remove/list runtime the HTTP routes drive.
 *
 * The boot caller hands in everything from outside (writeGate, read
 * handle, the `DocumentService.ingest`/`deleteByIds` bound functions).
 * This module owns no shared globals — every dependency is explicit so
 * tests can swap any piece in isolation.
 */

import { randomUUID } from "node:crypto";

import { createLogger } from "@omnesis/core";

import { dayKeyFor } from "./day.js";
import { NotesDayUpserter, type NotesDayUpserterDeps } from "./upsert.js";
import {
  seedOmnesisNotesSourceMeta,
  OMNESIS_NOTES_PROVIDER_ID,
  OMNESIS_NOTES_SOURCE_ID,
} from "./source-meta.js";
import {
  getNoteEntry,
  listNoteEntriesForDay,
  listNoteEntriesHistory,
  type NoteEntry,
  type NoteHistoryCursor,
  type NoteHistoryPage,
} from "./storage.js";
import type Database from "better-sqlite3";
import type { McpToolInvocationAuditInput } from "../../access/types.js";
import type { DocumentInput, NoteCaptureContext } from "@omnesis/types";
import type { WriteGate } from "../../write-gate.js";

const log = createLogger("gateway:omnesis-notes");

export interface OmnesisNotesBootDeps {
  writeGate: WriteGate;
  /** Read-side SQLite handle for entry lookups + day listings. */
  readDb: Database.Database;
  /**
   * Document write path — `DocumentService.ingest` in production, so
   * the day-doc upsert emits `document.upserted` (the briefs waker's
   * signal) and wakes the indexer.
   */
  ingest: (docs: DocumentInput[]) => Promise<unknown>;
  /**
   * Document delete path — `DocumentService.deleteByIds` in production,
   * so dropping a day document (its last entry removed) also cascades
   * into `index.db` and runs the annotation / temporal-annotation privacy
   * cascades. The direct WriteGate path would skip all three.
   */
  deleteByIds: (providerId: string, sourceId: string, externalIds: string[]) => Promise<unknown>;
  /** Optional override of the debounce window. Tests pass 0. */
  debounceMs?: number;
  /** Optional scheduler override for unit tests with fake timers. */
  scheduler?: NotesDayUpserterDeps["scheduler"];
}

/** Input to `capture` — one quick-capture note addressed to the assistant. */
export interface CaptureNoteInput {
  captureContext?: NoteCaptureContext;
  /**
   * Client-supplied idempotency key (UUID). When a capture with this id
   * already exists, `capture` returns the stored entry unchanged
   * instead of appending a duplicate — retry-safe for clients whose
   * first attempt timed out after the gateway committed.
   */
  id?: string;
  text: string;
  /** ISO-8601 capture instant; defaults to now. */
  capturedAt?: string;
  /** IANA zone and observed UTC offset snapshotted with `capturedAt`. */
  capturedTimeZoneId?: string;
  capturedUtcOffsetSeconds?: number;
  /** Capture surface slug (e.g. "cli", "portal", "ios-app", "ios-siri"). */
  surface?: string;
  deviceId?: string;
  /** WGS-84 capture location; attached best-effort by the device. */
  latitude?: number;
  longitude?: number;
  /** Device-side reverse-geocoded place name (e.g. "Paris"). */
  placeName?: string;
}

export interface OmnesisNotesRuntime {
  /** Append one note to the ledger and schedule its day's re-render. */
  capture(input: CaptureNoteInput, audit?: McpToolInvocationAuditInput): Promise<NoteEntry>;
  /** Replace an entry's text; null when the id is unknown. */
  edit(id: string, text: string): Promise<NoteEntry | null>;
  /**
   * Hard-delete an entry (false when the id is unknown). The day's
   * re-render drops the projected document when the day is now empty.
   */
  remove(id: string): Promise<boolean>;
  /** Entries for one day (default: today, gateway-local). */
  listDay(day?: string): NoteEntry[];
  /**
   * Newest-first cross-day history page for the Tell Omnesis manager.
   * `beforeDay` seeds the first page at that day (or the nearest older
   * notes when the day is empty); `cursor` continues a feed. Bounded to
   * `limit`; see `listNoteEntriesHistory` for the stability contract.
   */
  listHistory(options: {
    limit: number;
    cursor?: NoteHistoryCursor | null;
    beforeDay?: string | null;
  }): NoteHistoryPage;
  /**
   * Flush every pending debounce timer and await every in-flight
   * upsert. Call before `dispose()` so a capture that landed within the
   * debounce window before SIGTERM still lands as a corpus document.
   */
  flushAll(): Promise<void>;
  /** Tear-down on gateway shutdown. Drops timers; does NOT flush. */
  dispose(): void;
}

/**
 * Set everything up. Returns the runtime the HTTP routes drive and the
 * gateway keeps alive; the boot caller is responsible for calling
 * `flushAll()` + `dispose()` on shutdown. Synchronous — the source-meta
 * seed and the ledger/projection reconciliation both run in the
 * background (idempotent; a failed or slow pass must not block or fail
 * capture).
 */
export function bootOmnesisNotes(deps: OmnesisNotesBootDeps): OmnesisNotesRuntime {
  // Never rejects — the catch converts a failed seed into a warn log so
  // `flushAll` can await it unconditionally.
  const seeded = seedOmnesisNotesSourceMeta(deps.writeGate).catch((err) =>
    log.warn(`source-meta seed threw: ${(err as Error).message ?? err}`),
  );

  const upserter = new NotesDayUpserter({
    listEntries: (day) => listNoteEntriesForDay(deps.readDb, day),
    ingest: deps.ingest,
    deleteDayDoc: async (day) => {
      await deps.deleteByIds(OMNESIS_NOTES_PROVIDER_ID, OMNESIS_NOTES_SOURCE_ID, [day]);
    },
    debounceMs: deps.debounceMs,
    scheduler: deps.scheduler,
  });

  // Boot reconciliation: a crash inside the debounce window (or a
  // capture racing shutdown) can strand a ledger row without a
  // projected day document, and a crashed delete-last-entry can strand
  // a stale day doc whose ledger rows are gone. Enqueue both directions
  // through the debounced upserter to converge them — its zero-entries
  // path deletes stale docs; re-projecting an already-current day is a
  // no-op upsert, so the pass is idempotent. Never rejects (warn log),
  // so `flushAll` can await it unconditionally.
  const reconciled = Promise.resolve()
    .then(() => {
      for (const day of daysToReconcile(deps.readDb)) upserter.enqueue(day);
    })
    .catch((err) => log.warn(`boot reconciliation threw: ${(err as Error).message ?? err}`));

  return {
    capture: async (input, audit) => {
      const text = input.text.trim();
      if (text.length === 0) {
        throw new Error("note text must not be empty");
      }
      // Canonicalize to UTC ISO (the schema already guarantees the
      // input parses) so every stored instant is lexically sortable.
      const receivedAt = new Date().toISOString();
      const capturedAt = new Date(input.capturedAt ?? receivedAt).toISOString();
      const entry: NoteEntry = {
        ...(input.captureContext ? { captureContext: input.captureContext } : {}),
        id: input.id ?? randomUUID(),
        day: dayKeyFor(capturedAt, input.capturedUtcOffsetSeconds),
        capturedAt,
        updatedAt: capturedAt,
        capturedTimeZoneId: input.capturedTimeZoneId ?? null,
        capturedUtcOffsetSeconds: input.capturedUtcOffsetSeconds ?? null,
        receivedAt,
        text,
        surface: input.surface ?? null,
        deviceId: input.deviceId ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        placeName: input.placeName ?? null,
      };
      // INSERT OR IGNORE under the hood: a false result means this id
      // was already captured (client retry) — return the stored entry
      // untouched and skip the re-render.
      const inserted = await deps.writeGate.appendNoteEntry(entry, audit);
      if (!inserted) {
        const existing = getNoteEntry(deps.readDb, entry.id);
        if (existing) return existing;
        // The writer reported a duplicate but its first committed row is
        // not visible on this read handle yet. Never return this retry's
        // freshly stamped `receivedAt` as if it were the stored value;
        // surface a transient 500 so the idempotent client can retry once
        // read-side WAL visibility catches up.
        throw new Error(`captured note ${entry.id} is not visible yet; retry`);
      }
      upserter.enqueue(entry.day);
      log.info(`Captured note ${entry.id} for ${entry.day} (${text.length} chars)`);
      return entry;
    },
    edit: async (id, text) => {
      const existing = getNoteEntry(deps.readDb, id);
      if (!existing) return null;
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        throw new Error("note text must not be empty");
      }
      const now = new Date().toISOString();
      // The row can vanish between the read above and this write (a
      // concurrent delete) — a false result is the same 404 as unknown.
      const updated = await deps.writeGate.updateNoteEntry(id, trimmed, now);
      if (!updated) return null;
      upserter.enqueue(existing.day);
      return { ...existing, text: trimmed, updatedAt: now };
    },
    remove: async (id) => {
      const { deleted, day } = await deps.writeGate.deleteNoteEntry(id);
      if (!deleted || day === null) return false;
      upserter.enqueue(day);
      return true;
    },
    listDay: (day) =>
      listNoteEntriesForDay(deps.readDb, day ?? dayKeyFor(new Date().toISOString())),
    listHistory: (options) =>
      listNoteEntriesHistory(deps.readDb, options.limit, options.cursor, options.beforeDay),
    // Quiesce ALL background work: the boot-time seed and reconciliation
    // too, so a caller that flushes before closing its DB handle can't
    // race a straggling write.
    flushAll: async () => {
      await seeded;
      await reconciled;
      await upserter.flushAll();
    },
    dispose: () => upserter.dispose(),
  };
}

/**
 * Days whose ledger and projection disagree: ledger days with no
 * projected document, plus projected documents whose ledger days are
 * empty. Both converge through one `runUpsert` per day.
 */
function daysToReconcile(db: Database.Database): string[] {
  const unprojected = db
    .prepare<[string, string], { day: string }>(
      `SELECT DISTINCT day FROM note_entries
       WHERE day NOT IN (
         SELECT external_id FROM documents WHERE provider_id = ? AND source_id = ?
       )`,
    )
    .all(OMNESIS_NOTES_PROVIDER_ID, OMNESIS_NOTES_SOURCE_ID);
  const stale = db
    .prepare<[string, string], { day: string }>(
      `SELECT external_id AS day FROM documents
       WHERE provider_id = ? AND source_id = ?
         AND external_id NOT IN (SELECT DISTINCT day FROM note_entries)`,
    )
    .all(OMNESIS_NOTES_PROVIDER_ID, OMNESIS_NOTES_SOURCE_ID);
  return [...unprojected, ...stale].map((row) => row.day);
}
