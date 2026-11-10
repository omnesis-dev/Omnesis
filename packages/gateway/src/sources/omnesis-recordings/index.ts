// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The omnesis-recordings built-in source (experimental): conversations a
 * phone records on the table and uploads in chunks while it records. The
 * gateway transcribes the chunks (`src/recordings/`) and projects each
 * finished session into one document here.
 *
 * Like omnesis-notes it is gateway-internal: no descriptor, no collector,
 * no `sources` row. It is listed only in experimental mode, and its
 * display identity is seeded into `sync_state` at boot in that mode.
 */

import { createHash } from "node:crypto";

import { ProviderId, SourceId } from "@omnesis/types";

import { omnesisBrandIcon } from "../omnesis-notes/index.js";
import { renderRecording } from "./render.js";
import type { RecordingChunk, RecordingSession } from "../../recordings/storage.js";
import type { WriteGate } from "../../write-gate.js";
import type { DocumentInput, PersonMention } from "@omnesis/types";

export const OMNESIS_RECORDINGS_SOURCE_ID = "omnesis-recordings";
export const OMNESIS_RECORDINGS_PROVIDER_ID = "system";
export const OMNESIS_RECORDINGS_LABEL = "Recordings";
const ACCENT_COLOR = "#1F6FEB";
const BG_COLOR = "#0D1117";

export { renderRecording, formatOffset, formatSpan, recordingTitle } from "./render.js";

/** Idempotent: `setSourceMeta` COALESCEs, so repeat calls never clobber. */
export async function seedOmnesisRecordingsSourceMeta(writeGate: WriteGate): Promise<void> {
  await writeGate.setSourceMeta(OMNESIS_RECORDINGS_SOURCE_ID, {
    icon: await omnesisBrandIcon(),
    label: OMNESIS_RECORDINGS_LABEL,
    accentColor: ACCENT_COLOR,
    bgColor: BG_COLOR,
  });
}

/** Who one speaker of a session is, with the name to show for them. */
export interface SpeakerIdentity {
  speaker: number;
  isSelf: boolean;
  /** The mapped person, when the owner chose one. */
  personId: string | null;
  /** The person's name, or the name the owner gave; null when unnamed. */
  name: string | null;
}

/**
 * The session's document, or null when nothing in it was understood as
 * speech — a recording of silence is not worth a document. Speakers the
 * owner mapped to people make those people participants.
 */
export function buildRecordingDocument(
  session: RecordingSession,
  chunks: readonly RecordingChunk[],
  speakers: readonly SpeakerIdentity[] = [],
): DocumentInput | null {
  const names = new Map<number, string>();
  const people: PersonMention[] = [{ name: "You", role: "participant", isSelf: true }];
  const linked = new Set<string>();
  for (const s of speakers) {
    if (s.isSelf) names.set(s.speaker, "You");
    else if (s.name) names.set(s.speaker, s.name);
    if (s.personId && !linked.has(s.personId)) {
      linked.add(s.personId);
      people.push({
        role: "participant",
        personId: s.personId,
        ...(s.name ? { name: s.name } : {}),
      });
    }
  }
  const rendered = renderRecording(session, chunks, names);
  if (!rendered.hasSpeech) return null;
  return {
    providerId: ProviderId(OMNESIS_RECORDINGS_PROVIDER_ID),
    sourceId: SourceId(OMNESIS_RECORDINGS_SOURCE_ID),
    externalId: session.id,
    title: rendered.title,
    content: rendered.body,
    contentHash: createHash("sha256").update(rendered.body).digest("hex"),
    sourceCreatedAt: session.startedAt,
    sourceUpdatedAt: session.lastActivityAt,
    metadata: {
      documentType: "conversation",
      // The owner recorded it, so they were there; everyone else is who the
      // owner mapped a speaker to.
      // See #860 — planned: suggest participants from the calendar and mentions.
      people,
    },
  };
}
