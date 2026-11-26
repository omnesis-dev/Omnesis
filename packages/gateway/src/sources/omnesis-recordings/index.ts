// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The omnesis-recordings built-in source (experimental): conversations a
 * phone records on the table and uploads in chunks while it records. The
 * gateway transcribes the chunks (`src/recordings/`) and projects each
 * finished session into one document here — or, for an all-day session the
 * gateway split, one document per conversation.
 *
 * Like omnesis-notes it is gateway-internal: no descriptor, no collector,
 * no `sources` row. It is listed only in experimental mode, and its
 * display identity is seeded into `sync_state` at boot in that mode.
 */

import { createHash } from "node:crypto";

import { ProviderId, SourceId } from "@omnesis/types";

import { omnesisBrandIcon } from "../omnesis-notes/index.js";
import { renderRecording } from "./render.js";
import type { RecordingChunk, RecordingMark, RecordingSession } from "../../recordings/storage.js";
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

/** One conversation of a split session, as its document is written. */
export interface ConversationPart {
  n: number;
  firstSeq: number;
  lastSeq: number;
  startedAt: string;
  /** The owner's title for it; null for the time-based one. */
  title: string | null;
  /** The session's last conversation, which names the parts that never arrived. */
  last: boolean;
}

/**
 * The document of conversation `n` of a session: the first keeps the
 * session's own id, so a session's document stays where it was once the
 * session is split.
 */
export function conversationExternalId(sessionId: string, n: number): string {
  return n === 1 ? sessionId : `${sessionId}:${n}`;
}

/**
 * The session's document, or null when nothing in it was understood as
 * speech — a recording of silence is not worth a document. Speakers the
 * owner mapped to people make those people participants. With
 * `conversation`, the document of that conversation of a split session:
 * only its chunks, timed from its own start, under its own title.
 */
export function buildRecordingDocument(
  session: RecordingSession,
  chunks: readonly RecordingChunk[],
  marks: readonly RecordingMark[] = [],
  speakers: readonly SpeakerIdentity[] = [],
  conversation?: ConversationPart,
): DocumentInput | null {
  if (conversation) {
    const part: RecordingSession = {
      ...session,
      startedAt: conversation.startedAt,
      title: conversation.title,
      chunkCount: conversation.last ? session.chunkCount : null,
      endedAt: conversation.last ? session.endedAt : null,
    };
    const inPart = chunks.filter(
      (c) => c.seq >= conversation.firstSeq && c.seq <= conversation.lastSeq,
    );
    return documentOf(part, inPart, marks, speakers, conversation);
  }
  return documentOf(session, chunks, marks, speakers);
}

function documentOf(
  session: RecordingSession,
  chunks: readonly RecordingChunk[],
  marks: readonly RecordingMark[],
  speakers: readonly SpeakerIdentity[],
  conversation?: ConversationPart,
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
  const rendered = renderRecording(session, chunks, marks, names, conversation?.firstSeq ?? 0);
  if (!rendered.hasSpeech) return null;
  return {
    providerId: ProviderId(OMNESIS_RECORDINGS_PROVIDER_ID),
    sourceId: SourceId(OMNESIS_RECORDINGS_SOURCE_ID),
    externalId: conversation ? conversationExternalId(session.id, conversation.n) : session.id,
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
      extra: {
        recordingOrigin: session.origin,
        ...(conversation ? { conversation: conversation.n } : {}),
        ...(marks.length > 0 ? { markedMoments: marks.length } : {}),
      },
    },
  };
}
