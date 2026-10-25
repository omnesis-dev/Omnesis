// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `ConversationStore` — durable persistence for agent transcripts.
 *
 * One JSON file per conversation lives at
 * `<configDir>/conversations/<id>.json`. Each file holds the full ordered
 * sequence of canonical `ChatMessage`s — user text, assistant text and
 * tool_use blocks, user tool_result blocks — so the conversation can be
 * resumed verbatim after a gateway restart and inspected manually with
 * any text tool.
 *
 * Every `/agent/*` route is admin-scope; once a caller can reach the
 * harness it already has full read access to the corpus, so transcripts
 * are listed and loaded globally rather than partitioned by caller. The
 * `callerId` field on each record is retained as telemetry — it records
 * who most recently owned the live session — but is not used to gate
 * read/write/delete.
 *
 * Writes go through a tmp + atomic rename so a crash during fsync
 * cannot leave a half-written record on disk. We intentionally write
 * the entire record per turn rather than diffing — transcripts are
 * small (~tens to hundreds of KB) and atomic full-file writes keep
 * the recovery story trivially simple.
 */

import {
  appendFile,
  mkdir,
  opendir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  agentConversationTerminalFailureSchema,
  agentTerminalFailureSchema,
  assertNever,
  createLogger,
  type AgentConversationTerminalFailure,
  type AgentTerminalFailure,
} from "@omnesis/core";
import {
  readConversationRetentionCandidates,
  fileIdentity,
  type ConversationRetentionCandidate,
  type ConversationRetentionFile,
} from "./conversation-retention.js";
import type { Dir } from "node:fs";

import type { ConversationControlState } from "./conversation-controls.js";
import type { ChatMessage } from "@omnesis/agent";

const log = createLogger("gateway:agent").child("store");

export interface ConversationRecord {
  controls?: ConversationControlState;
  id: string;
  callerId: string;
  model: string;
  backend: string;
  /** ISO timestamp string. */
  createdAt: string;
  /** ISO timestamp string. */
  updatedAt: string;
  /**
   * Human-readable label, derived from the first user message at save
   * time. Truncated to ~70 chars. Empty string if the conversation has
   * no user content yet.
   */
  title: string;
  /**
   * User-set "keep this at the top" flag. Pinned conversations sort
   * ahead of unpinned ones in the list regardless of recency. Toggling
   * it never changes `updatedAt` — pinning is not a content edit.
   */
  pinned: boolean;
  /**
   * Where this conversation came from, when it did not start as a blank
   * chat: a watch firing the agent opened, the standing Morning brief
   * conversation, or a conversation the user opened about a task. Absent on plain conversations and on records written
   * before origins existed.
   */
  origin?: ConversationOrigin;
  /**
   * Set at load time when the record carries an anchor-shaped origin of
   * an unsupported kind (retired or written by another gateway version).
   * The origin itself is dropped; resume must refuse instead of running
   * the thread as a plain chat. Never persisted.
   */
  originUnrecognized?: boolean;
  /**
   * The seed length that unsupported origin declared, so readers keep hiding
   * the seed transcript (a retired brief thread's Brain run). Never persisted.
   */
  unrecognizedSeedMessageCount?: number;
  /**
   * Permanent conversation-level failure kept outside model-visible history.
   * V1 sets this only when the selected model's context window is exhausted;
   * clients render the transcript read-only and offer a fresh conversation.
   */
  terminalFailure?: AgentConversationTerminalFailure;
  /**
   * How the most recent turn failed, so reopening the conversation shows the
   * same styled failure the live stream showed rather than the marker the
   * session leaves in model-visible history. Stays outside that history and is
   * cleared by the next completed turn.
   */
  lastTurnFailure?: AgentTerminalFailure;
  messages: ChatMessage[];
}

/**
 * Origin anchor for a conversation that did not start as a blank chat — a
 * discriminated union over the anchor kinds that exist. Every kind resumes
 * on the main session profile.
 */
export type ConversationOrigin =
  | WatchFiringConversationOrigin
  | DailyBriefConversationOrigin
  | TaskConversationOrigin;

/**
 * The standing Morning brief conversation: one per gateway, pinned and
 * undeletable. Every morning the Brain appends one assistant message to it;
 * the user replies like in any conversation.
 *
 * The thread is one conversation but its working state is one day. A reply
 * turn's model context starts at the latest brief message, and clients scope
 * the citation timeline the same way, so the thread never needs compaction.
 */
export type DailyBriefConversationOrigin = {
  kind: "daily_brief";
  /**
   * The morning run that sent the latest brief. Carried, like on every other
   * origin, so a gateway that does not know this kind refuses to resume the
   * thread rather than running it as a plain chat.
   */
  runId: string;
  /** The morning briefs in this thread, oldest first, most recent ones only. */
  briefs: DailyBriefMessageRef[];
};

/** Where one morning brief sits in the thread. */
export type DailyBriefMessageRef = {
  /** Local day the brief was sent for (`YYYY-MM-DD`). */
  day: string;
  /** Index of the brief's assistant message in `messages`. */
  messageIndex: number;
  /** Stable id of the brief message; resolves the day's ranked items. */
  messageId: string;
  /**
   * When the brief was appended (ISO 8601 UTC). Absent on references
   * written before the thread recorded it.
   */
  sentAt?: string;
};

/** How many recent brief references the origin keeps. */
export const DAILY_BRIEF_REF_LIMIT = 60;

/** The latest morning brief in a daily-brief thread, or null. */
export function latestDailyBrief(
  origin: ConversationOrigin | undefined,
): DailyBriefMessageRef | null {
  if (origin?.kind !== "daily_brief") return null;
  return origin.briefs.at(-1) ?? null;
}

/**
 * A thread the agent opened itself when one of the operator's watches
 * fired. It is an ordinary conversation with the ordinary agent that simply
 * happens to have been opened by the agent rather than by the operator, so
 * it resumes on the main session profile.
 *
 * A client must learn this kind before the feature is shown to anyone.
 * Seed hiding is gated on the client having a context card to put in the
 * prefix's place (`hasContextCard` on iOS, its mirror in the portal's
 * agent reducer), so a client that does not recognize `watch_firing`
 * renders the hidden briefing prompt as the thread's first message
 * instead of the agent's.
 */
export type WatchFiringConversationOrigin = {
  kind: "watch_firing";
  /** The firing that opened the thread. */
  firingId: string;
  /**
   * The firing id again, under the field name every other origin uses for
   * the thing that seeded the thread.
   *
   * This exists for gateways older than watch-firing threads. They detect
   * an anchor written by a newer build as "a string `kind` plus a string
   * `runId` that `parseOrigin` rejected", and refuse to resume it. An
   * origin carrying only `firingId` would slip that check, and the thread
   * would resume as a plain chat — exposing the hidden briefing as its
   * first message and re-ingesting itself into the corpus, which is
   * exactly what the refusal exists to prevent.
   */
  runId: string;
  /** The watch (subscription) that fired — the thread's durable subject. */
  watchId: string;
  /** Snapshot at thread creation — the client's context card. */
  watch?: WatchFiringOriginSnapshot;
  /** Seed-prefix length, exactly as on the other origins. */
  seedMessageCount?: number;
};

/** The watch/firing fields a client needs to draw the context card. */
export type WatchFiringOriginSnapshot = {
  /** The watch's operator-facing name. */
  name: string;
  /** What the watch was watching for, in the operator's own words. */
  condition: string;
  /** When the firing happened (epoch ms). */
  firedAt: number;
};

/**
 * A conversation the user opened about one of their tasks ("Chat about
 * this"). It starts empty: the user's first message is the first message,
 * and there is no hidden seed. Every turn's system prompt carries the task as
 * it currently stands (see `TaskContextProvider` in `service.ts`).
 */
export type TaskConversationOrigin = {
  kind: "task";
  /** The task (open loop) the conversation is about. */
  taskId: string;
  /**
   * The task id again, under the field name every origin carries, so a
   * gateway that does not know this kind refuses to resume the thread
   * instead of running it as a plain chat.
   */
  runId: string;
  /**
   * The task as it stood when the conversation was opened, for the client's
   * context card. It is never refreshed, so the card still renders after the
   * task changes or is deleted.
   */
  task?: TaskConversationOriginSnapshot;
  /** Always 0: the conversation has no hidden seed. */
  seedMessageCount?: number;
};

/** The task fields a client needs to draw the context card. */
export type TaskConversationOriginSnapshot = {
  title: string;
  /** The task's state as `GET /tasks` reports it. */
  state: string;
  /** The day the task is due (`YYYY-MM-DD`), when it has a deadline. */
  due?: string;
  /** How many of the task's linked documents could be opened. */
  sourceCount: number;
};

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  backend: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pinned: boolean;
  origin?: ConversationOrigin;
}

export interface ConversationStore {
  save(rec: ConversationRecord): Promise<void>;
  load(id: string): Promise<ConversationRecord | null>;
  list(): Promise<ConversationSummary[]>;
  delete(id: string): Promise<boolean>;
  /**
   * Discover a bounded batch for background retention without materialising
   * the complete conversation summary index.
   */
  listRetentionCandidates?(
    cutoffMs: number,
    limit: number,
  ): Promise<{ items: ConversationRetentionCandidate[]; hasMore: boolean }>;
  /** Revalidate the IO-worker fingerprint while the mutation lock is held. */
  retentionCandidateIsCurrent?(
    candidate: ConversationRetentionCandidate,
    cutoffMs: number,
  ): Promise<boolean>;
  /**
   * Return candidates whose downstream cleanup is incomplete to the front of
   * the bounded scan. This keeps one large cascade from creating an
   * archive-sized queue of simultaneous cleanup obligations.
   */
  deferRetentionCandidates?(candidates: readonly ConversationRetentionCandidate[]): void;
  /**
   * Retention deletion variant that journals the summary-index removal in
   * O(1), leaving the next normal index write to compact it.
   */
  deleteForRetention?(id: string): Promise<boolean>;
  /**
   * Toggle the `pinned` flag on a stored conversation, preserving every
   * other field (notably `updatedAt`). Returns false when no file exists.
   */
  setPinned(id: string, pinned: boolean): Promise<boolean>;
}

interface IndexedConversationSummary extends ConversationSummary {
  fileMtimeMs: number;
  fileCtimeMs: number;
  fileSizeBytes: number;
}

interface ConversationSummaryIndex {
  version: 3;
  conversations: IndexedConversationSummary[];
}

const SUMMARY_INDEX_FILE = ".summary-index.v3";
const SUMMARY_INDEX_TOMBSTONES_FILE = ".summary-index.deleted";

// Older index-cache filenames we best-effort remove on rebuild so the
// conversations dir doesn't accumulate dead caches across upgrades. The
// `version` field inside the file also gates staleness, but cleaning up
// the renamed file keeps the directory tidy.
const LEGACY_SUMMARY_INDEX_FILES = [".summary-index.v2"];

/**
 * Filesystem-backed implementation. Atomic writes via tmp+rename so a
 * mid-write crash never produces a malformed JSON.
 */
export class FsConversationStore implements ConversationStore {
  private readonly dir: string;
  private retentionDir: Dir | null = null;
  private readonly retentionCandidateQueue: ConversationRetentionCandidate[] = [];

  constructor(
    dir: string,
    private readonly retentionScanner: (
      files: readonly ConversationRetentionFile[],
      cutoffMs: number,
    ) => Promise<ConversationRetentionCandidate[]> = readConversationRetentionCandidates,
  ) {
    this.dir = dir;
  }

  async save(rec: ConversationRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.pathFor(rec.id);
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    const body = JSON.stringify(rec, null, 2);
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
    await this.tryUpdateSummaryIndex(() => this.upsertSummary(summaryForRecord(rec)));
  }

  async load(id: string): Promise<ConversationRecord | null> {
    if (!isSafeId(id)) return null;
    try {
      const body = await readFile(this.pathFor(id), "utf8");
      const parsed = JSON.parse(body) as ConversationRecord;
      // Minimal validation — a malformed record is treated as "missing"
      // rather than throwing, so a single corrupt file can't take down
      // the listing flow.
      if (!parsed.id || !parsed.callerId || !Array.isArray(parsed.messages)) {
        log.warn(`conversation file ${id} missing required fields`);
        return null;
      }
      // Records written before `pinned` existed omit the field; normalize
      // so every loaded record carries a defined boolean.
      parsed.pinned = parsed.pinned === true;
      // Same for `origin` — anything malformed reads as a plain chat,
      // EXCEPT an anchor-shaped origin of an unsupported kind (retired or
      // written by another gateway version): that must refuse to resume rather
      // than silently run the thread as a plain chat with its seed
      // transcript exposed (and re-ingested as an omnesis-chat document by
      // the first turn's corpus upsert).
      const origin = parseOrigin(parsed.origin);
      if (origin) parsed.origin = origin;
      else {
        if (isUnknownAnchorShape(parsed.origin)) {
          parsed.originUnrecognized = true;
          const seed = (parsed.origin as { seedMessageCount?: unknown }).seedMessageCount;
          if (typeof seed === "number" && Number.isInteger(seed) && seed > 0)
            parsed.unrecognizedSeedMessageCount = seed;
        }
        delete parsed.origin;
      }
      const terminalFailure = agentConversationTerminalFailureSchema.safeParse(
        parsed.terminalFailure,
      );
      if (terminalFailure.success) parsed.terminalFailure = terminalFailure.data;
      else delete parsed.terminalFailure;
      const lastTurnFailure = agentTerminalFailureSchema.safeParse(parsed.lastTurnFailure);
      if (lastTurnFailure.success) {
        parsed.lastTurnFailure = lastTurnFailure.data;
      } else {
        delete parsed.lastTurnFailure;
      }
      return parsed;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return null;
      log.warn(`failed to load conversation ${id}: ${e.message ?? e}`);
      return null;
    }
  }

  async list(): Promise<ConversationSummary[]> {
    const indexed = await this.readSummaryIndex();
    if (indexed) return indexed;
    return this.rebuildSummaryIndex();
  }

  private async rebuildSummaryIndex(): Promise<ConversationSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: ConversationSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const rec = await this.load(id);
      if (!rec) continue;
      out.push(summaryForRecord(rec));
    }
    sortSummaries(out);
    await this.tryUpdateSummaryIndex(() => this.writeSummaryIndex(out));
    await this.removeLegacyIndexes();
    return out;
  }

  private async removeLegacyIndexes(): Promise<void> {
    for (const name of LEGACY_SUMMARY_INDEX_FILES) {
      try {
        await unlink(join(this.dir, name));
      } catch {
        // Best-effort: absent (the common case) or unreadable — ignore.
      }
    }
  }

  async delete(id: string): Promise<boolean> {
    if (!isSafeId(id)) return false;
    try {
      await unlink(this.pathFor(id));
      await this.tryUpdateSummaryIndex(() => this.removeSummary(id));
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return false;
      throw err;
    }
  }

  /**
   * Inspect at most a small fixed number of files from a rotating async
   * directory cursor. Conversation JSON can be large, so the scan budget is
   * deliberately independent of archive size; a later retention tick resumes
   * where this one yielded.
   */
  async listRetentionCandidates(
    cutoffMs: number,
    limit: number,
  ): Promise<{ items: ConversationRetentionCandidate[]; hasMore: boolean }> {
    const wanted = Math.max(1, Math.floor(limit));
    const scanLimit = Math.max(20, wanted * 4);
    const items = this.retentionCandidateQueue.splice(0, wanted);
    if (items.length >= wanted) {
      return {
        items,
        hasMore: this.retentionCandidateQueue.length > 0 || this.retentionDir !== null,
      };
    }
    const files: ConversationRetentionFile[] = [];
    let scanned = 0;
    let exhausted = false;
    while (scanned < scanLimit) {
      if (!this.retentionDir) {
        try {
          this.retentionDir = await opendir(this.dir);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return { items: [], hasMore: false };
          }
          throw err;
        }
      }
      const entry = await this.retentionDir.read();
      if (!entry) {
        await this.retentionDir.close().catch(() => {});
        this.retentionDir = null;
        exhausted = true;
        break;
      }
      scanned += 1;
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!isSafeId(id)) continue;
      files.push({ id, path: this.pathFor(id) });
    }
    if (files.length > 0) {
      this.retentionCandidateQueue.push(...(await this.retentionScanner(files, cutoffMs)));
    }
    items.push(...this.retentionCandidateQueue.splice(0, wanted - items.length));
    return {
      items,
      hasMore: this.retentionCandidateQueue.length > 0 || !exhausted,
    };
  }

  async retentionCandidateIsCurrent(
    candidate: ConversationRetentionCandidate,
    cutoffMs: number,
  ): Promise<boolean> {
    if (Date.parse(candidate.updatedAt) >= cutoffMs) return false;
    try {
      const current = await stat(this.pathFor(candidate.id), { bigint: true });
      return fileIdentity(current) === candidate.fileIdentity;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  deferRetentionCandidates(candidates: readonly ConversationRetentionCandidate[]): void {
    const queuedIds = new Set(this.retentionCandidateQueue.map((candidate) => candidate.id));
    const returned = candidates.filter((candidate) => !queuedIds.has(candidate.id));
    this.retentionCandidateQueue.unshift(...returned);
  }

  /**
   * Retention runs often; rewriting and restatting an index containing every
   * conversation for each single-file deletion would make each tick grow with
   * archive size. Journal the deleted id instead. Normal index reads filter
   * these tombstones, and the next rebuild/upsert compacts them away.
   */
  async deleteForRetention(id: string): Promise<boolean> {
    if (!isSafeId(id)) return false;
    try {
      await unlink(this.pathFor(id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    try {
      await appendFile(join(this.dir, SUMMARY_INDEX_TOMBSTONES_FILE), `${id}\n`, "utf8");
    } catch (err) {
      log.warn(
        `failed to journal retained conversation deletion ${id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return true;
  }

  async setPinned(id: string, pinned: boolean): Promise<boolean> {
    const rec = await this.load(id);
    if (!rec) return false;
    if (rec.pinned === pinned) return true; // already in the desired state.
    // Re-save the record verbatim with only `pinned` changed. `save`
    // does not touch `updatedAt`, so pinning leaves recency ordering
    // intact and re-derives the summary index (which carries `pinned`).
    rec.pinned = pinned;
    await this.save(rec);
    return true;
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private indexPath(): string {
    return join(this.dir, SUMMARY_INDEX_FILE);
  }

  private async readSummaryIndex(): Promise<ConversationSummary[] | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.indexPath(), "utf8"));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return null;
      log.warn(`failed to load conversation summary index: ${e.message ?? e}`);
      return null;
    }
    const index = parseSummaryIndex(parsed);
    if (!index) return null;
    const tombstones = await this.readSummaryIndexTombstones();
    if (tombstones.size > 0) {
      index.conversations = index.conversations.filter((summary) => !tombstones.has(summary.id));
    }
    const files = await this.conversationFiles();
    if (!files) return null;
    const indexedIds = new Set(index.conversations.map((s) => s.id));
    if (files.length !== indexedIds.size || files.some(({ id }) => !indexedIds.has(id))) {
      return null;
    }
    const fileStatsById = new Map(files.map((file) => [file.id, file]));
    if (
      index.conversations.some((summary) => {
        const file = fileStatsById.get(summary.id);
        return (
          !file ||
          Math.abs(file.mtimeMs - summary.fileMtimeMs) > 1 ||
          Math.abs(file.ctimeMs - summary.fileCtimeMs) > 1 ||
          file.size !== summary.fileSizeBytes
        );
      })
    ) {
      return null;
    }
    return index.conversations
      .map(
        ({
          fileMtimeMs: _fileMtimeMs,
          fileCtimeMs: _fileCtimeMs,
          fileSizeBytes: _fileSizeBytes,
          ...summary
        }) => summary,
      )
      .sort(compareSummaryNewestFirst);
  }

  private async conversationFiles(): Promise<Array<{
    id: string;
    mtimeMs: number;
    ctimeMs: number;
    size: number;
  }> | null> {
    try {
      const names = await readdir(this.dir);
      const ids = names
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .filter(isSafeId);
      const out: Array<{ id: string; mtimeMs: number; ctimeMs: number; size: number }> = [];
      for (const id of ids) {
        const file = await stat(this.pathFor(id));
        out.push({ id, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs, size: file.size });
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private async upsertSummary(summary: ConversationSummary): Promise<void> {
    const existing = (await this.readSummaryIndex()) ?? (await this.rebuildSummaryIndex());
    const next = existing.filter((s) => s.id !== summary.id);
    next.push(summary);
    sortSummaries(next);
    await this.writeSummaryIndex(next);
  }

  private async removeSummary(id: string): Promise<void> {
    const existing = await this.readSummaryIndex();
    if (!existing) return;
    await this.writeSummaryIndex(existing.filter((s) => s.id !== id));
  }

  private async tryUpdateSummaryIndex(update: () => Promise<void>): Promise<void> {
    try {
      await update();
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      log.warn(`failed to update conversation summary index: ${e.message ?? e}`);
    }
  }

  private async writeSummaryIndex(conversations: ConversationSummary[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = this.indexPath();
    const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
    const indexed: IndexedConversationSummary[] = [];
    for (const summary of conversations) {
      const file = await stat(this.pathFor(summary.id));
      indexed.push({
        ...summary,
        fileMtimeMs: file.mtimeMs,
        fileCtimeMs: file.ctimeMs,
        fileSizeBytes: file.size,
      });
    }
    const body = JSON.stringify(
      { version: 3, conversations: indexed } satisfies ConversationSummaryIndex,
      null,
      2,
    );
    await writeFile(tmp, body, "utf8");
    await rename(tmp, path);
    await unlink(join(this.dir, SUMMARY_INDEX_TOMBSTONES_FILE)).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }

  private async readSummaryIndexTombstones(): Promise<Set<string>> {
    try {
      return new Set(
        (await readFile(join(this.dir, SUMMARY_INDEX_TOMBSTONES_FILE), "utf8"))
          .split("\n")
          .filter(isSafeId),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      throw err;
    }
  }
}

function summaryForRecord(rec: ConversationRecord): ConversationSummary {
  return {
    id: rec.id,
    title: rec.title || "(untitled)",
    model: rec.model,
    backend: rec.backend,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    messageCount: rec.messages.length,
    pinned: rec.pinned === true,
    ...(rec.origin ? { origin: originAnchor(rec.origin) } : {}),
  };
}

/**
 * The list-row slice of an origin: just the anchor, never an embedded
 * snapshot, seed count or brief index. Those are consumed only from the
 * session resume response — copying them into every summary would ship
 * them on every conversations-list fetch for rows that render none of it.
 */
export function originAnchor(origin: ConversationOrigin): ConversationOrigin {
  switch (origin.kind) {
    case "daily_brief":
      return { kind: "daily_brief", runId: origin.runId, briefs: [] };
    case "watch_firing":
      return {
        kind: "watch_firing",
        firingId: origin.firingId,
        runId: origin.runId,
        watchId: origin.watchId,
      };
    case "task":
      return { kind: "task", taskId: origin.taskId, runId: origin.runId };
    default:
      return assertNever(origin);
  }
}

/**
 * True when a persisted origin value looks like an unsupported anchor — an
 * object carrying a string `kind` + `runId` that `parseOrigin` rejected.
 * Recognizing the shape is what makes a gateway refuse to resume a thread
 * it would otherwise silently mis-render as a plain chat, exposing its
 * hidden seed and re-ingesting it into the corpus. Every origin kind
 * therefore carries `runId`, whatever else identifies it.
 */
function isUnknownAnchorShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o.kind === "string" && typeof o.runId === "string";
}

function sortSummaries(items: ConversationSummary[]): void {
  items.sort(compareSummaryNewestFirst);
}

// Pinned conversations float to the top; within each pin group the
// order is newest-first by `updatedAt`, with id as a stable tiebreaker.
function compareSummaryNewestFirst(a: ConversationSummary, b: ConversationSummary): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Validate a persisted origin anchor; a malformed anchor reads as absent,
 * while malformed optional extras (snapshot, seed count) are dropped
 * individually so the anchor itself survives.
 */
function parseOrigin(value: unknown): ConversationOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.runId !== "string") return undefined;
  const seedMessageCount =
    typeof o.seedMessageCount === "number" &&
    Number.isInteger(o.seedMessageCount) &&
    o.seedMessageCount >= 0
      ? o.seedMessageCount
      : undefined;
  if (
    o.kind === "watch_firing" &&
    typeof o.firingId === "string" &&
    typeof o.watchId === "string"
  ) {
    const watch = parseWatchFiringSnapshot(o.watch);
    return {
      kind: "watch_firing",
      firingId: o.firingId,
      runId: o.runId,
      watchId: o.watchId,
      ...(watch ? { watch } : {}),
      ...(seedMessageCount !== undefined ? { seedMessageCount } : {}),
    };
  }
  if (o.kind === "task" && typeof o.taskId === "string" && o.taskId.length > 0) {
    const task = parseTaskSnapshot(o.task);
    return {
      kind: "task",
      taskId: o.taskId,
      runId: o.runId,
      ...(task ? { task } : {}),
      ...(seedMessageCount !== undefined ? { seedMessageCount } : {}),
    };
  }
  if (o.kind === "daily_brief") {
    const briefs = Array.isArray(o.briefs)
      ? o.briefs.flatMap((ref: unknown): DailyBriefMessageRef[] => {
          if (!ref || typeof ref !== "object") return [];
          const r = ref as Record<string, unknown>;
          return typeof r.day === "string" &&
            typeof r.messageId === "string" &&
            typeof r.messageIndex === "number" &&
            Number.isInteger(r.messageIndex) &&
            r.messageIndex >= 0
            ? [
                {
                  day: r.day,
                  messageIndex: r.messageIndex,
                  messageId: r.messageId,
                  ...(typeof r.sentAt === "string" ? { sentAt: r.sentAt } : {}),
                },
              ]
            : [];
        })
      : [];
    return { kind: "daily_brief", runId: o.runId, briefs };
  }
  return undefined;
}

function parseWatchFiringSnapshot(value: unknown): WatchFiringOriginSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as Partial<WatchFiringOriginSnapshot>;
  if (typeof s.name !== "string" || typeof s.condition !== "string") return undefined;
  return {
    name: s.name,
    condition: s.condition,
    firedAt: typeof s.firedAt === "number" ? s.firedAt : 0,
  };
}

function parseTaskSnapshot(value: unknown): TaskConversationOriginSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const s = value as Record<string, unknown>;
  if (typeof s.title !== "string" || typeof s.state !== "string") return undefined;
  return {
    title: s.title,
    state: s.state,
    ...(typeof s.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.due) ? { due: s.due } : {}),
    sourceCount:
      typeof s.sourceCount === "number" && Number.isInteger(s.sourceCount) && s.sourceCount >= 0
        ? s.sourceCount
        : 0,
  };
}

function parseSummaryIndex(value: unknown): ConversationSummaryIndex | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ConversationSummaryIndex>;
  if (raw.version !== 3 || !Array.isArray(raw.conversations)) return null;
  const conversations: IndexedConversationSummary[] = [];
  for (const item of raw.conversations) {
    if (!item || typeof item !== "object") return null;
    const s = item as Partial<IndexedConversationSummary>;
    if (
      typeof s.id !== "string" ||
      !isSafeId(s.id) ||
      typeof s.title !== "string" ||
      typeof s.model !== "string" ||
      typeof s.backend !== "string" ||
      typeof s.createdAt !== "string" ||
      typeof s.updatedAt !== "string" ||
      typeof s.messageCount !== "number" ||
      typeof s.pinned !== "boolean" ||
      typeof s.fileMtimeMs !== "number" ||
      typeof s.fileCtimeMs !== "number" ||
      typeof s.fileSizeBytes !== "number"
    ) {
      return null;
    }
    const origin = parseOrigin(s.origin);
    conversations.push({
      id: s.id,
      title: s.title,
      model: s.model,
      backend: s.backend,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount,
      pinned: s.pinned,
      ...(origin ? { origin } : {}),
      fileMtimeMs: s.fileMtimeMs,
      fileCtimeMs: s.fileCtimeMs,
      fileSizeBytes: s.fileSizeBytes,
    });
  }
  return { version: 3, conversations };
}

/**
 * Longest conversation title stored. Titles sit in a single list row on a
 * phone; past roughly this much the tail is never read, and the row wraps.
 */
export const MAX_CONVERSATION_TITLE_CHARS = 70;

/** Clip an already-collapsed single line to {@link MAX_CONVERSATION_TITLE_CHARS}. */
export function clipTitle(oneLine: string): string {
  return oneLine.length > MAX_CONVERSATION_TITLE_CHARS
    ? `${oneLine.slice(0, MAX_CONVERSATION_TITLE_CHARS - 1)}…`
    : oneLine;
}

/**
 * Make a short, human-readable title from the first user message text.
 * Pure string utility — kept at module scope so it can be reused at the
 * service layer when seeding a new conversation record.
 */
export function deriveTitle(messages: ReadonlyArray<ChatMessage>): string {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const part of msg.parts) {
      if (part.kind === "text" && part.text.trim().length > 0) {
        const oneLine = part.text.replace(/\s+/g, " ").trim();
        return clipTitle(oneLine);
      }
    }
  }
  return "";
}

// IDs end up in file paths; refuse anything that could climb out of the
// configured directory. Session IDs are generated server-side as
// `s_<uuid>` so this is paranoia, but cheap paranoia.
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_:-]{1,128}$/.test(id);
}
