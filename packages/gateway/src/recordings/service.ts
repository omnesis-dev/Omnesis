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
 *
 * An all-day (`ambient`) session is split into conversations at long
 * silences (`conversationGapMs`, see `conversations.ts`). Each conversation
 * is written as soon as it closes, with its own voices grouped and their
 * vectors deleted then, while the session is still open; the first keeps the
 * session's document id. A session that is one conversation stays one
 * document, as it always was.
 */

import { assertNever, createLogger } from "@omnesis/core";
import { findDocumentIdBySourceExternalId } from "../data/repositories/DocumentRepository.js";
import { getPersonNames } from "../data/repositories/PersonRepository.js";
import {
  OMNESIS_RECORDINGS_SOURCE_ID,
  conversationExternalId,
} from "../sources/omnesis-recordings/index.js";
import {
  localStart,
  recordingTitle,
  speakersHeard,
  speakerTurns,
} from "../sources/omnesis-recordings/render.js";
import { closeConversations, type ConversationSpan } from "./conversations.js";
import {
  listRecentRecordingSessions,
  listOpenAmbientRecordingSessions,
  listRecordingConversations,
  listUnprojectedOpenRecordingSessions,
  type RecordingConversation,
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
  type RecordingVoiceProfile,
} from "./storage.js";
import {
  buildSuggestions,
  type CalendarEventCandidate,
  type RecordingSuggestion,
} from "./suggestions.js";
import { matchSelf, meanVoice } from "./voices/voices.js";
import type {
  ConversationPart,
  ParticipantIdentity,
  SpeakerIdentity,
} from "../sources/omnesis-recordings/index.js";
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
/** The silence that ends a conversation of an all-day session, unless configured. */
export const DEFAULT_CONVERSATION_GAP_SECONDS = 90;
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
    | "closeRecordingConversations"
    | "setRecordingConversationTitle"
    | "markRecordingConversationProjected"
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
  /**
   * Renders a session, or one conversation of it, into its document; null
   * when there is nothing to keep.
   */
  buildDocument: (
    session: RecordingSession,
    chunks: readonly RecordingChunk[],
    marks: readonly RecordingMark[],
    speakers: readonly SpeakerIdentity[],
    participants: readonly ParticipantIdentity[],
    conversation?: ConversationPart,
  ) => DocumentInput | null;
  /** The voice separator, or null while speakers are not told apart. */
  voices?: () => VoiceSeparator | null;
  voicesReady?: () => Promise<import("./voices/loader.js").VoiceSeparatorReadiness>;
  voicesRevision?: () => number;
  /**
   * Days a chunk's audio is kept once it is settled; 0 (the default) drops
   * it at once. Read on every pass, so a changed setting applies without a
   * restart, and lowering it drops what is now past it.
   */
  keepAudioDays?: () => number;
  /** Installed restore gate: unreadable/indeterminate state refuses background work. */
  reviewRequired?: () => boolean;
  /**
   * Whether the owner's enrolled voice is recognised among a session's
   * speakers; `off` (the default) also deletes it. Read on every pass.
   */
  selfVoice?: () => SelfVoiceSetting;
  /**
   * Silence after which an all-day session's conversation is closed and
   * written while the session goes on; 0 (the default) never splits. Read on
   * every pass.
   */
  conversationGapMs?: () => number;
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
  /** The conversation they spoke in, when the session was split; null otherwise. */
  conversation: number | null;
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
  | { kind: "several-voices" }
  /**
   * The voice was deleted, the setting switched off and on, or a later
   * enrolment stored its voice while this clip was being read: nothing was
   * stored.
   */
  | { kind: "superseded" };

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
  reviewRequired?: true;
  /** The chunk count the device declared; null while it records. */
  chunkCount: number | null;
  chunks: RecordingStatus["chunks"];
  /** The recorded time of the chunks received, ms. */
  durationMs: number;
  speakers: number;
  /** Speakers the owner has said who they are. */
  namedSpeakers: number;
  /**
   * The session's document, once written; null before, or when nothing in it
   * was speech. For a split session, its first conversation's.
   */
  documentId: string | null;
  /** The conversations an all-day session was split into; empty when it is one. */
  conversations: RecordingConversationView[];
}

/** One conversation of a split session. */
export interface RecordingConversationView {
  n: number;
  title: string;
  /** Whether the owner gave the title. */
  titled: boolean;
  startedAt: string;
  endedAt: string;
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
  reviewRequired?: true;
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
  /** Deletions of the owner's voice, and the setting switched off, so far. */
  private selfVoiceRevocations = 0;
  /** Enrolments started so far; each is numbered in the order it started. */
  private selfVoiceEnrolments = 0;
  /** The number of the enrolment whose voice was stored last. */
  private selfVoiceStored = 0;
  /** The tail of the self-voice writes, which run one at a time. */
  private selfVoiceQueue: Promise<unknown> = Promise.resolve();

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
      ...(this.reviewRequired() ? { reviewRequired: true as const } : {}),
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
    const conversations = listRecordingConversations(this.deps.readDb, session.id);
    return {
      id: session.id,
      // A split session is the day's recording; its conversations carry the
      // time-based titles.
      title:
        conversations.length > 0 && !session.title?.trim()
          ? `All-day recording, ${localStart(session)}`
          : recordingTitle(session),
      startedAt: session.startedAt,
      state: status?.state ?? "recording",
      ...(this.reviewRequired() ? { reviewRequired: true as const } : {}),
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
      conversations: conversations.map((c) => ({
        n: c.n,
        title: conversationTitle(session, c),
        titled: Boolean(c.title?.trim()),
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        documentId: findDocumentIdBySourceExternalId(
          this.deps.readDb,
          OMNESIS_RECORDINGS_SOURCE_ID,
          conversationExternalId(session.id, c.n),
        ),
      })),
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
    const conversations = listRecordingConversations(this.deps.readDb, id);
    const talk = new Map<number, number>();
    const samples = new Map<number, string[]>();
    const spokeIn = new Map<number, number>();
    for (const chunk of listRecordingChunks(this.deps.readDb, id)) {
      for (const w of chunk.voices ?? []) {
        if (w.speaker !== undefined) {
          talk.set(w.speaker, (talk.get(w.speaker) ?? 0) + (w.endMs - w.startMs));
          const n = conversations.find((c) => chunk.seq >= c.firstSeq && chunk.seq <= c.lastSeq)?.n;
          if (n !== undefined && !spokeIn.has(w.speaker)) spokeIn.set(w.speaker, n);
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
      conversation: spokeIn.get(s.speaker) ?? null,
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
    if (this.disposed || this.reviewRequired()) return { kind: "unavailable" };
    const revision = this.deps.voicesRevision?.();
    const separator = this.deps.voices?.() ?? null;
    const current = () =>
      !this.disposed && !this.reviewRequired() && this.deps.voicesRevision?.() === revision;
    if (!separator || !current()) return { kind: "unavailable" };
    // Reading the clip takes a while; what happens meanwhile decides whether
    // its voice may still be stored (see storeSelfVoice).
    const admitted = {
      revocations: this.selfVoiceRevocations,
      enrolment: ++this.selfVoiceEnrolments,
      revision,
    };
    let separated: SeparatedVoices;
    try {
      separated = await separator.separate(audio, mimeType);
    } catch (err) {
      log.warn(`Voice enrolment not read: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "unreadable" };
    }
    if (!current()) return { kind: "unavailable" };
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
    if (!current()) return { kind: "unavailable" };
    // The clip's main voice; a stray window of someone else, or of noise, is left out.
    const talk = new Map<number, number>();
    labels.forEach((l, i) => talk.set(l, (talk.get(l) ?? 0) + durations[i]!));
    const [main, mainMs] = [...talk].reduce((a, b) => (b[1] > a[1] ? b : a));
    if (mainMs < total * ENROLMENT_MAIN_VOICE_SHARE) return { kind: "several-voices" };
    if (mainMs < MIN_ENROLMENT_SPEECH_MS) return { kind: "too-short", speechMs: mainMs };
    return this.storeSelfVoice(admitted, {
      model: separator.model,
      vector: meanVoice(separated.vectors.filter((_, i) => labels[i] === main)),
      speechMs: mainMs,
    });
  }

  /**
   * Store an enrolment's voice, admitted again at the write: one the owner
   * deleted, switched off or enrolled over since it started is refused, so an
   * older clip can never bring back a voice the owner removed. Runs in the
   * self-voice queue, so no deletion lands between the check and the write.
   */
  private storeSelfVoice(
    admitted: { revocations: number; enrolment: number; revision: number | undefined },
    voice: Omit<RecordingVoiceProfile, "enrolledAt">,
  ): Promise<EnrollSelfVoiceOutcome> {
    return this.inSelfVoiceQueue(async (): Promise<EnrollSelfVoiceOutcome> => {
      if (this.selfVoiceSetting() !== "match") return { kind: "off" };
      if (
        this.disposed ||
        this.reviewRequired() ||
        this.deps.voicesRevision?.() !== admitted.revision
      )
        return { kind: "unavailable" };
      if (
        this.selfVoiceRevocations !== admitted.revocations ||
        this.selfVoiceStored > admitted.enrolment
      ) {
        log.info("Voice enrolment not stored: the voice was deleted or enrolled again meanwhile");
        return { kind: "superseded" };
      }
      await this.deps.writeGate.setRecordingVoiceProfile({
        ...voice,
        enrolledAt: this.now().toISOString(),
      });
      this.selfVoiceStored = admitted.enrolment;
      log.info(
        `Enrolled the owner's voice: ${Math.round(voice.speechMs / 1000)}s of speech (${voice.model})`,
      );
      return { kind: "enrolled", status: this.selfVoiceStatus() };
    });
  }

  /**
   * Delete the owner's enrolled voice, and refuse every enrolment already
   * under way. False when none was enrolled.
   */
  deleteSelfVoice(): Promise<boolean> {
    // Counted at once, so an enrolment not yet at its write sees it.
    this.selfVoiceRevocations++;
    return this.inSelfVoiceQueue(async () => {
      const deleted = await this.deps.writeGate.deleteRecordingVoiceProfile();
      if (deleted) log.info("Deleted the owner's enrolled voice");
      return deleted;
    });
  }

  /** An automatic off-choice sweep cannot cross a pending restore review. */
  private deleteDisabledSelfVoice(): Promise<void> {
    return this.inSelfVoiceQueue(async () => {
      if (this.reviewRequired() || this.selfVoiceSetting() !== "off") return;
      this.selfVoiceRevocations++;
      const deleted = await this.deps.writeGate.deleteRecordingVoiceProfile();
      if (deleted) log.info("Deleted the owner's enrolled voice");
    });
  }

  /**
   * The operator changed `inference.recordings.selfVoice` to `setting`.
   * Switched off, the enrolled voice is deleted and every enrolment under way
   * is refused, even one that finishes after it is switched on again. It acts
   * on the change it is told of, not on the setting as it stands, so the
   * caller must tell it of each change as it takes effect (the gateway does,
   * from `ConfigStore.onCommit`): the refusal is then counted before anything
   * can see the setting on again, and the deletion is queued ahead of every
   * enrolment begun after that.
   */
  async selfVoiceSettingChanged(setting: SelfVoiceSetting): Promise<void> {
    if (setting !== "match") await this.deleteSelfVoice();
  }

  /** Runs self-voice writes one at a time, in the order they were asked for. */
  private inSelfVoiceQueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.selfVoiceQueue.then(op);
    this.selfVoiceQueue = run.catch(() => undefined);
    return run;
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

  /**
   * Give one conversation of a split session the owner's title, or clear it;
   * its document is written again. False when there is no such conversation.
   */
  async setConversationTitle(id: string, n: number, title: string | null): Promise<boolean> {
    const set = await this.deps.writeGate.setRecordingConversationTitle(
      id,
      n,
      title?.trim() || null,
    );
    if (set) this.kick();
    return set;
  }

  /** Stop offering one suggestion for a session. False when the session does not exist. */
  async dismissSuggestion(id: string, key: string): Promise<boolean> {
    return this.deps.writeGate.dismissRecordingSuggestion(id, key, this.now().toISOString());
  }

  /**
   * Who likely took part in a session and what it was, from the owner's
   * calendar. Null when the session does not exist; a calendar that cannot
   * be read leaves none.
   */
  async suggestions(id: string, conversation?: number): Promise<RecordingSuggestions | null> {
    const session = getRecordingSession(this.deps.readDb, id);
    if (!session) return null;
    let chunks = listRecordingChunks(this.deps.readDb, id);
    const speakers = this.speakerIdentities(id);

    // One conversation of a split session is suggested for on its own: its
    // time and dismissals kept apart from the other conversations'.
    let start = Date.parse(session.startedAt);
    let title = session.title;
    let declaredEnd = session.endedAt ? Date.parse(session.endedAt) : Number.NaN;
    let prefix = "";
    if (conversation !== undefined) {
      const c = listRecordingConversations(this.deps.readDb, id).find((x) => x.n === conversation);
      if (!c) return null;
      chunks = chunks.filter((x) => x.seq >= c.firstSeq && x.seq <= c.lastSeq);
      start = Date.parse(c.startedAt);
      title = c.title;
      declaredEnd = Date.parse(c.endedAt);
      prefix = `c${c.n}:`;
    }
    const recordedEnd = start + chunks.reduce((sum, c) => sum + c.durationMs, 0);
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

    const voiced = speakersHeard(chunks);
    const dismissed = new Set(
      [...listDismissedRecordingSuggestions(this.deps.readDb, id)].flatMap((key) =>
        prefix ? (key.startsWith(prefix) ? [key.slice(prefix.length)] : []) : [key],
      ),
    );
    const suggestions = buildSuggestions({
      title,
      events,
      // Only who speaks in this conversation is already accounted for: someone
      // mapped in an earlier conversation is still suggested when they attend
      // this one.
      mappedPeople: new Set(
        speakers.flatMap((s) => (s.personId && voiced.has(s.speaker) ? [s.personId] : [])),
      ),
      // The people present without a turn are the session's, so they count
      // for every conversation of it.
      presentPeople: new Set(
        listRecordingParticipants(this.deps.readDb, id).flatMap((p) =>
          p.personId ? [p.personId] : [],
        ),
      ),
      dismissed,
    });
    return {
      suggestions: prefix
        ? suggestions.map((x) => ({ ...x, key: `${prefix}${x.key}` }))
        : suggestions,
    };
  }

  /** Delete a session, its chunks and its document. False when it did not exist. */
  async delete(id: string): Promise<boolean> {
    const conversations = listRecordingConversations(this.deps.readDb, id);
    const deleted = await this.deps.writeGate.deleteRecordingSession(id);
    await this.deleteDocuments(id, conversations);
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

  private reviewRequired(): boolean {
    if (!this.deps.reviewRequired) return false;
    try {
      return this.deps.reviewRequired() !== false;
    } catch {
      return true;
    }
  }

  private async pass(): Promise<void> {
    if (this.reviewRequired()) return;
    if (this.selfVoiceSetting() === "off" && getRecordingVoiceProfile(this.deps.readDb)) {
      await this.deleteDisabledSelfVoice();
    }
    if (this.reviewRequired()) return;
    await this.finishAbandoned();
    if (this.reviewRequired()) return;
    await this.purgeExpiredAudio();
    for (;;) {
      if (this.disposed || this.reviewRequired()) return;
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
        if (!this.reviewRequired()) await this.retryLater(next);
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
    if (this.reviewRequired()) return;
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
      if (this.reviewRequired()) return;
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
    if (this.disposed || this.reviewRequired()) return;
    await this.closeOpenConversations();
    if (this.disposed || this.reviewRequired()) return;
    const missingCutoff = this.later(-MISSING_GRACE_MS);
    // Each session at most once per call: one changed again meanwhile comes
    // round on the next pass rather than holding this one.
    const done = new Set<string>();
    for (;;) {
      if (this.disposed || this.reviewRequired()) return;
      const ready = [
        ...listUnprojectedRecordingSessions(this.deps.readDb, missingCutoff, SWEEP_BATCH),
        ...listUnprojectedOpenRecordingSessions(this.deps.readDb, SWEEP_BATCH),
      ].filter((session) => !done.has(session.id));
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

  /** The silence that closes a conversation; 0 when sessions are not split. */
  private conversationGapMs(): number {
    const ms = this.deps.conversationGapMs?.() ?? 0;
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  /**
   * Close the conversations of open all-day sessions that a long enough
   * silence has ended, so they are written while the session goes on.
   */
  private async closeOpenConversations(): Promise<void> {
    if (this.disposed || this.reviewRequired()) return;
    const gapMs = this.conversationGapMs();
    if (gapMs === 0) return;
    for (const session of listOpenAmbientRecordingSessions(this.deps.readDb, SWEEP_BATCH)) {
      if (this.disposed || this.reviewRequired()) return;
      const closed = listRecordingConversations(this.deps.readDb, session.id);
      const from = (closed.at(-1)?.lastSeq ?? -1) + 1;
      const spans = closeConversations(
        listRecordingChunks(this.deps.readDb, session.id, from),
        closed,
        gapMs,
      );
      if (spans.length === 0) continue;
      await this.deps.writeGate.closeRecordingConversations(
        session.id,
        spans,
        this.now().toISOString(),
      );
      if (this.disposed || this.reviewRequired()) return;
      for (const span of spans) {
        log.info(
          `Recording ${session.id}: conversation ${span.n} closed (chunks ${span.firstSeq}-${span.lastSeq})`,
        );
      }
    }
  }

  /**
   * The rest of a finished all-day session, closed as its last conversations.
   * A session the gateway never split, and that is one conversation, stays
   * one document as it always was.
   */
  private async closeFinalConversations(session: RecordingSession): Promise<void> {
    if (this.disposed || this.reviewRequired()) return;
    const gapMs = this.conversationGapMs();
    if (gapMs === 0 || session.origin !== "ambient" || session.finishedAt === null) return;
    const closed = listRecordingConversations(this.deps.readDb, session.id);
    const chunks = listRecordingChunks(this.deps.readDb, session.id);
    const lastSeq = Math.max((session.chunkCount ?? 0) - 1, ...chunks.map((c) => c.seq));
    let spans: ConversationSpan[] = closeConversations(chunks, closed, gapMs, { lastSeq });
    const last = closed.at(-1);
    if (spans.length === 0 && last && last.lastSeq < lastSeq) spans = [{ ...last, lastSeq }];
    if (closed.length === 0 && spans.length <= 1) return;
    await this.deps.writeGate.closeRecordingConversations(
      session.id,
      spans,
      this.now().toISOString(),
    );
  }

  private async project(sessionId: string): Promise<void> {
    if (this.disposed || this.reviewRequired()) return;
    const voiceRevision = this.deps.voicesRevision?.();
    const before = getRecordingSession(this.deps.readDb, sessionId);
    if (!before) return;
    await this.closeFinalConversations(before);
    if (this.disposed || this.reviewRequired() || this.deps.voicesRevision?.() !== voiceRevision)
      return;
    // The revision is read with the session, before the chunks: a change
    // landing after this read bumps it past the one recorded below, and the
    // session comes round again.
    const session = getRecordingSession(this.deps.readDb, sessionId);
    if (!session) return;
    const conversations = listRecordingConversations(this.deps.readDb, sessionId);
    if (conversations.length > 0) {
      await this.projectConversations(session, conversations);
      return;
    }
    if (!(await this.groupVoices(sessionId))) return;
    if (this.disposed || this.reviewRequired() || this.deps.voicesRevision?.() !== voiceRevision)
      return;
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
    if (this.disposed || this.reviewRequired() || this.deps.voicesRevision?.() !== voiceRevision)
      return;
    await this.deps.writeGate.markRecordingSessionProjected(sessionId, session.revision);
    log.info(
      doc
        ? `Wrote recording ${sessionId}: ${chunks.length} chunks, ${doc.content.length} chars`
        : `Recording ${sessionId} has no speech; no document`,
    );
  }

  /**
   * Write each closed conversation of a split session as its own document.
   * Its voices are grouped first, and only its own vectors deleted: the
   * conversation still open keeps its vectors until it closes. A conversation
   * whose document has not changed is not written again.
   */
  private async projectConversations(
    session: RecordingSession,
    conversations: readonly RecordingConversation[],
  ): Promise<void> {
    if (this.disposed || this.reviewRequired()) return;
    const voiceRevision = this.deps.voicesRevision?.();
    const changed = () => this.deps.voicesRevision?.() !== voiceRevision;
    const sessionId = session.id;
    for (const c of conversations) {
      if (!(await this.groupVoices(sessionId, { fromSeq: c.firstSeq, toSeq: c.lastSeq }))) return;
      if (this.disposed || this.reviewRequired() || changed()) return;
    }
    const chunks = listRecordingChunks(this.deps.readDb, sessionId);
    const speakers = this.speakerIdentities(sessionId);
    const participants = this.participantIdentities(sessionId);
    const marks = marksByConversation(
      listRecordingMarks(this.deps.readDb, sessionId),
      conversations,
      chunks,
      session.finishedAt !== null,
    );
    const lastN = session.finishedAt !== null ? conversations.at(-1)?.n : undefined;
    let written = 0;
    for (const c of conversations) {
      if (this.disposed || this.reviewRequired() || changed()) return;
      const doc = this.deps.buildDocument(
        session,
        chunks,
        marks.get(c.n) ?? [],
        speakers,
        participants,
        {
          n: c.n,
          firstSeq: c.firstSeq,
          lastSeq: c.lastSeq,
          startedAt: c.startedAt,
          title: c.title,
          last: c.n === lastN,
        },
      );
      const hash = doc?.contentHash ?? null;
      if (hash === c.contentHash) continue;
      if (doc) await this.deps.ingest([doc]);
      else await this.deps.deleteDocument(conversationExternalId(sessionId, c.n));
      // Honor owner deletion even when review/policy changed during this admitted ingest.
      if (!getRecordingSession(this.deps.readDb, sessionId)) {
        await this.deleteDocuments(sessionId, conversations);
        return;
      }
      if (this.disposed || this.reviewRequired() || changed()) return;
      await this.deps.writeGate.markRecordingConversationProjected(sessionId, c.n, hash);
      if (this.disposed || this.reviewRequired() || changed()) return;
      written += 1;
    }
    if (!getRecordingSession(this.deps.readDb, sessionId)) {
      await this.deleteDocuments(sessionId, conversations);
      return;
    }
    if (this.disposed || this.reviewRequired() || changed()) return;
    await this.deps.writeGate.markRecordingSessionProjected(sessionId, session.revision);
    if (written > 0) {
      log.info(`Wrote recording ${sessionId}: ${written} of ${conversations.length} conversations`);
    }
  }

  /** Drop a session's document, and each of its conversations'. */
  private async deleteDocuments(
    sessionId: string,
    conversations: readonly Pick<RecordingConversation, "n">[],
  ): Promise<void> {
    await this.deps.deleteDocument(sessionId);
    for (const c of conversations) {
      if (c.n > 1) await this.deps.deleteDocument(conversationExternalId(sessionId, c.n));
    }
  }

  /**
   * Group the voices of chunks not grouped yet into the session's speakers
   * and delete their vectors. Speakers found in chunks that arrive after an
   * earlier grouping are numbered after the existing ones: their vectors
   * cannot be compared with deleted ones. Without a separator, or when
   * grouping fails, the vectors are deleted all the same and those windows
   * stay without a speaker. A selected local separator still preparing or unavailable
   * leaves restored vectors pending instead; explicit off remains an owner choice.
   */
  private async groupVoices(
    sessionId: string,
    range?: { fromSeq: number; toSeq: number },
  ): Promise<boolean> {
    if (this.reviewRequired()) return false;
    const ungrouped = listUngroupedRecordingVoices(this.deps.readDb, sessionId, range);
    if (ungrouped.length === 0) return true;
    const revision = this.deps.voicesRevision?.();
    const readiness = await this.deps.voicesReady?.();
    if (
      this.reviewRequired() ||
      this.deps.voicesRevision?.() !== revision ||
      readiness === "superseded" ||
      readiness === "unavailable"
    )
      return false;
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
    if (this.reviewRequired() || this.deps.voicesRevision?.() !== revision) return false;
    const self =
      labels && separator ? this.recogniseSelf(sessionId, separator, vectors, labels) : null;
    await this.deps.writeGate.assignRecordingVoices(
      sessionId,
      chunks,
      self === null ? [] : [base + self + 1],
    );
    // The admitted assignment may complete; changed policy stops later automatic work.
    return !this.reviewRequired() && this.deps.voicesRevision?.() === revision;
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
    if (this.reviewRequired()) return null;
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
    const revision = this.deps.voicesRevision?.();
    const changed = () => this.deps.voicesRevision?.() !== revision;
    if ((await this.deps.voicesReady?.()) === "superseded" || this.reviewRequired() || changed())
      return;
    const age = this.now().getTime() - Date.parse(chunk.receivedAt);
    if (this.reviewRequired()) return;
    const readiness = await this.deps.readiness();
    if (this.reviewRequired() || changed()) return;
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
    if (this.reviewRequired() || changed()) return;
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
    if (this.reviewRequired() || changed()) return;
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
    if (this.reviewRequired()) return;
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
    if (this.reviewRequired()) return;
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

/** The title of one conversation: the owner's, or its local start. */
function conversationTitle(
  session: RecordingSession,
  c: Pick<RecordingConversation, "title" | "startedAt">,
): string {
  return recordingTitle({ ...session, title: c.title, startedAt: c.startedAt });
}

/**
 * Each mark goes to the last conversation that started at or before it, or to
 * the first. While the session is open, a mark after the end of its last
 * closed conversation waits for the conversation still going on.
 */
function marksByConversation(
  marks: readonly RecordingMark[],
  conversations: readonly RecordingConversation[],
  chunks: readonly RecordingChunk[],
  finished: boolean,
): Map<number, RecordingMark[]> {
  const out = new Map<number, RecordingMark[]>();
  const last = conversations.at(-1);
  const lastChunk = last ? chunks.find((c) => c.seq === last.lastSeq) : undefined;
  const closedUntil = lastChunk
    ? Date.parse(lastChunk.startedAt) + lastChunk.durationMs
    : Number.POSITIVE_INFINITY;
  for (const mark of marks) {
    const at = Date.parse(mark.markedAt);
    if (!finished && at > closedUntil) continue;
    const target =
      [...conversations].reverse().find((c) => Date.parse(c.startedAt) <= at) ?? conversations[0];
    if (!target) continue;
    out.set(target.n, [...(out.get(target.n) ?? []), mark]);
  }
  return out;
}
