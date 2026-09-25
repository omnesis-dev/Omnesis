// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Generic per-entry context carried by a document explicitly addressed to the
 * agent. Sources opt in through `DocumentMetadata.addressedEntries`; cognition
 * reads that contract without knowing which source produced it.
 *
 * Queue payloads retain only changed entry ids. The live, current contexts are
 * resolved from the document at claim time, matching every other datum read and
 * avoiding a second durable copy of capture metadata in the run ledger.
 */

import { z } from "zod";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** Maximum entry ids one data run attributes explicitly. */
export const MAX_CHANGED_ADDRESSED_ENTRY_IDS = 16;

const addressedEntrySchema = z.object({
  id: z.string().min(1).max(256),
  capturedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  capturedTimeZoneId: z.string().min(1).max(64).optional(),
  capturedUtcOffsetSeconds: z.number().int().min(-64_800).max(64_800).optional(),
  receivedAt: z.string().datetime({ offset: true }).optional(),
  surface: z.string().min(1).max(120).optional(),
  placeName: z.string().min(1).max(256).optional(),
});

export type AddressedEntryContext = z.infer<typeof addressedEntrySchema>;

export interface ChangedAddressedEntryIds {
  ids: string[];
  truncated: boolean;
}

export interface ResolvedAddressedEntries {
  entries: AddressedEntryContext[];
  missingIds: string[];
  metadataUnavailable: boolean;
}

function entriesFromMetadata(metadata: unknown): AddressedEntryContext[] {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const raw = (metadata as Record<string, unknown>)["addressedEntries"];
  if (!Array.isArray(raw)) return [];
  const entries: AddressedEntryContext[] = [];
  for (const value of raw) {
    const parsed = addressedEntrySchema.safeParse(value);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

function entryFingerprint(entry: AddressedEntryContext): string {
  return JSON.stringify(entry);
}

/**
 * Identify entries added or changed by one document upsert. On an insert every
 * valid entry is new. Removed ids are deliberately omitted: there is no live
 * capture context to inject, while the ordinary document diff still tells the
 * agent what disappeared.
 */
export function changedAddressedEntryIds(
  beforeMetadata: unknown,
  afterMetadata: unknown,
): ChangedAddressedEntryIds {
  const before = new Map(
    entriesFromMetadata(beforeMetadata).map((entry) => [entry.id, entryFingerprint(entry)]),
  );
  const changed = entriesFromMetadata(afterMetadata).filter(
    (entry) => before.get(entry.id) !== entryFingerprint(entry),
  );
  const truncated = changed.length > MAX_CHANGED_ADDRESSED_ENTRY_IDS;
  // Prefer the tail: aggregate documents append in capture order, so when an
  // extreme burst exceeds the cap the newest user input remains attributed.
  return {
    ids: changed.slice(-MAX_CHANGED_ADDRESSED_ENTRY_IDS).map((entry) => entry.id),
    truncated,
  };
}

/** Union two folded id sets, newest occurrence winning, under the same cap. */
export function mergeChangedAddressedEntryIds(
  earlier: readonly string[] | undefined,
  later: readonly string[] | undefined,
): ChangedAddressedEntryIds {
  const ordered = new Map<string, true>();
  for (const id of [...(earlier ?? []), ...(later ?? [])]) {
    ordered.delete(id);
    ordered.set(id, true);
  }
  const all = [...ordered.keys()];
  return {
    ids: all.slice(-MAX_CHANGED_ADDRESSED_ENTRY_IDS),
    truncated: all.length > MAX_CHANGED_ADDRESSED_ENTRY_IDS,
  };
}

/** Resolve a run's changed ids against the document's current metadata. */
export function resolveAddressedEntries(
  db: Db,
  docId: string,
  ids: readonly string[],
): ResolvedAddressedEntries {
  if (ids.length === 0) return { entries: [], missingIds: [], metadataUnavailable: false };
  const row = db
    .prepare<[string], { metadata: string | null }>("SELECT metadata FROM documents WHERE id = ?")
    .get(docId);
  if (!row?.metadata) return { entries: [], missingIds: [...ids], metadataUnavailable: true };
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    return { entries: [], missingIds: [...ids], metadataUnavailable: true };
  }
  const byId = new Map(entriesFromMetadata(metadata).map((entry) => [entry.id, entry]));
  const entries: AddressedEntryContext[] = [];
  const missingIds: string[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry) entries.push(entry);
    else missingIds.push(id);
  }
  return { entries, missingIds, metadataUnavailable: false };
}
