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
import { renderRecording, speakersHeard } from "./render.js";
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

/** Someone the owner says was present without a speaking turn of their own. */
export interface ParticipantIdentity {
  /** What removes them: `person:<id>` or `name:<lowercased name>`. */
  key: string;
  personId: string | null;
  /** The person's name, or the name the owner gave; null for a person with no name. */
  name: string | null;
}

/**
 * The session's document, or null when nothing in it was understood as
 * speech — a recording of silence is not worth a document. Speakers the
 * owner mapped to people, and people the owner says were present without a
 * turn, are participants; the latter are also named under the header.
 *
 * With `conversation`, the document of that conversation of a split session:
 * only its chunks, timed from its own start, under its own title. Only the
 * speakers whose voice is heard in its chunks are its participants, so a
 * person who spoke in one conversation of an all-day session is not linked
 * to the others. The people present without a turn are recorded for the
 * session as a whole, so they are participants of every conversation of it.
 */
export function buildRecordingDocument(
  session: RecordingSession,
  chunks: readonly RecordingChunk[],
  marks: readonly RecordingMark[] = [],
  speakers: readonly SpeakerIdentity[] = [],
  participants: readonly ParticipantIdentity[] = [],
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
    return documentOf(part, inPart, marks, speakers, participants, conversation);
  }
  return documentOf(session, chunks, marks, speakers, participants);
}

function documentOf(
  session: RecordingSession,
  chunks: readonly RecordingChunk[],
  marks: readonly RecordingMark[],
  allSpeakers: readonly SpeakerIdentity[],
  participants: readonly ParticipantIdentity[],
  conversation?: ConversationPart,
): DocumentInput | null {
  const names = new Map<number, string>();
  const people: PersonMention[] = [{ name: "You", role: "participant", isSelf: true }];
  const linked = new Set<string>();
  const voiced = speakersHeard(chunks);
  const speakers = allSpeakers.filter((s) => voiced.has(s.speaker));
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
  // Someone already heard as a speaker is not named again as present.
  const heard = new Set([...names.values()].map((name) => name.toLowerCase()));
  const alsoPresent: string[] = [];
  for (const p of participants) {
    const alreadyLinked = p.personId !== null && linked.has(p.personId);
    if (p.personId && !alreadyLinked) {
      linked.add(p.personId);
      people.push({
        role: "participant",
        personId: p.personId,
        ...(p.name ? { name: p.name } : {}),
      });
    }
    if (p.name && !alreadyLinked && !heard.has(p.name.toLowerCase())) {
      heard.add(p.name.toLowerCase());
      alsoPresent.push(p.name);
    }
  }
  const rendered = renderRecording(
    session,
    chunks,
    marks,
    names,
    alsoPresent,
    conversation?.firstSeq ?? 0,
  );
  if (!rendered.hasSpeech) return null;
  return {
    providerId: ProviderId(OMNESIS_RECORDINGS_PROVIDER_ID),
    sourceId: SourceId(OMNESIS_RECORDINGS_SOURCE_ID),
    externalId: conversation ? conversationExternalId(session.id, conversation.n) : session.id,
    title: rendered.title,
    content: rendered.body,
    contentHash: projectionHash(rendered.title, rendered.body, people),
    sourceCreatedAt: session.startedAt,
    sourceUpdatedAt: session.lastActivityAt,
    metadata: {
      documentType: "conversation",
      // The owner recorded it, so they were there; everyone else is who the
      // owner mapped a speaker to or said was present.
      people,
      extra: {
        recordingOrigin: session.origin,
        ...(conversation ? { conversation: conversation.n } : {}),
        ...(marks.length > 0 ? { markedMoments: marks.length } : {}),
      },
    },
  };
}

/**
 * What the document says, as one fingerprint: its text and who it links to.
 * The people are part of it because a speaker remapped to someone else of
 * the same name changes the links without changing a word of the text, and
 * a conversation whose fingerprint is unchanged is not written again.
 */
function projectionHash(title: string, body: string, people: readonly PersonMention[]): string {
  const who = people.map((p) => [p.personId ?? null, p.name ?? null, p.isSelf ?? false]);
  return createHash("sha256")
    .update(JSON.stringify([title, body, who]))
    .digest("hex");
}
