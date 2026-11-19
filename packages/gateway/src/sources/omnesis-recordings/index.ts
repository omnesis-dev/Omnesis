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
import type { DocumentInput } from "@omnesis/types";

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

/**
 * The session's document, or null when nothing in it was understood as
 * speech — a recording of silence is not worth a document.
 */
export function buildRecordingDocument(
  session: RecordingSession,
  chunks: readonly RecordingChunk[],
): DocumentInput | null {
  const rendered = renderRecording(session, chunks);
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
      // The owner recorded it, so they were there. Everyone else stays
      // unattributed until speakers can be mapped to people.
      // See #859 — planned: diarization and speaker-to-people mapping (suggestions: #860, #861).
      people: [{ name: "You", role: "participant", isSelf: true }],
    },
  };
}
