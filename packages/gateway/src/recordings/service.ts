// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Recorded conversations (experimental): a phone records a conversation with
 * the screen off and uploads it as numbered chunks while it records; this
 * service transcribes the chunks as they arrive and writes one document per
 * session once it is finished and every chunk is settled.
 *
 * Transcription runs at background priority, so a note being dictated or a
 * spoken question never waits behind an hour of meeting audio. A long
 * meeting is then mostly transcribed by the time it ends. Each chunk's audio
 * is dropped as soon as the chunk is settled — transcribed, or given up on
 * after `MAX_ATTEMPTS` or `MAX_AGE_MS` — so the transcript is what stays.
 * See #864 — planned: an optional audio retention setting.
 *
 * Sessions converge without the device: one the device stops talking to is
 * finished after `ABANDONED_AFTER_MS` with the chunks it sent (provisionally:
 * a chunk uploaded later reopens it, and the device's own finish replaces
 * the count), and a finished
 * session still missing chunks is written with the gap named after
 * `MISSING_GRACE_MS`. The document is written once per change of the session,
 * never per chunk, so the Brain reads a finished conversation, not a stream.
 *
 * When a voice separator is configured, each chunk's voices are separated
 * before its audio goes, and the session's voices are grouped into speakers
 * just before its document is written — at which point every voice vector is
 * deleted (see `voices/voices.ts`). The owner then says who each speaker is;
 * each mapping rewrites the document through the same revision path.
 *
 * With `inference.recordings.selfVoice` set to `match`, the owner can enrol
 * their own voice from a short read-aloud clip: its audio is separated like a
 * chunk's, summarised into one mean vector and dropped. Each grouping then
 * compares its new speakers with that vector before the vectors are deleted,
 * and maps the closest one above `SELF_VOICE_SIMILARITY` as the owner, marked
 * as recognised so the owner can undo it. Undone once, nothing in that session
 * is recognised again. Turning the setting off deletes the enrolled voice.
 */

import { assertNever, createLogger } from "@omnesis/core";
import { findDocumentIdBySourceExternalId } from "../data/repositories/DocumentRepository.js";
import { getPersonNames } from "../data/repositories/PersonRepository.js";
import { OMNESIS_RECORDINGS_SOURCE_ID } from "../sources/omnesis-recordings/index.js";
import { recordingTitle, speakerTurns } from "../sources/omnesis-recordings/render.js";
import {
  listRecentRecordingSessions,
  listRecordingSpeakers,
  listRecordingParticipants,
  listUngroupedRecordingVoices,
  getRecordingChunk,
  getRecordingSession,
  listAbandonedRecordingSessions,
  listDueRecordingChunks,
  listRecordingChunks,
  listRecordingMarks,
  listUnprojectedRecordingSessions,
  countRecordingChunks,
  readRecordingChunkAudio,
  sumRecordingChunkDurations,
  listDismissedRecordingSuggestions,
  getRecordingVoiceProfile,
  hasRejectedSelfMatch,
  type FinishRecordingOutcome,
  type InsertRecordingChunkOutcome,
  type RecordingChunk,
  type RecordingMark,
  type RecordingOrigin,
  type RecordingChunkStatus,
  type RecordingSession,
  type RecordingSpeakerMapping,
  type NewRecordingParticipant,
} from "./storage.js";
import { resolveGivenName } from "./suggestion-reads.js";
import {
  buildSuggestions,
  type CalendarEventCandidate,
  type RecordingSuggestion,
  type SuggestionTurn,
} from "./suggestions.js";
import { matchSelf, meanVoice } from "./voices/voices.js";
import type { ParticipantIdentity, SpeakerIdentity } from "../sources/omnesis-recordings/index.js";
import type { SeparatedVoices, VoiceSeparator, VoiceWindow } from "./voices/voices.js";
import type {
  TranscriberReadiness,
  TranscribeOptions,
  TranscriptionOutcome,
} from "../transcribe/index.js";
import type { DocumentInput } from "@omnesis/types";
import type { WriteGate } from "../write-gate.js";
import type Database from "better-sqlite3";

const log = createLogger("gateway:recordings");

/** Transcription attempts before a chunk is given up on. */
export const MAX_ATTEMPTS = 6;
/** How long a chunk may wait for a transcript at all. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A session the device has not touched for this long is finished for it. */
export const ABANDONED_AFTER_MS = 12 * 60 * 60 * 1000;
/** How long a finished session waits for chunks it declared but never sent. */
export const MISSING_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/** Delay before each retry after a failed attempt (the last value repeats). */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
/** How often a chunk is re-checked while no transcriber can run. */
const UNAVAILABLE_RECHECK_MS = 30 * 60_000;
/** The least time each attempt may take; nobody waits on a chunk. */
const PATIENCE_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000];
/** How often the loop looks for work when nothing wakes it sooner. */
const POLL_INTERVAL_MS = 60_000;
/** Sessions handled per sweep step, so one pass never walks the whole ledger. */
const SWEEP_BATCH = 20;

export interface RecordingServiceDeps {
  writeGate: Pick<
    WriteGate,
    | "createRecordingSession"
    | "insertRecordingChunk"
    | "deleteRecordingSession"
    | "finishRecordingSession"
    | "abandonRecordingSession"
    | "rescheduleRecordingChunk"
    | "settleRecordingChunk"
    | "purgeRecordingAudio"
    | "setRecordingTitle"
    | "dismissRecordingSuggestion"
    | "markRecordingSessionProjected"
    | "addRecordingMark"
    | "assignRecordingVoices"
    | "setRecordingSpeaker"
    | "setRecordingVoiceProfile"
    | "deleteRecordingVoiceProfile"
    | "addRecordingParticipant"
    | "removeRecordingParticipant"
  >;
  readDb: Database.Database;
  transcribe: (
    audio: Uint8Array,
    mimeType: string,
    opts?: TranscribeOptions,
  ) => Promise<TranscriptionOutcome>;
  /** The transcriber's readiness, once anything it is still checking has settled. */
  readiness: () => Promise<TranscriberReadiness>;
  /** Document write path — DocumentService.ingest in production. */
  ingest: (docs: DocumentInput[]) => Promise<unknown>;
  /** Drops the session's document, if any. */
  deleteDocument: (externalId: string) => Promise<unknown>;
  /** Renders a session into its document; null when there is nothing to keep. */
  buildDocument: (
    session: RecordingSession,
    chunks: readonly RecordingChunk[],
    marks: readonly RecordingMark[],
    speakers: readonly SpeakerIdentity[],
    participants: readonly ParticipantIdentity[],
  ) => DocumentInput | null;
  /** The voice separator, or null while speakers are not told apart. */
  voices?: () => VoiceSeparator | null;
  /**
   * Days a chunk's audio is kept once it is settled; 0 (the default) drops
   * it at once. Read on every pass, so a changed setting applies without a
   * restart, and lowering it drops what is now past it.
   */
  keepAudioDays?: () => number;
  /**
   * Whether the owner's enrolled voice is recognised among a session's
   * speakers; `off` (the default) also deletes it. Read on every pass.
   */
  selfVoice?: () => SelfVoiceSetting;
  /**
   * Events on the owner's calendar overlapping `[from, toExclusive)`, with who
   * was invited; absent, no calendar suggestion is made.
   */
  calendarEvents?: (from: string, toExclusive: string) => Promise<CalendarEventCandidate[]>;
  now?: () => Date;
}

/** The longest an operator may keep a recording's audio. */
const MAX_KEEP_AUDIO_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One speaker of a session, as the owner reviews it. */
export interface RecordingSpeakerView extends SpeakerIdentity {
  /** How long this speaker spoke, ms. */
  talkMs: number;
  /** The first few things they said. */
  samples: string[];
  /** The gateway mapped this speaker as the owner by their enrolled voice. */
  selfMatched: boolean;
}

export type SelfVoiceSetting = "off" | "match";

/** The least speech an enrolment clip must hold. */
export const MIN_ENROLMENT_SPEECH_MS = 20_000;
/** The share of a clip's speech its main voice must hold to be enrolled. */
const ENROLMENT_MAIN_VOICE_SHARE = 0.8;

/** What the owner sees of their enrolled voice. */
export interface SelfVoiceStatus {
  setting: SelfVoiceSetting;
  /** Whether voices can be separated now: speakers are told apart and the models are ready. */
  ready: boolean;
  /** The least speech an enrolment clip must hold, ms. */
  minSpeechMs: number;
  profile: {
    enrolledAt: string;
    speechMs: number;
    /** False when it came from another voice model than the one in use: enrol again. */
    current: boolean;
  } | null;
}

export type EnrollSelfVoiceOutcome =
  | { kind: "enrolled"; status: SelfVoiceStatus }
  /** The setting is off. */
  | { kind: "off" }
  /** No voice separator is ready. */
  | { kind: "unavailable" }
  /** The audio could not be read. */
  | { kind: "unreadable" }
  /** Too little speech; `speechMs` is what the clip held. */
  | { kind: "too-short"; speechMs: number }
  /** No one voice holds most of the clip. */
  | { kind: "several-voices" };

/** What a recording's suggestions are offered against: its window, and the suggestions. */
export interface RecordingSuggestions {
  suggestions: RecordingSuggestion[];
}

/** A recording with no end yet is looked up over at least this long. */
const MIN_WINDOW_MS = 60_000;

/** A session in the list of recent recordings. */
export interface RecordingSummary {
  id: string;
  title: string;
  startedAt: string;
  state: RecordingState;
  /** The chunk count the device declared; null while it records. */
  chunkCount: number | null;
  chunks: RecordingStatus["chunks"];
  /** The recorded time of the chunks received, ms. */
  durationMs: number;
  speakers: number;
  /** Speakers the owner has said who they are. */
  namedSpeakers: number;
  /** The session's document, once written; null before, or when nothing in it was speech. */
  documentId: string | null;
}

/** One chunk of a session, as the owner reviews it. */
export interface RecordingChunkView {
  seq: number;
  startedAt: string;
  durationMs: number;
  status: RecordingChunkStatus;
  /** The microphone was taken from the recorder during the chunk. */
  interrupted: boolean;
  /** Whether the gateway still holds the chunk's audio. */
  audio: boolean;
  /** When kept audio is due to be deleted; null when none is kept, or the chunk is pending. */
  audioDeletedAt: string | null;
}

export type SetSpeakerOutcome = "set" | "missing" | "no-such-person";

export type AddParticipantOutcome = "added" | "missing" | "no-such-person";

/** Lines of a speaker shown when the owner reviews who spoke. */
const SPEAKER_SAMPLES = 3;
const SAMPLE_CHARS = 160;

/** A session as the device opens it. */
export interface StartRecordingInput {
  id: string;
  title?: string;
  /** `explicit` when absent. */
  origin?: RecordingOrigin;
  startedAt: string;
  startedTimeZoneId?: string;
  startedUtcOffsetSeconds?: number;
  language?: string;
  deviceId?: string;
  /** Set by the authenticated ingress, never by client metadata. */
  allowVocabulary: boolean;
}

/** One uploaded chunk. */
export interface RecordingChunkInput {
  sessionId: string;
  seq: number;
  startedAt: string;
  durationMs: number;
  silent: boolean;
  interrupted: boolean;
  audio: Uint8Array | null;
  mimeType: string | null;
}

export type RecordingState = "recording" | "transcribing" | "done";

/** What a device sees of one of its sessions. */
export interface RecordingStatus {
  id: string;
  title: string | null;
  state: RecordingState;
  chunkCount: number | null;
  chunks: {
    received: number;
    pending: number;
    transcribed: number;
    failed: number;
    silent: number;
  };
  /** Whether the session's document is written and current. */
  projected: boolean;
}

export class RecordingTranscriptionService {
  private readonly deps: RecordingServiceDeps;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining: Promise<void> | null = null;
  private rerun = false;
  private disposed = false;

  constructor(deps: RecordingServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  /** Open a session. Idempotent per id: a retried start changes nothing. */
  async startSession(input: StartRecordingInput): Promise<{ created: boolean }> {
    const created = await this.deps.writeGate.createRecordingSession({
      id: input.id,
      deviceId: input.deviceId ?? null,
      title: input.title?.trim() || null,
      origin: input.origin ?? "explicit",
      startedAt: input.startedAt,
      startedTimeZoneId: input.startedTimeZoneId ?? null,
      startedUtcOffsetSeconds: input.startedUtcOffsetSeconds ?? null,
      language: input.language ?? null,
      allowVocabulary: input.allowVocabulary,
      createdAt: this.now().toISOString(),
    });
    if (created) {
      log.info(
        `Opened ${input.origin ?? "explicit"} recording ${input.id} (started ${input.startedAt})`,
      );
    }
    return { created };
  }

  /**
   * Store one chunk and queue it for the transcriber. Idempotent per
   * `(session, seq)`. `missing` when the session does not exist; `beyond`
   * when the device finished the session with fewer chunks than this seq.
   */
  async addChunk(input: RecordingChunkInput): Promise<InsertRecordingChunkOutcome> {
    const outcome = await this.deps.writeGate.insertRecordingChunk({
      ...input,
      receivedAt: this.now().toISOString(),
    });
    if (outcome === "stored") this.kick();
    return outcome;
  }

  /**
   * The device declares the session's chunk count. A repeat of the same
   * count is `already`; a different one, or one below a chunk already
   * stored, is `conflict`.
   */
  async finish(id: string, chunkCount: number, endedAt: string): Promise<FinishRecordingOutcome> {
    const outcome = await this.deps.writeGate.finishRecordingSession(
      id,
      chunkCount,
      endedAt,
      this.now().toISOString(),
    );
    if (outcome === "finished") {
      log.info(`Recording ${id} finished with ${chunkCount} chunks`);
      this.kick();
    }
    return outcome;
  }

  /**
   * Record a moment the owner marked during session `sessionId`, whose audio
   * was saved as note `noteId`. Idempotent; the session need not exist yet.
   */
  async mark(sessionId: string, noteId: string, markedAt: string): Promise<void> {
    if (await this.deps.writeGate.addRecordingMark({ sessionId, noteId, markedAt })) {
      log.info(`Marked a moment in recording ${sessionId} as note ${noteId}`);
      this.kick();
    }
  }

  status(id: string): RecordingStatus | null {
    const session = getRecordingSession(this.deps.readDb, id);
    if (!session) return null;
    const counts = countRecordingChunks(this.deps.readDb, id);
    const received = counts.pending + counts.transcribed + counts.failed + counts.silent;
    const projected =
      session.projectedRevision !== null && session.projectedRevision >= session.revision;
    const state: RecordingState =
      session.finishedAt === null ? "recording" : projected ? "done" : "transcribing";
    return {
      id,
      title: session.title,
      state,
      chunkCount: session.chunkCount,
      chunks: { received, ...counts },
      projected,
    };
  }

  /** The most recently started sessions, newest first. */
  recent(limit: number): RecordingSummary[] {
    return listRecentRecordingSessions(this.deps.readDb, limit).map((session) =>
      this.summarize(session),
    );
  }

  /** One session as the list shows it, or null when it does not exist. */
  summary(id: string): RecordingSummary | null {
    const session = getRecordingSession(this.deps.readDb, id);
    return session ? this.summarize(session) : null;
  }

  private summarize(session: RecordingSession): RecordingSummary {
    const speakers = listRecordingSpeakers(this.deps.readDb, session.id);
    const status = this.status(session.id);
    return {
      id: session.id,
      title: recordingTitle(session),
      startedAt: session.startedAt,
      state: status?.state ?? "recording",
      chunkCount: session.chunkCount,
      chunks: status?.chunks ?? { received: 0, pending: 0, transcribed: 0, failed: 0, silent: 0 },
      durationMs: sumRecordingChunkDurations(this.deps.readDb, session.id),
      speakers: speakers.length,
      namedSpeakers: speakers.filter((s) => s.isSelf || s.personId || s.name).length,
      documentId: findDocumentIdBySourceExternalId(
        this.deps.readDb,
        OMNESIS_RECORDINGS_SOURCE_ID,
        session.id,
      ),
    };
  }

  /** A session's chunks in recording order, or null when the session does not exist. */
  chunks(id: string): RecordingChunkView[] | null {
    if (!getRecordingSession(this.deps.readDb, id)) return null;
    const keepMs = this.keepAudioDays() * DAY_MS;
    return listRecordingChunks(this.deps.readDb, id).map((chunk) => ({
      seq: chunk.seq,
      startedAt: chunk.startedAt,
      durationMs: chunk.durationMs,
      status: chunk.status,
      interrupted: chunk.interrupted,
      audio: chunk.hasAudio,
      audioDeletedAt:
        chunk.hasAudio && chunk.status !== "pending" && chunk.settledAt !== null
          ? new Date(Date.parse(chunk.settledAt) + keepMs).toISOString()
          : null,
    }));
  }

  /** A settled chunk's kept audio, or null when the gateway holds none. */
  chunkAudio(id: string, seq: number): { audio: Uint8Array<ArrayBuffer>; mimeType: string } | null {
    const chunk = getRecordingChunk(this.deps.readDb, id, seq);
    // A pending chunk's audio is the transcriber's until it settles.
    if (!chunk || chunk.status === "pending" || !chunk.hasAudio) return null;
    const audio = readRecordingChunkAudio(this.deps.readDb, id, seq);
    if (!audio) return null;
    return { audio: new Uint8Array(audio), mimeType: chunk.mimeType ?? "application/octet-stream" };
  }

  /** A session's speakers with what each said, or null when the session does not exist. */
  speakers(id: string): RecordingSpeakerView[] | null {
    if (!getRecordingSession(this.deps.readDb, id)) return null;
    const identities = this.speakerIdentities(id);
    const matched = new Set(
      listRecordingSpeakers(this.deps.readDb, id)
        .filter((s) => s.isSelf && s.selfMatch === "matched")
        .map((s) => s.speaker),
    );
    const talk = new Map<number, number>();
    const samples = new Map<number, string[]>();
    for (const chunk of listRecordingChunks(this.deps.readDb, id)) {
      for (const w of chunk.voices ?? []) {
        if (w.speaker !== undefined) {
          talk.set(w.speaker, (talk.get(w.speaker) ?? 0) + (w.endMs - w.startMs));
        }
      }
      for (const turn of speakerTurns(chunk.segments ?? [], chunk.voices ?? [])) {
        if (turn.speaker === undefined) continue;
        const list = samples.get(turn.speaker) ?? [];
        if (list.length < SPEAKER_SAMPLES) {
          list.push(
            turn.text.length > SAMPLE_CHARS
              ? `${turn.text.slice(0, SAMPLE_CHARS - 1)}…`
              : turn.text,
          );
          samples.set(turn.speaker, list);
        }
      }
    }
    return identities.map((s) => ({
      ...s,
      talkMs: talk.get(s.speaker) ?? 0,
      samples: samples.get(s.speaker) ?? [],
      selfMatched: matched.has(s.speaker),
    }));
  }

  /** The owner's enrolled voice and whether it can be used. */
  selfVoiceStatus(): SelfVoiceStatus {
    const profile = getRecordingVoiceProfile(this.deps.readDb);
    const separator = this.deps.voices?.() ?? null;
    return {
      setting: this.selfVoiceSetting(),
      ready: separator !== null,
      minSpeechMs: MIN_ENROLMENT_SPEECH_MS,
      profile: profile
        ? {
            enrolledAt: profile.enrolledAt,
            speechMs: profile.speechMs,
            // Without a separator nothing is compared, so nothing says it is stale.
            current: separator === null || separator.model === profile.model,
          }
        : null,
    };
  }

  /**
   * Enrol the owner's voice from a clip of them reading aloud, replacing any
   * enrolled before. The clip's audio and its window vectors are dropped
   * here; only their mean is kept.
   */
  async enrollSelfVoice(audio: Uint8Array, mimeType: string): Promise<EnrollSelfVoiceOutcome> {
    if (this.selfVoiceSetting() !== "match") return { kind: "off" };
    const separator = this.deps.voices?.() ?? null;
    if (!separator) return { kind: "unavailable" };
    let separated: SeparatedVoices;
    try {
      separated = await separator.separate(audio, mimeType);
    } catch (err) {
      log.warn(`Voice enrolment not read: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "unreadable" };
    }
    const durations = separated.windows.map((w) => w.endMs - w.startMs);
    const total = durations.reduce((sum, d) => sum + d, 0);
    if (total < MIN_ENROLMENT_SPEECH_MS) return { kind: "too-short", speechMs: total };
    let labels: number[];
    try {
      labels = await separator.group(separated.vectors, durations);
    } catch (err) {
      log.warn(`Voice enrolment not grouped: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "unavailable" };
    }
    // The clip's main voice; a stray window of someone else, or of noise, is left out.
    const talk = new Map<number, number>();
    labels.forEach((l, i) => talk.set(l, (talk.get(l) ?? 0) + durations[i]!));
    const [main, mainMs] = [...talk].reduce((a, b) => (b[1] > a[1] ? b : a));
    if (mainMs < total * ENROLMENT_MAIN_VOICE_SHARE) return { kind: "several-voices" };
    if (mainMs < MIN_ENROLMENT_SPEECH_MS) return { kind: "too-short", speechMs: mainMs };
    await this.deps.writeGate.setRecordingVoiceProfile({
      model: separator.model,
      vector: meanVoice(separated.vectors.filter((_, i) => labels[i] === main)),
      speechMs: mainMs,
      enrolledAt: this.now().toISOString(),
    });
    log.info(
      `Enrolled the owner's voice: ${Math.round(mainMs / 1000)}s of speech (${separator.model})`,
    );
    return { kind: "enrolled", status: this.selfVoiceStatus() };
  }

  /** Delete the owner's enrolled voice. False when none was enrolled. */
  async deleteSelfVoice(): Promise<boolean> {
    const deleted = await this.deps.writeGate.deleteRecordingVoiceProfile();
    if (deleted) log.info("Deleted the owner's enrolled voice");
    return deleted;
  }

  private selfVoiceSetting(): SelfVoiceSetting {
    return this.deps.selfVoice?.() === "match" ? "match" : "off";
  }

  /** Say who one speaker of a session is; its document is written again. */
  async setSpeaker(
    id: string,
    speaker: number,
    mapping: RecordingSpeakerMapping,
  ): Promise<SetSpeakerOutcome> {
    if (
      mapping.kind === "person" &&
      !getPersonNames(this.deps.readDb, [mapping.personId]).has(mapping.personId)
    ) {
      return "no-such-person";
    }
    const set = await this.deps.writeGate.setRecordingSpeaker(id, speaker, mapping);
    if (!set) return "missing";
    this.kick();
    return "set";
  }

  /**
   * Who the owner says was present without a speaking turn of their own, or
   * null when the session does not exist.
   */
  participants(id: string): ParticipantIdentity[] | null {
    if (!getRecordingSession(this.deps.readDb, id)) return null;
    return this.participantIdentities(id);
  }

  /** Add someone who was present; the document is written again. */
  async addParticipant(
    id: string,
    participant: NewRecordingParticipant,
  ): Promise<AddParticipantOutcome> {
    if (
      "personId" in participant &&
      !getPersonNames(this.deps.readDb, [participant.personId]).has(participant.personId)
    ) {
      return "no-such-person";
    }
    const added = await this.deps.writeGate.addRecordingParticipant(
      id,
      participant,
      this.now().toISOString(),
    );
    if (!added) return "missing";
    this.kick();
    return "added";
  }

  /** Remove a participant; false when the session has no such participant. */
  async removeParticipant(id: string, key: string): Promise<boolean> {
    const removed = await this.deps.writeGate.removeRecordingParticipant(id, key);
    if (removed) this.kick();
    return removed;
  }

  /** Give a session the owner's title, or clear it (null); its document is written again. */
  async setTitle(id: string, title: string | null): Promise<boolean> {
    const set = await this.deps.writeGate.setRecordingTitle(id, title?.trim() || null);
    if (set) this.kick();
    return set;
  }

  /** Stop offering one suggestion for a session. False when the session does not exist. */
  async dismissSuggestion(id: string, key: string): Promise<boolean> {
    return this.deps.writeGate.dismissRecordingSuggestion(id, key, this.now().toISOString());
  }

  /**
   * Who likely took part in a session and what it was, from the owner's
   * calendar and from names heard in the transcript. Null when the session
   * does not exist. A calendar that cannot be read leaves only the mentions.
   */
  async suggestions(id: string): Promise<RecordingSuggestions | null> {
    const session = getRecordingSession(this.deps.readDb, id);
    if (!session) return null;
    const chunks = listRecordingChunks(this.deps.readDb, id);
    const speakers = this.speakerIdentities(id);

    const start = Date.parse(session.startedAt);
    const recordedEnd = start + chunks.reduce((sum, c) => sum + c.durationMs, 0);
    const declaredEnd = session.endedAt ? Date.parse(session.endedAt) : Number.NaN;
    const end = Math.max(
      Number.isFinite(declaredEnd) ? declaredEnd : recordedEnd,
      start + MIN_WINDOW_MS,
    );
    let events: CalendarEventCandidate[] = [];
    if (this.deps.calendarEvents) {
      try {
        events = await this.deps.calendarEvents(
          new Date(start).toISOString(),
          new Date(end).toISOString(),
        );
      } catch (err) {
        log.warn(
          `Recording ${id}: calendar not read for suggestions: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // The event that shares most of the recording's time comes first.
    const overlap = (e: CalendarEventCandidate) =>
      Math.min(end, Date.parse(e.end)) - Math.max(start, Date.parse(e.start));
    events = events.filter((e) => overlap(e) > 0).sort((a, b) => overlap(b) - overlap(a));

    const turns: SuggestionTurn[] = [];
    for (const chunk of chunks) {
      for (const turn of speakerTurns(chunk.segments ?? [], chunk.voices ?? [])) {
        turns.push({
          ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
          text: turn.text,
        });
      }
    }
    const names = new Map<string, ReturnType<typeof resolveGivenName>>();
    return {
      suggestions: buildSuggestions({
        title: session.title,
        turns,
        events,
        namedSpeakers: new Set(
          speakers.filter((s) => s.isSelf || s.personId || s.name).map((s) => s.speaker),
        ),
        mappedPeople: new Set(speakers.flatMap((s) => (s.personId ? [s.personId] : []))),
        presentPeople: new Set(
          listRecordingParticipants(this.deps.readDb, id).flatMap((p) =>
            p.personId ? [p.personId] : [],
          ),
        ),
        dismissed: listDismissedRecordingSuggestions(this.deps.readDb, id),
        resolveName: (name) => {
          const key = name.toLowerCase();
          if (!names.has(key)) names.set(key, resolveGivenName(this.deps.readDb, name));
          return names.get(key)!;
        },
      }),
    };
  }

  /** Delete a session, its chunks and its document. False when it did not exist. */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.deps.writeGate.deleteRecordingSession(id);
    await this.deps.deleteDocument(id);
    if (deleted) log.info(`Deleted recording ${id}`);
    return deleted;
  }

  /** Start the background loop; it also picks up work left before a restart. */
  start(): void {
    if (this.timer || this.disposed) return;
    this.timer = setInterval(() => this.kick(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    this.kick();
  }

  /** Run a pass now, or right after the one in progress. */
  kick(): void {
    if (this.disposed) return;
    if (this.draining) {
      this.rerun = true;
      return;
    }
    this.draining = this.pass()
      .catch((err) => {
        log.warn(`Recording pass failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.draining = null;
        if (this.rerun && !this.disposed) {
          this.rerun = false;
          this.kick();
        }
      });
  }

  /** Resolves once no pass is running (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async pass(): Promise<void> {
    if (this.selfVoiceSetting() === "off" && getRecordingVoiceProfile(this.deps.readDb)) {
      await this.deleteSelfVoice();
    }
    await this.finishAbandoned();
    await this.purgeExpiredAudio();
    for (;;) {
      if (this.disposed) return;
      const [next] = listDueRecordingChunks(this.deps.readDb, this.now().toISOString(), 1);
      if (!next) break;
      try {
        await this.process(next);
      } catch (err) {
        // A throw must not leave the chunk at the head of the queue: count
        // it as a failed attempt so it backs off and is eventually given up.
        log.warn(
          `Recording ${next.sessionId} chunk ${next.seq} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.retryLater(next);
      }
      // Write a session out as soon as its last chunk settles, not after the
      // whole backlog of every other session.
      await this.projectReady();
    }
    await this.projectReady();
  }

  /** Days the audio is kept, within bounds whatever the setting says. */
  private keepAudioDays(): number {
    const days = this.deps.keepAudioDays?.() ?? 0;
    if (!Number.isFinite(days) || days <= 0) return 0;
    return Math.min(Math.floor(days), MAX_KEEP_AUDIO_DAYS);
  }

  /** How a chunk settled now is settled: its time, and whether its audio stays. */
  private settling(): { settledAt: string; keepAudio: boolean } {
    return { settledAt: this.now().toISOString(), keepAudio: this.keepAudioDays() > 0 };
  }

  private async purgeExpiredAudio(): Promise<void> {
    const purged = await this.deps.writeGate.purgeRecordingAudio(
      this.later(-this.keepAudioDays() * DAY_MS),
    );
    if (purged > 0) log.info(`Deleted the kept audio of ${purged} recording chunks`);
  }

  private async finishAbandoned(): Promise<void> {
    const idleBefore = this.later(-ABANDONED_AFTER_MS);
    for (const session of listAbandonedRecordingSessions(
      this.deps.readDb,
      idleBefore,
      SWEEP_BATCH,
    )) {
      const finished = await this.deps.writeGate.abandonRecordingSession(
        session.id,
        this.now().toISOString(),
      );
      if (finished) {
        log.info(
          `Finished recording ${session.id} for its device: idle since ${session.lastActivityAt}`,
        );
      }
    }
  }

  private async projectReady(): Promise<void> {
    const missingCutoff = this.later(-MISSING_GRACE_MS);
    // Each session at most once per call: one changed again meanwhile comes
    // round on the next pass rather than holding this one.
    const done = new Set<string>();
    for (;;) {
      if (this.disposed) return;
      const ready = listUnprojectedRecordingSessions(
        this.deps.readDb,
        missingCutoff,
        SWEEP_BATCH,
      ).filter((session) => !done.has(session.id));
      if (ready.length === 0) return;
      for (const session of ready) {
        done.add(session.id);
        try {
          await this.project(session.id);
        } catch (err) {
          // Left unprojected: the next pass tries it again, and the other
          // sessions are not held behind it.
          log.warn(
            `Recording ${session.id} not written: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  private async project(sessionId: string): Promise<void> {
    // The revision is read with the session, before the chunks: a change
    // landing after this read bumps it past the one recorded below, and the
    // session comes round again.
    const session = getRecordingSession(this.deps.readDb, sessionId);
    if (!session) return;
    await this.groupVoices(sessionId);
    const chunks = listRecordingChunks(this.deps.readDb, sessionId);
    const marks = listRecordingMarks(this.deps.readDb, sessionId);
    const doc = this.deps.buildDocument(
      session,
      chunks,
      marks,
      this.speakerIdentities(sessionId),
      this.participantIdentities(sessionId),
    );
    if (doc) await this.deps.ingest([doc]);
    else await this.deps.deleteDocument(sessionId);
    // A delete that landed while the document was written must not leave
    // the document behind.
    if (!getRecordingSession(this.deps.readDb, sessionId)) {
      await this.deps.deleteDocument(sessionId);
      return;
    }
    await this.deps.writeGate.markRecordingSessionProjected(sessionId, session.revision);
    log.info(
      doc
        ? `Wrote recording ${sessionId}: ${chunks.length} chunks, ${doc.content.length} chars`
        : `Recording ${sessionId} has no speech; no document`,
    );
  }

  /**
   * Group the voices of chunks not grouped yet into the session's speakers
   * and delete their vectors. Speakers found in chunks that arrive after an
   * earlier grouping are numbered after the existing ones: their vectors
   * cannot be compared with deleted ones. Without a separator, or when
   * grouping fails, the vectors are deleted all the same and those windows
   * stay without a speaker — vectors never wait for a later attempt.
   */
  private async groupVoices(sessionId: string): Promise<void> {
    const ungrouped = listUngroupedRecordingVoices(this.deps.readDb, sessionId);
    if (ungrouped.length === 0) return;
    const separator = this.deps.voices?.() ?? null;
    let labels: number[] | null = null;
    const vectors = ungrouped.flatMap((c) => c.vectors);
    if (separator) {
      try {
        labels = await separator.group(
          vectors,
          ungrouped.flatMap((c) => c.windows.map((w) => w.endMs - w.startMs)),
        );
      } catch (err) {
        log.warn(
          `Recording ${sessionId}: voices not grouped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const base = Math.max(
      0,
      ...listRecordingSpeakers(this.deps.readDb, sessionId).map((s) => s.speaker),
    );
    let i = 0;
    const chunks = ungrouped.map(({ seq, windows }) => ({
      seq,
      windows: windows.map((w): VoiceWindow => {
        const label = labels?.[i++];
        return label === undefined
          ? { startMs: w.startMs, endMs: w.endMs }
          : { ...w, speaker: base + label + 1 };
      }),
    }));
    const self =
      labels && separator ? this.recogniseSelf(sessionId, separator, vectors, labels) : null;
    await this.deps.writeGate.assignRecordingVoices(
      sessionId,
      chunks,
      self === null ? [] : [base + self + 1],
    );
  }

  /** The label of this grouping that is the owner by their enrolled voice, if any. */
  private recogniseSelf(
    sessionId: string,
    separator: VoiceSeparator,
    vectors: readonly Float32Array[],
    labels: readonly number[],
  ): number | null {
    if (this.selfVoiceSetting() !== "match") return null;
    const profile = getRecordingVoiceProfile(this.deps.readDb);
    if (!profile || profile.model !== separator.model) return null;
    if (hasRejectedSelfMatch(this.deps.readDb, sessionId)) return null;
    const match = matchSelf(vectors, labels, profile.vector);
    if (match) {
      log.info(
        `Recording ${sessionId}: recognised the owner's voice (similarity ${match.similarity.toFixed(2)})`,
      );
    }
    return match?.label ?? null;
  }

  /** The session's speakers, with the names of the people they are mapped to. */
  private speakerIdentities(sessionId: string): SpeakerIdentity[] {
    const speakers = listRecordingSpeakers(this.deps.readDb, sessionId);
    const names = getPersonNames(
      this.deps.readDb,
      speakers.flatMap((s) => (s.personId ? [s.personId] : [])),
    );
    return speakers.map((s) => ({
      speaker: s.speaker,
      isSelf: s.isSelf,
      personId: s.personId,
      name: s.personId ? (names.get(s.personId) ?? s.name) : s.name,
    }));
  }

  /** The session's participants without a turn, with the names of their people. */
  private participantIdentities(sessionId: string): ParticipantIdentity[] {
    const participants = listRecordingParticipants(this.deps.readDb, sessionId);
    const names = getPersonNames(
      this.deps.readDb,
      participants.flatMap((p) => (p.personId ? [p.personId] : [])),
    );
    return participants.map((p) => ({
      key: p.key,
      personId: p.personId,
      name: p.personId ? (names.get(p.personId) ?? null) : p.name,
    }));
  }

  /** The chunk's voices, or none when there is no separator or it fails on this audio. */
  private async separateVoices(
    chunk: RecordingChunk,
    audio: Uint8Array,
  ): Promise<SeparatedVoices | null> {
    const separator = this.deps.voices?.() ?? null;
    if (!separator) return null;
    try {
      return await separator.separate(audio, chunk.mimeType ?? "application/octet-stream");
    } catch (err) {
      log.warn(
        `Recording ${chunk.sessionId} chunk ${chunk.seq}: voices not separated: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async process(chunk: RecordingChunk): Promise<void> {
    const age = this.now().getTime() - Date.parse(chunk.receivedAt);
    const readiness = await this.deps.readiness();
    if (!readiness.runnable) {
      if (age >= MAX_AGE_MS) return this.giveUp(chunk, "no transcriber could run");
      return this.deps.writeGate.rescheduleRecordingChunk(
        chunk.sessionId,
        chunk.seq,
        chunk.attempts,
        this.later(UNAVAILABLE_RECHECK_MS),
      );
    }

    const audio = readRecordingChunkAudio(this.deps.readDb, chunk.sessionId, chunk.seq);
    const session = getRecordingSession(this.deps.readDb, chunk.sessionId);
    if (!audio || !session) return this.giveUp(chunk, "its audio is gone");
    const voices = await this.separateVoices(chunk, audio);
    const outcome = await this.deps.transcribe(
      audio,
      chunk.mimeType ?? "application/octet-stream",
      {
        priority: "background",
        ...(session.language ? { language: session.language } : {}),
        minTimeoutMs: PATIENCE_MS[Math.min(chunk.attempts, PATIENCE_MS.length - 1)],
        allowVocabulary: session.allowVocabulary,
        segments: true,
        context: {
          purpose: "source-audio",
          recordedAt: chunk.startedAt,
          ...(session.language ? { languageHints: [session.language] } : {}),
        },
      },
    );
    // The session may have been deleted while this chunk was transcribed.
    if (!getRecordingChunk(this.deps.readDb, chunk.sessionId, chunk.seq)) return;

    switch (outcome.kind) {
      case "transcribed":
        await this.deps.writeGate.settleRecordingChunk(
          chunk.sessionId,
          chunk.seq,
          {
            status: "transcribed",
            text: outcome.result.text.trim(),
            ...(outcome.result.segments ? { segments: outcome.result.segments } : {}),
            ...(voices && voices.windows.length > 0 ? { voices } : {}),
          },
          this.settling(),
        );
        return;
      case "unreadable":
        // No retry turns bytes that decode to no audio into speech.
        return this.giveUp(chunk, "its audio could not be decoded");
      case "unavailable":
      case "cancelled":
        // Not the chunk's fault: try again later without spending an attempt.
        if (age >= MAX_AGE_MS) return this.giveUp(chunk, "no transcriber could run");
        return this.deps.writeGate.rescheduleRecordingChunk(
          chunk.sessionId,
          chunk.seq,
          chunk.attempts,
          this.later(UNAVAILABLE_RECHECK_MS),
        );
      case "failed":
        return this.retryLater(chunk);
      default:
        assertNever(outcome);
    }
  }

  /** Count a failed attempt: back off, or give up once out of attempts or time. */
  private async retryLater(chunk: RecordingChunk): Promise<void> {
    const attempts = chunk.attempts + 1;
    const age = this.now().getTime() - Date.parse(chunk.receivedAt);
    if (attempts >= MAX_ATTEMPTS || age >= MAX_AGE_MS) {
      return this.giveUp(chunk, `${attempts} attempts failed`);
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
    await this.deps.writeGate.rescheduleRecordingChunk(
      chunk.sessionId,
      chunk.seq,
      attempts,
      this.later(delay),
    );
  }

  private async giveUp(chunk: RecordingChunk, why: string): Promise<void> {
    await this.deps.writeGate.settleRecordingChunk(
      chunk.sessionId,
      chunk.seq,
      { status: "failed" },
      this.settling(),
    );
    log.warn(`Recording ${chunk.sessionId} chunk ${chunk.seq} not transcribed (${why})`);
  }

  private later(ms: number): string {
    return new Date(this.now().getTime() + ms).toISOString();
  }
}
