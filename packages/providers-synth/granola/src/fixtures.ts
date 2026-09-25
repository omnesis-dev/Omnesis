// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { noteToDocument, noteToRecord } from "@omnesis/provider-granola";
import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";
import type { GranolaNoteDetail } from "@omnesis/provider-granola";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

/** Deterministic ingest timestamp so the synth corpus is byte-stable. */
const SYNTH_SYNCED_AT = "2026-06-02T00:00:00.000Z";

let cached: GranolaNoteDetail[] | null = null;

/** Load the universe's Granola meeting fixtures (full note detail objects). */
export function loadMeetings(): GranolaNoteDetail[] {
  if (!cached) {
    cached = loadSourceFixtureJson<GranolaNoteDetail[]>(
      loadActiveUniverse(),
      "granola-meetings",
      "meetings.json",
    );
  }
  return cached;
}

/** Map a fixture note to a `granola_meetings` row via the real normalizer. */
export function mapMeetingRecord(
  note: GranolaNoteDetail,
  accountId: string,
): Record<string, unknown> {
  return noteToRecord(note, SYNTH_SYNCED_AT, accountId);
}

/** Map a fixture note to a searchable document via the real normalizer. */
export function mapMeetingDocument(
  note: GranolaNoteDetail,
  ids: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  return noteToDocument(note, ids.providerId, ids.sourceId);
}
