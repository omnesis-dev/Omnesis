// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-internal sources: datasets the gateway itself owns. They have no
 * collector, no sync engine and no `sources`-table row — only display
 * identity seeded into `sync_state` at boot and documents projected
 * straight into the corpus. `GET /admin/sources` lists them alongside the
 * registered sources (as `internalSources`) so every client can render a
 * row with counters and recent documents; every per-source admin mutation
 * (sync, resync, pause, remove, member join/detach, debug, history import)
 * is refused for them via `assertMutableSource`.
 *
 * Membership here is an explicit allowlist, not a heuristic over orphan
 * `sync_state` rows: a removed source's leftover cursor row must never
 * surface as a first-class source, and the next internal source (e.g. a
 * notes sibling) joins by adding one id.
 *
 * This is deliberately not the `gatewayHostedDescriptors()` mechanism in
 * `internal-source-descriptors.ts`: that one advertises provider-style
 * descriptors (icons, params, add-flow) for push datasets like `web` into
 * `/admin/source-descriptors`. Internal sources have no descriptor, no
 * add-flow and no per-device hosting — just an id whose display identity
 * already lives in `sync_state` — so they ride on `/admin/sources` as
 * `internalSources` instead.
 */

import { HttpError } from "./http/errors.js";
import { OMNESIS_NOTES_SOURCE_ID } from "./sources/omnesis-notes/index.js";
import type { SourceId } from "@omnesis/types";

/** Every gateway-internal source id, in list order. */
export const GATEWAY_INTERNAL_SOURCE_IDS: readonly string[] = [OMNESIS_NOTES_SOURCE_ID];

export function isGatewayInternalSource(id: string): boolean {
  return GATEWAY_INTERNAL_SOURCE_IDS.includes(id);
}

/**
 * Refuse an admin mutation naming a gateway-internal source. Internal
 * sources have no sync to trigger, nothing to fetch again, no pause state
 * and no registration to remove — a 404 would mislead ("source not found"
 * for a source the UI lists), so this is an explicit 409 naming the
 * reason. Route handlers call this as input validation, next to the
 * `SourceId()` parse.
 */
export function assertMutableSource(id: SourceId): void {
  if (isGatewayInternalSource(id)) {
    throw new HttpError(
      409,
      "INTERNAL_SOURCE",
      `source ${id} is hosted by the gateway itself — it cannot be synced, resynced, paused, removed or debugged`,
    );
  }
}

/**
 * Per-internal-source copy for document-write refusals, next to the id
 * allowlist so a second internal source adds its noun + surface here
 * instead of hardcoding display strings in the shared documents route.
 */
const INTERNAL_DOCUMENT_WRITE_COPY: Record<string, { noun: string; surface: string }> = {
  [OMNESIS_NOTES_SOURCE_ID]: {
    noun: "generated Notes search document",
    surface: "Tell Omnesis",
  },
};

/**
 * Refuse a document write naming a gateway-internal source id. Internal
 * day documents are read-only ledger mirrors: ingesting, deleting,
 * reconciling or wiping one through the document routes would hide or
 * corrupt the search mirror without touching the ledger, so every
 * source-scoped document write route calls this as input validation,
 * next to the scope check, before any write. The source-owned
 * projection writes below the route layer and is unaffected.
 */
export function assertExternalDocumentWrite(sourceId: string): void {
  if (!isGatewayInternalSource(sourceId)) return;
  const copy = INTERNAL_DOCUMENT_WRITE_COPY[sourceId] ?? {
    noun: "generated internal search document",
    surface: "its managing surface",
  };
  throw new HttpError(
    409,
    "MANAGE_ORIGINAL_NOTES",
    `This is a ${copy.noun} and cannot be written here. ` +
      `Edit or delete the original note on ${copy.surface} instead.`,
  );
}

/** Wire shape of one gateway-internal source in `GET /admin/sources`. */
export interface InternalSourceEntry {
  id: string;
}

/**
 * The internal sources to advertise. Unconditional: the seed runs at every
 * boot, and the row is how operators discover the capture surface even
 * before the first note lands. Counts, activity and display identity ride
 * on the existing `/status`, `/index/stats` and source-meta feeds keyed by
 * the same id.
 */
export function listInternalSources(): InternalSourceEntry[] {
  return GATEWAY_INTERNAL_SOURCE_IDS.map((id) => ({ id }));
}
