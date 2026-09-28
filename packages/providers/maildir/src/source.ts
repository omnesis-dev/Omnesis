// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Maildir sync cycle.
 *
 * Each cycle walks the tree, then works through three stages, as many pages
 * as each needs:
 *
 * 1. **Scan.** Files the index has not seen are opened far enough to read
 *    their headers, which names the message each holds. Scan pages carry no
 *    documents.
 * 2. **Emit.** Every message whose folders or flags differ from what was last
 *    emitted — a new message, a label added in Gmail, a message starred — is
 *    parsed in full and emitted.
 * 3. **Snapshot.** The final page names every message still on disk, which is
 *    how a deletion reaches the gateway: a Maildir records none, a message is
 *    simply no longer there.
 *
 * A message stored in several folders is one document tagged with all of
 * them, and is gone only when its last copy is.
 *
 * The walk and the list of messages to emit are kept in memory between the
 * pages of one cycle, so a cycle over a large tree lists it once rather than
 * once per page. They are rebuilt whenever the cursor a page receives is not
 * the one the previous page returned.
 */

import { randomUUID, createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@omnesis/core";
import { SnapshotEnumeration } from "@omnesis/source-sdk";
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { MaildirIndex } from "./index-store.js";
import { folderTag, tooLargeError, walkMaildir } from "./layout.js";
import { parseMessageFile, scanMessage } from "./message.js";
import { attachmentChildIds, normalizeMessage } from "./normalizer.js";
import type { AttachmentExtractionConfig, AttachmentExtractFn } from "@omnesis/core";
import type { SyncCursor, SyncOptions, SyncProgress, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { EmittedAttachment, EmittedRow, FileRow } from "./index-store.js";
import type { MaildirWalk, WalkLimits } from "./layout.js";
import type { MessagePlacement, NormalizeContext } from "./normalizer.js";

const log = createLogger("source:maildir");

/**
 * What the emitted documents mean. Part of every message's signature, so
 * raising it re-emits every message on the next cycle.
 */
const MAILDIR_OUTPUT_REVISION = 2;

const DEFAULT_LIMITS: MaildirLimits = {
  maxMailboxes: 2_000,
  maxFiles: 1_000_000,
  maxPresentIds: 1_000_000,
  emitPageSize: 50,
  scanPageSize: 500,
};
/**
 * The snapshot partition standing for files the cycle could not name. Not a
 * folder id: those are relative paths, and this cannot be one.
 */
const UNNAMED_FILES = "\0unnamed";
/** How long a cycle's walk may be reused between its pages. */
const PLAN_TTL_MS = 10 * 60 * 1000;

export interface MaildirLimits extends WalkLimits {
  /**
   * The most ids one snapshot may name. A runaway guard, overridable so a test
   * can watch it fire.
   */
  maxPresentIds: number;
  emitPageSize: number;
  scanPageSize: number;
}

/**
 * What the gateway stores for this source.
 *
 * `generation` names one run of the source from an empty corpus; `seq` counts
 * its pages. Together they say which rows of the local emission record the
 * gateway has committed — see `MaildirIndex`.
 */
export interface MaildirCursor extends SyncCursor {
  generation: string;
  seq: number;
}

export interface MaildirSourceOptions {
  sourceId: string;
  providerId: string;
  root: string;
  exclude: readonly string[];
  /** Where the local index lives; `:memory:` keeps it for this process only. */
  indexPath: string;
  dataCutoff?: string;
  attachmentConfig: AttachmentExtractionConfig;
  extractAttachment?: AttachmentExtractFn;
  limits?: Partial<MaildirLimits>;
  now?: () => number;
}

interface PlanEntry extends MessagePlacement {
  /** The copies to read, in order: the first that opens and parses is used. */
  paths: string[];
  signature: string;
  contentFingerprint: string;
  /** What was last emitted for its attachments, when only its folders or flags changed since. */
  reuse?: EmittedAttachment[];
}

interface CyclePlan {
  generation: string;
  /** The cursor seq the next page must arrive with for this plan to still apply. */
  seq: number;
  builtAt: number;
  walk: MaildirWalk;
  mailboxDirs: Map<string, string>;
  mailboxNames: Map<string, string>;
  sentMailboxes: Set<string>;
  /** Files the index has not read yet, in the order the scan stage reads them. */
  unscanned: FileRow[];
  /** How many files this cycle could not read; reported once, on the final page. */
  unreadableFiles: number;
  /** Of those, how many the index could not name, because their headers never read. */
  unnamedFiles: number;
  pending?: PlanEntry[];
  cycleTotal?: number;
  bootstrap: boolean;
}

function fileKey(mailboxId: string, uniq: string): string {
  return `${mailboxId}\0${uniq}`;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function isAccessError(err: unknown): boolean {
  const code = errorCode(err);
  return code === "EACCES" || code === "EPERM";
}

function isGoneError(err: unknown): boolean {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function isMaildirCursor(value: unknown): value is MaildirCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return (
    typeof cursor.generation === "string" &&
    cursor.generation.length > 0 &&
    cursor.generation.length <= 64 &&
    typeof cursor.seq === "number" &&
    Number.isSafeInteger(cursor.seq) &&
    cursor.seq >= 0
  );
}

export class MaildirSource {
  readonly id: SourceId;
  readonly providerId: ProviderId;
  private readonly limits: MaildirLimits;
  private readonly cutoffMs?: number;
  private readonly ctx: NormalizeContext;
  private readonly now: () => number;
  private index?: MaildirIndex;
  private plan?: CyclePlan;
  /** Bumped by a resync, so a page still being built for the old run cannot record anything. */
  private epoch = 0;
  private syncInFlight = false;

  constructor(private readonly options: MaildirSourceOptions) {
    this.id = SourceId(options.sourceId);
    this.providerId = ProviderId(options.providerId);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    const cutoffMs = options.dataCutoff ? new Date(options.dataCutoff).getTime() : Number.NaN;
    this.cutoffMs = Number.isFinite(cutoffMs) ? cutoffMs : undefined;
    this.ctx = {
      sourceId: this.id,
      providerId: this.providerId,
      attachmentConfig: options.attachmentConfig,
      extractAttachment: options.extractAttachment,
    };
    this.now = options.now ?? Date.now;
  }

  onResync(): void {
    this.epoch += 1;
    this.plan = undefined;
  }

  dispose(): Promise<void> {
    this.plan = undefined;
    this.index?.close();
    this.index = undefined;
    return Promise.resolve();
  }

  private openIndex(): MaildirIndex {
    this.index ??= new MaildirIndex(this.options.indexPath);
    return this.index;
  }

  async sync(cursor: MaildirCursor | null, opts?: SyncOptions): Promise<SyncResult<MaildirCursor>> {
    opts?.signal?.throwIfAborted();
    if (this.syncInFlight) {
      throw new SyncError("transient", "A Maildir sync is already in progress for this source");
    }
    this.syncInFlight = true;
    try {
      return await this.syncPage(cursor, opts?.signal);
    } catch (err) {
      this.plan = undefined;
      throw err;
    } finally {
      this.syncInFlight = false;
    }
  }

  private async syncPage(
    cursor: MaildirCursor | null,
    signal: AbortSignal | undefined,
  ): Promise<SyncResult<MaildirCursor>> {
    const epoch = this.epoch;
    const generation = cursor?.generation ?? randomUUID();
    const committedSeq = cursor?.seq ?? 0;
    const next: MaildirCursor = { generation, seq: committedSeq + 1 };
    const index = this.openIndex();
    index.alignWithCursor(generation, committedSeq);

    const plan = this.currentPlan(generation, committedSeq, cursor === null, index);
    plan.seq = next.seq;
    this.plan = plan;

    // Stage 1: name every file the index has not seen.
    if (plan.unscanned.length > 0) {
      const batch = plan.unscanned.splice(0, this.limits.scanPageSize);
      await this.scan(batch, plan, index, signal);
      return {
        documents: [],
        deletedExternalIds: [],
        cursor: next,
        hasMore: true,
        progress: {
          phase: plan.bootstrap ? "bootstrap" : "incremental",
          processed: 0,
          detail: `Reading message headers: ${plan.unscanned.length} left`,
        },
      };
    }

    // Stage 2: emit what changed.
    plan.pending ??= this.buildPending(plan, index);
    plan.cycleTotal ??= plan.pending.length;
    const batch = plan.pending.splice(0, this.limits.emitPageSize);
    const documents: DocumentInput[] = [];
    const rows: EmittedRow[] = [];
    for (const entry of batch) {
      signal?.throwIfAborted();
      const emitted = await this.emit(entry, next.seq, plan);
      if (!emitted) continue;
      documents.push(...emitted.documents);
      rows.push(emitted.row);
    }
    const hasMore = plan.pending.length > 0;

    // Stage 3, on the last page: name what is still there.
    let snapshot: SnapshotEnumeration | undefined;
    let forget: string[] = [];
    if (!hasMore) {
      const built = this.buildSnapshot(plan, index, rows);
      snapshot = built.snapshot;
      forget = built.forget;
    }

    signal?.throwIfAborted();
    if (epoch !== this.epoch) {
      throw new SyncError(
        "transient",
        "The Maildir source was restarted while this page was being built",
      );
    }
    index.recordEmissions(generation, rows, forget);
    if (!hasMore) this.plan = undefined;

    const progress: SyncProgress = {
      phase: plan.bootstrap ? "bootstrap" : "incremental",
      processed: documents.length,
      total: plan.cycleTotal,
    };
    if (hasMore) {
      return { documents, deletedExternalIds: [], cursor: next, hasMore: true, progress };
    }
    const issue = snapshot!.withheldIssue();
    if (issue) log.warn(snapshot!.withheldReason() ?? "Snapshot withheld");
    if (plan.unreadableFiles > 0) {
      log.warn(
        `${plan.unreadableFiles} message file(s) under ${this.options.root} could not be read this cycle; they are retried on the next one`,
      );
    }
    return {
      documents,
      deletedExternalIds: [],
      presentExternalIds: snapshot!.result(),
      issues: issue ? [issue] : [],
      cursor: next,
      hasMore: false,
      progress,
    };
  }

  /** The plan this page continues, or a fresh one built from a new walk. */
  private currentPlan(
    generation: string,
    committedSeq: number,
    bootstrap: boolean,
    index: MaildirIndex,
  ): CyclePlan {
    const existing = this.plan;
    if (
      existing &&
      existing.generation === generation &&
      existing.seq === committedSeq &&
      this.now() - existing.builtAt < PLAN_TTL_MS
    ) {
      return existing;
    }
    const walk = walkMaildir(this.options.root, this.options.exclude, this.limits);
    const plan: CyclePlan = {
      generation,
      seq: committedSeq,
      builtAt: this.now(),
      walk,
      mailboxDirs: new Map(walk.mailboxes.map((m) => [m.id, m.dir])),
      mailboxNames: new Map(walk.mailboxes.map((m) => [m.id, m.name])),
      sentMailboxes: new Set(walk.mailboxes.filter((m) => m.sent).map((m) => m.id)),
      unscanned: [],
      unreadableFiles: 0,
      unnamedFiles: 0,
      bootstrap,
    };
    this.reconcile(plan, index);
    plan.unscanned = index.unscannedFiles().filter((file) => plan.mailboxDirs.has(file.mailboxId));
    return plan;
  }

  /**
   * Whether a mailbox sits under a folder the walk could not list — the
   * folder itself, or anything inside it. A gap on the root mailbox (`""`)
   * covers that mailbox alone: the root itself always lists, or the walk
   * throws.
   */
  private isInGap(plan: CyclePlan, mailboxId: string): boolean {
    return plan.walk.gaps.some(
      (gap) =>
        gap.mailboxId === mailboxId ||
        (gap.mailboxId !== "" && mailboxId.startsWith(`${gap.mailboxId}/`)),
    );
  }

  /**
   * Bring the index's file table in line with the walk. A file under a gap is
   * kept as it was: the walk could not see it, which says nothing about
   * whether it is still there.
   */
  private reconcile(plan: CyclePlan, index: MaildirIndex): void {
    const known = new Map(index.allFiles().map((row) => [fileKey(row.mailboxId, row.uniq), row]));
    const upserts: Array<{ mailboxId: string; uniq: string; relPath: string; flags: string }> = [];
    const seen = new Set<string>();
    for (const file of plan.walk.files) {
      const id = fileKey(file.mailboxId, file.uniq);
      seen.add(id);
      const row = known.get(id);
      if (!row || row.relPath !== file.relPath || row.flags !== file.flags) upserts.push(file);
    }
    const removals: Array<{ mailboxId: string; uniq: string }> = [];
    for (const [id, row] of known) {
      if (seen.has(id) || this.isInGap(plan, row.mailboxId)) continue;
      removals.push({ mailboxId: row.mailboxId, uniq: row.uniq });
    }
    index.applyListing(upserts, removals);
  }

  private filePath(plan: CyclePlan, file: Pick<FileRow, "mailboxId" | "relPath">): string {
    return join(plan.mailboxDirs.get(file.mailboxId)!, file.relPath);
  }

  private async scan(
    batch: FileRow[],
    plan: CyclePlan,
    index: MaildirIndex,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const scans: Array<{ mailboxId: string; uniq: string; key: string; dateMs: number }> = [];
    for (const file of batch) {
      signal?.throwIfAborted();
      const path = this.filePath(plan, file);
      try {
        const scanned = await scanMessage(
          path,
          file.mailboxId,
          file.uniq,
          () => lstatSync(path).mtimeMs,
        );
        scans.push({ mailboxId: file.mailboxId, uniq: file.uniq, ...scanned });
      } catch (err) {
        // A file that will not open stays unread in the index and is tried
        // again next cycle; one that moved since the walk is found where it
        // went by the next walk. Either could be the only copy left of a
        // message already emitted — the new copy of a message just moved to
        // another folder — which the snapshot must not read as deleted.
        plan.unnamedFiles += 1;
        if (!isGoneError(err)) {
          plan.unreadableFiles += 1;
          log.debug(
            `Cannot read a message in ${plan.mailboxNames.get(file.mailboxId) ?? file.mailboxId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    index.recordScans(scans);
  }

  private configFingerprint(): string {
    return JSON.stringify({
      revision: MAILDIR_OUTPUT_REVISION,
      attachments: this.ctx.extractAttachment ? this.ctx.attachmentConfig : null,
    });
  }

  /** Group the indexed files by message and list the messages whose emitted form is out of date. */
  private buildPending(plan: CyclePlan, index: MaildirIndex): PlanEntry[] {
    const emitted = index.allEmitted();
    const fingerprint = this.configFingerprint();
    const byKey = new Map<string, FileRow[]>();
    for (const file of index.allFiles()) {
      if (file.key === null) continue;
      const list = byKey.get(file.key);
      if (list) list.push(file);
      else byKey.set(file.key, [file]);
    }
    const pending: PlanEntry[] = [];
    for (const [key, files] of byKey) {
      // A message with a copy under a gap is left as it was: its folder list
      // would be missing the one that could not be read.
      if (
        files.some(
          (file) => !plan.mailboxDirs.has(file.mailboxId) || this.isInGap(plan, file.mailboxId),
        )
      ) {
        continue;
      }
      const entry = this.placement(plan, key, files, fingerprint);
      if (this.cutoffMs !== undefined && entry.dateMs < this.cutoffMs) continue;
      const prior = emitted.get(key);
      if (prior?.signature === entry.signature) continue;
      if (prior?.contentFingerprint === fingerprint) entry.reuse = prior.attachments;
      pending.push(entry);
    }
    // Oldest first, so an interrupted bootstrap has filled in history in order.
    pending.sort((a, b) => a.dateMs - b.dateMs || a.key.localeCompare(b.key));
    return pending;
  }

  private placement(
    plan: CyclePlan,
    key: string,
    files: FileRow[],
    fingerprint: string,
  ): PlanEntry {
    const named = files
      .map((file) => ({ file, name: plan.mailboxNames.get(file.mailboxId)! }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.file.uniq.localeCompare(b.file.uniq));
    const sent = files.some((file) => plan.sentMailboxes.has(file.mailboxId));
    const flagged = files.some((file) => file.flags.includes("F"));
    const answered = files.some((file) => file.flags.includes("R"));
    const tags = new Set(
      named.map((n) => folderTag(n.name)).filter((tag): tag is string => tag !== null),
    );
    // A flag is the star wherever the folders do not already say so.
    if (flagged) tags.add("STARRED");
    const folders = [...tags].sort();
    const dateMs = Math.min(...files.map((file) => file.dateMs ?? Number.POSITIVE_INFINITY));
    const signature = createHash("sha256")
      .update(JSON.stringify([fingerprint, folders, sent, flagged, answered]))
      .digest("hex")
      .slice(0, 32);
    return {
      key,
      folders,
      sent,
      flagged,
      answered,
      dateMs: Number.isFinite(dateMs) ? dateMs : 0,
      paths: named.map((n) => this.filePath(plan, n.file)),
      signature,
      contentFingerprint: fingerprint,
    };
  }

  /**
   * Parse one message and build its documents.
   *
   * Tries each copy in turn and returns nothing when none opens and parses:
   * every copy moved since the walk, the process may not read them, or they
   * are not mail. Nothing is recorded then, so what was last emitted for the
   * message stands — the snapshot keeps naming it from the index while any
   * copy is on disk — and it is tried again next cycle.
   */
  private async emit(
    entry: PlanEntry,
    seq: number,
    plan: CyclePlan,
  ): Promise<{ documents: DocumentInput[]; row: EmittedRow } | undefined> {
    for (const path of entry.paths) {
      let parsed;
      try {
        parsed = await parseMessageFile(path);
      } catch (err) {
        if (!isGoneError(err)) {
          plan.unreadableFiles += 1;
          log.debug(
            `Cannot read a message file${isAccessError(err) ? "" : " as mail"}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        continue;
      }
      const normalized = await normalizeMessage(parsed, entry, this.ctx, entry.reuse);
      return {
        documents: normalized.documents,
        row: {
          key: entry.key,
          signature: entry.signature,
          contentFingerprint: entry.contentFingerprint,
          seq,
          attachments: normalized.attachments,
        },
      };
    }
    return undefined;
  }

  /**
   * Name every message still on disk, one partition per folder.
   *
   * A message is named when it has a copy in a folder that listed and was
   * emitted in this generation, the only one the gateway holds.
   * Messages the index remembers emitting but that no file holds any more
   * are forgotten here; the snapshot's silence about them is what deletes
   * them.
   */
  private buildSnapshot(
    plan: CyclePlan,
    index: MaildirIndex,
    pageRows: EmittedRow[],
  ): { snapshot: SnapshotEnumeration; forget: string[] } {
    const emitted = index.allEmitted();
    for (const row of pageRows) emitted.set(row.key, row);
    const files = index.allFiles().filter((file) => file.key !== null);
    // A message's date is its earliest copy's, as the emit stage decided it.
    const keyDates = new Map<string, number>();
    for (const file of files) {
      const date = file.dateMs ?? 0;
      keyDates.set(file.key!, Math.min(keyDates.get(file.key!) ?? date, date));
    }
    const vanished = [...emitted.keys()].filter((key) => !keyDates.has(key));
    // A message the index can no longer place may be in a file this cycle
    // could not name. Until every file is named, it is neither forgotten nor
    // left out.
    const unnamed = plan.unnamedFiles > 0 && vanished.length > 0;

    const gaps = [
      ...plan.walk.gaps,
      ...(unnamed
        ? [{ mailboxId: UNNAMED_FILES, reason: "some message files could not be read" }]
        : []),
    ];
    const partitions = [...plan.walk.mailboxes.map((m) => m.id), ...gaps.map((g) => g.mailboxId)];
    const snapshot = new SnapshotEnumeration(new Set(partitions));
    const gapped = new Set<string>();
    for (const gap of gaps) {
      if (gapped.has(gap.mailboxId)) continue;
      gapped.add(gap.mailboxId);
      snapshot.gap(gap.mailboxId, gap.reason);
    }

    const byMailbox = new Map<string, string[]>();
    const named = new Set<string>();
    for (const file of files) {
      const key = file.key!;
      if (!plan.mailboxDirs.has(file.mailboxId) || this.isInGap(plan, file.mailboxId)) continue;
      if (this.cutoffMs !== undefined && keyDates.get(key)! < this.cutoffMs) continue;
      const row = emitted.get(key);
      if (!row) continue;
      const ids = [key, ...attachmentChildIds(key, row.attachments)];
      for (const id of ids) named.add(id);
      if (named.size > this.limits.maxPresentIds) {
        throw tooLargeError(
          `The Maildir at ${this.options.root} names more than ${this.limits.maxPresentIds} documents`,
        );
      }
      const list = byMailbox.get(file.mailboxId);
      if (list) list.push(...ids);
      else byMailbox.set(file.mailboxId, ids);
    }
    for (const mailbox of plan.walk.mailboxes) {
      if (gapped.has(mailbox.id)) continue;
      snapshot.cover(mailbox.id, byMailbox.get(mailbox.id) ?? []);
    }
    return { snapshot, forget: unnamed ? [] : vanished };
  }
}
