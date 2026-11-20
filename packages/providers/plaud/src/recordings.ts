// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  AudioRejectedError,
  MAX_TRANSCRIBE_AUDIO_BYTES,
  createLogger,
  toErrorMessage,
  type AudioTranscribeFn,
} from "@omnesis/core";
import { SnapshotEnumeration } from "@omnesis/source-sdk";
import { SyncError, failureScopeOf, mayContinuePage } from "@omnesis/types";
import { PlaudLinkExpiredError } from "./client.js";
import { inlineContent, parseSummary, parseTranscript, selectContent } from "./content.js";
import { plaudTime, recordingToDocument } from "./normalizer.js";
import { memoryTranscriptCache } from "./transcript-cache.js";
import type { DocumentInput, ProviderId, SourceId, SyncIssue } from "@omnesis/types";
import type { StructuredSyncResult, SyncOptions } from "@omnesis/source-sdk";
import type { PlaudClient, PlaudListing } from "./client.js";
import type { TranscriptCache } from "./transcript-cache.js";
import type { PlaudSummary, TranscriptSegment } from "./content.js";
import type { RecordingTranscript } from "./normalizer.js";
import type { ContentItem, FileDetail, FileSummary } from "./schemas.js";
import type { PlaudRecordingsCursor } from "./types.js";

const log = createLogger("source:plaud-recordings");

/**
 * Recordings rendered per page. Each may be downloaded and transcribed, which
 * takes minutes for a long recording, so a page stays small: a page that
 * fails redoes only its own few.
 */
const PAGE_SIZE = 3;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Defensive bound, not a partial-enumeration policy: a listing past it fails
 * the page without advancing state or asserting absence.
 */
export const MAX_SNAPSHOT_ITEMS = 50_000;
const RECORDINGS_PARTITION = "recordings";

export interface PlaudRecordingsSourceOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  pageSize?: number;
  snapshotIntervalMs?: number;
  /** Where transcripts already made are kept. Defaults to memory. */
  transcripts?: TranscriptCache;
}

/**
 * One `conversation` document per Plaud recording.
 *
 * The transcript is the operator's own transcriber's, from the downloaded
 * audio, whenever one runs; the audio is held only while it is transcribed,
 * and the transcript is kept so a change that leaves the audio alone does not
 * transcribe it again. Plaud's transcript stands in when no transcriber is
 * available, when the recording is larger than the transcriber accepts, or
 * when the transcriber rejects it. See `PlaudRecordingsCursor` for how sweeps
 * are planned.
 */
export class PlaudRecordingsSource {
  private readonly now: () => string;
  private readonly pageSize: number;
  private readonly snapshotIntervalMs: number;
  private readonly transcripts: TranscriptCache;
  private devices: Promise<Map<string, string> | undefined> | undefined;

  constructor(
    private readonly client: PlaudClient,
    private readonly providerId: ProviderId,
    private readonly sourceId: SourceId,
    /** The account owner, named on every recording. */
    private readonly accountEmail: string,
    private readonly dataCutoff: string | undefined,
    private readonly transcribe: AudioTranscribeFn | undefined,
    opts: PlaudRecordingsSourceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.pageSize = opts.pageSize ?? PAGE_SIZE;
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS;
    this.transcripts = opts.transcripts ?? memoryTranscriptCache();
  }

  async syncStructured(
    cursor: PlaudRecordingsCursor | null,
    opts: SyncOptions = {},
  ): Promise<StructuredSyncResult<PlaudRecordingsCursor>> {
    const { signal } = opts;
    const syncedAt = this.now();
    const sweep = cursor?.pending
      ? resumeSweep(cursor)
      : await this.startSweep(cursor, syncedAt, signal);

    const batch = sweep.pending.slice(0, this.pageSize);
    const rest = sweep.pending.slice(this.pageSize);
    const known = { ...sweep.known };
    const documents: DocumentInput[] = [];
    const skipped = [...sweep.skipped];
    // Once the gateway says no transcriber can run, the rest of the sweep
    // does not download audio only to be told the same.
    const local = { available: this.transcribe !== undefined && !sweep.noTranscriber };

    for (const file of batch) {
      try {
        const { document, deviceMissing } = await this.render(file, local, signal);
        documents.push(document);
        // A recorder whose name could not be looked up is rendered again on
        // the next sync rather than left nameless until the recording changes.
        known[file.id] = deviceMissing
          ? `${fingerprint(file)}${DEVICE_MISSING}`
          : fingerprint(file);
      } catch (err) {
        // One recording Plaud cannot serve is that recording's problem: its
        // prior document stays, the rest of the page lands, and the next
        // sweep tries it again because its fingerprint is still unrecorded.
        if (!mayContinuePage(failureScopeOf(err))) throw err;
        log.warn(`Skipping Plaud recording ${file.id}: ${toErrorMessage(err)}`);
        skipped.push(file.id);
      }
    }
    const noTranscriber = this.transcribe !== undefined && !local.available;

    if (rest.length > 0) {
      return {
        documents,
        cursor: {
          known,
          pending: rest,
          ...(skipped.length > 0 ? { skipped } : {}),
          ...(noTranscriber ? { noTranscriber: true } : {}),
          ...(sweep.listingScope ? { listingScope: sweep.listingScope } : {}),
          ...(sweep.lastSnapshotAt ? { lastSnapshotAt: sweep.lastSnapshotAt } : {}),
          ...(sweep.enumeration ? { snapshot: sweep.enumeration.toLedger() } : {}),
        },
        hasMore: true,
      };
    }

    const presentIds = sweep.enumeration?.cover(RECORDINGS_PARTITION).result();
    if (presentIds !== undefined) {
      // Forget recordings that are gone, so a recording restored from the
      // trash is rendered again.
      const present = new Set(presentIds);
      for (const id of Object.keys(known)) if (!present.has(id)) delete known[id];
      await this.transcripts.prune(present);
    }
    return {
      documents,
      ...(presentIds !== undefined ? { presentExternalIds: presentIds } : {}),
      ...(skipped.length > 0
        ? { issues: skippedIssues(skipped) }
        : presentIds
          ? { issues: [] }
          : {}),
      cursor: {
        known,
        ...(sweep.listingScope ? { listingScope: sweep.listingScope } : {}),
        ...(sweep.lastSnapshotAt ? { lastSnapshotAt: sweep.lastSnapshotAt } : {}),
      },
      hasMore: false,
    };
  }

  /**
   * List every recording and plan the sweep: the recordings whose fingerprint
   * changed, and — when a snapshot is due and the listing can be trusted — the
   * ledger that names the rest present.
   */
  private async startSweep(
    cursor: PlaudRecordingsCursor | null,
    syncedAt: string,
    signal: AbortSignal | undefined,
  ): Promise<Sweep> {
    const listing = await this.client.listFiles(signal);
    if (listing.files.length > MAX_SNAPSHOT_ITEMS) {
      throw new SyncError(
        "unknown",
        `Plaud listed ${listing.files.length} recordings, past the ${MAX_SNAPSHOT_ITEMS} one source tracks`,
      );
    }
    const eligible = this.eligible(listing.files);
    const known = cursor?.known ?? {};
    const pending = eligible.filter((f) => known[f.id] !== fingerprint(f));

    const snapshotDue =
      !cursor?.lastSnapshotAt ||
      Date.parse(syncedAt) - Date.parse(cursor.lastSnapshotAt) >= this.snapshotIntervalMs;
    let enumeration: SnapshotEnumeration | undefined;
    if (snapshotDue) {
      const trusted = await this.trustedForAbsence(listing, cursor?.listingScope, signal);
      if (trusted) {
        enumeration = SnapshotEnumeration.resume([RECORDINGS_PARTITION], undefined).add(
          RECORDINGS_PARTITION,
          eligible.map((f) => f.id),
        );
      }
    }
    // A due snapshot counts as taken when the sweep starts, whether or not
    // its listing could vouch for absence: an untrusted one is retried a day
    // later rather than relisted on every tick.
    const lastSnapshotAt = snapshotDue ? syncedAt : cursor?.lastSnapshotAt;
    return {
      pending,
      known,
      enumeration,
      skipped: [],
      noTranscriber: false,
      listingScope: listing.scope,
      ...(lastSnapshotAt ? { lastSnapshotAt } : {}),
    };
  }

  /**
   * Whether a listing may say what is gone. It must be consistent, read under
   * the same scope as the last sweep's (a workspace token that could not be
   * minted lists through the user token, which may see other recordings), and
   * agree id for id with a second listing: offset paging over a live order
   * can lose one recording to a deletion and gain another from an insertion
   * on the same read, which no single listing can notice.
   */
  private async trustedForAbsence(
    listing: PlaudListing,
    priorScope: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    if (!listing.consistent) {
      log.warn("Plaud's recording listing changed while it was read; skipping deletions this time");
      return false;
    }
    if (priorScope !== undefined && priorScope !== listing.scope) {
      log.warn(
        `Plaud listed recordings as ${listing.scope}, not ${priorScope} as before; skipping deletions this time`,
      );
      return false;
    }
    const again = await this.client.listFiles(signal);
    const ids = new Set(listing.files.map((f) => f.id));
    const same =
      again.consistent &&
      again.scope === listing.scope &&
      again.files.length === ids.size &&
      again.files.every((f) => ids.has(f.id));
    if (!same) {
      log.warn("Two Plaud listings disagreed; skipping deletions this time");
    }
    return same;
  }

  private eligible(files: FileSummary[]): FileSummary[] {
    const cutoff = this.dataCutoff ? Date.parse(this.dataCutoff) : undefined;
    if (cutoff === undefined || !Number.isFinite(cutoff)) return files;
    return files.filter((f) => {
      const started = plaudTime(f.start_time);
      return started === undefined || Date.parse(started) >= cutoff;
    });
  }

  private async render(
    file: FileSummary,
    local: { available: boolean },
    signal: AbortSignal | undefined,
  ): Promise<{ document: DocumentInput; deviceMissing: boolean }> {
    let transcript = await this.localTranscript(file, local, signal);
    const plaud = await this.plaudContent(file, transcript === undefined, signal);
    transcript ??= plaud.segments ? { source: "plaud", segments: plaud.segments } : undefined;
    const devices = file.serial_number ? await this.deviceNames(signal) : undefined;
    const deviceName = file.serial_number ? devices?.get(file.serial_number) : undefined;
    const document = recordingToDocument(
      {
        file,
        ...(deviceName ? { deviceName } : {}),
        ...(transcript ? { transcript } : {}),
        ...(plaud.summary ? { summary: plaud.summary } : {}),
      },
      { providerId: this.providerId, sourceId: this.sourceId, accountEmail: this.accountEmail },
    );
    // Only a failed lookup is worth retrying; a serial the account's device
    // list does not name is not going to be named next time either.
    return { document, deviceMissing: Boolean(file.serial_number) && devices === undefined };
  }

  /**
   * The transcript the operator's transcriber made of this audio, from the
   * cache when the audio is unchanged since, else made now.
   */
  private async localTranscript(
    file: FileSummary,
    local: { available: boolean },
    signal: AbortSignal | undefined,
  ): Promise<RecordingTranscript | undefined> {
    if (!this.transcribe) return undefined;
    const key = audioKey(file);
    const cached = await this.transcripts.get(file.id, key);
    if (cached) {
      return {
        source: "local",
        text: cached.text,
        ...(cached.language ? { language: cached.language } : {}),
      };
    }
    if (!local.available) return undefined;
    const made = await this.transcribeLocally(file, local, signal);
    if (made?.source === "local") {
      await this.transcripts.set(file.id, {
        audioKey: key,
        text: made.text,
        ...(made.language ? { language: made.language } : {}),
      });
    }
    return made;
  }

  /**
   * The operator's transcriber's transcript, or `undefined` when Plaud's has
   * to stand in: the recording is too large to send, the transcriber rejected
   * it or heard no speech, or no transcriber can run.
   */
  private async transcribeLocally(
    file: FileSummary,
    local: { available: boolean },
    signal: AbortSignal | undefined,
  ): Promise<RecordingTranscript | undefined> {
    const audio = await this.client.downloadAudio(file.id, MAX_TRANSCRIBE_AUDIO_BYTES, signal);
    if ("tooLarge" in audio) {
      log.info(
        `Plaud recording ${file.id} is too large to transcribe here; using Plaud's transcript`,
      );
      return undefined;
    }
    try {
      const recordedAt = plaudTime(file.start_time);
      const result = await this.transcribe!(audio.bytes, audio.mimeType, {
        context: { purpose: "source-audio", ...(recordedAt ? { recordedAt } : {}) },
      });
      if (result === null) {
        local.available = false;
        return undefined;
      }
      if (!result.text.trim()) return undefined;
      return {
        source: "local",
        text: result.text,
        ...(result.language ? { language: result.language } : {}),
      };
    } catch (err) {
      if (!(err instanceof AudioRejectedError)) throw err;
      log.info(
        `Transcriber rejected Plaud recording ${file.id} (${err.reason}); using Plaud's transcript`,
      );
      return undefined;
    }
  }

  /**
   * Plaud's summary, and its transcript when `withTranscript`. A presigned
   * link that expired between the detail and the read is renewed by asking
   * for the detail again, once.
   */
  private async plaudContent(
    file: FileSummary,
    withTranscript: boolean,
    signal: AbortSignal | undefined,
  ): Promise<{ summary?: PlaudSummary; segments?: TranscriptSegment[] }> {
    for (let attempt = 0; ; attempt++) {
      const detail = await this.client.getDetail(file.id, signal);
      const { transcript, summary } = selectContent(detail);
      try {
        const summaryRaw = summary ? await this.read(detail, summary, signal) : undefined;
        const transcriptRaw =
          withTranscript && transcript ? await this.read(detail, transcript, signal) : undefined;
        const parsedSummary = summaryRaw === undefined ? undefined : parseSummary(summaryRaw);
        const segments = transcriptRaw === undefined ? [] : parseTranscript(transcriptRaw);
        return {
          ...(parsedSummary ? { summary: parsedSummary } : {}),
          ...(segments.length > 0 ? { segments } : {}),
        };
      } catch (err) {
        if (!(err instanceof PlaudLinkExpiredError)) throw err;
        if (attempt === 0) continue;
        throw new SyncError("unknown", `Plaud refused the content of recording ${file.id}`, {
          scope: "item",
        });
      }
    }
  }

  private async read(
    detail: FileDetail,
    item: ContentItem,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const inline = inlineContent(detail, item);
    if (inline !== undefined) return inline;
    return item.data_link ? this.client.fetchContent(item.data_link, signal) : undefined;
  }

  /**
   * The account's recorder names, asked once per instance. A failure costs
   * only the names, and is `undefined` so the caller can tell it from an
   * account that names no recorder.
   */
  private deviceNames(signal: AbortSignal | undefined): Promise<Map<string, string> | undefined> {
    this.devices ??= this.client.listDevices(signal).catch((err: unknown) => {
      log.warn(`Could not read Plaud's device list: ${toErrorMessage(err)}`);
      this.devices = undefined;
      return undefined;
    });
    return this.devices;
  }
}

interface Sweep {
  pending: FileSummary[];
  known: Record<string, string>;
  enumeration: SnapshotEnumeration | undefined;
  /** Recordings this sweep could not render, reported when it completes. */
  skipped: string[];
  /** The gateway said no transcriber can run, earlier in this sweep. */
  noTranscriber: boolean;
  listingScope?: string;
  lastSnapshotAt?: string;
}

function resumeSweep(cursor: PlaudRecordingsCursor): Sweep {
  return {
    pending: cursor.pending ?? [],
    known: cursor.known ?? {},
    enumeration: cursor.snapshot
      ? SnapshotEnumeration.resume([RECORDINGS_PARTITION], cursor.snapshot)
      : undefined,
    skipped: cursor.skipped ?? [],
    noTranscriber: cursor.noTranscriber === true,
    ...(cursor.listingScope ? { listingScope: cursor.listingScope } : {}),
    ...(cursor.lastSnapshotAt ? { lastSnapshotAt: cursor.lastSnapshotAt } : {}),
  };
}

/** Marks a fingerprint rendered without its recorder's name, so it is rendered again. */
const DEVICE_MISSING = "~device";

/** What identifies a recording's audio, apart from everything an edit in the app can change. */
function audioKey(file: FileSummary): string {
  return JSON.stringify([file.start_time, file.duration ?? null, file.filesize ?? null]);
}

/**
 * Everything in a listing entry that changes the document a recording renders
 * as, as one short comparable string.
 */
export function fingerprint(file: FileSummary): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        file.version_ms ?? file.edit_time ?? null,
        file.filename ?? null,
        file.duration ?? null,
        file.serial_number ?? null,
        file.filetag_id_list ?? [],
        file.keywords ?? [],
        file.is_trans,
        file.is_summary,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

function skippedIssues(ids: string[]): SyncIssue[] {
  const unique = [...new Set(ids)];
  return [
    {
      scope: "item",
      kind: "unknown",
      code: "plaud-unreadable-recording",
      count: unique.length,
      subject: unique.slice(0, 20).join(", "),
      message: `Plaud could not serve ${unique.length} recording${unique.length === 1 ? "" : "s"}; ${unique.length === 1 ? "it is" : "they are"} tried again at the next sync.`,
    },
  ];
}
