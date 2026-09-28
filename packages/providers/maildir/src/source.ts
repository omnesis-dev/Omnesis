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
import { walkMaildir } from "./layout.js";
import { parseMessageFile, scanMessage } from "./message.js";
import { attachmentChildIds, normalizeMessage } from "./normalizer.js";
import type { AttachmentExtractionConfig, AttachmentExtractFn } from "@omnesis/core";
import type { SyncCursor, SyncOptions, SyncProgress, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type { EmittedRow, FileRow } from "./index-store.js";
import type { MaildirWalk, WalkLimits } from "./layout.js";
import type { MessagePlacement, NormalizeContext } from "./normalizer.js";

const log = createLogger("source:maildir");

/**
 * What the emitted documents mean. Part of every message's signature, so
 * raising it re-emits every message on the next cycle.
 */
const MAILDIR_OUTPUT_REVISION = 1;

const DEFAULT_LIMITS: MaildirLimits = {
  maxMailboxes: 2_000,
  maxFiles: 1_000_000,
  maxPresentIds: 1_000_000,
  emitPageSize: 50,
  scanPageSize: 1_000,
};
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
  /** The copies to read, in order: the first that opens is parsed. */
  paths: string[];
  signature: string;
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
  /** Files whose headers could not be read this cycle; not retried until the next one. */
  unscannable: Set<string>;
  /** Mailboxes that failed partway, beyond the walk's own gaps. */
  extraGaps: Array<{ mailboxId: string; reason: string }>;
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
    this.cutoffMs = options.dataCutoff ? new Date(options.dataCutoff).getTime() : undefined;
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
    if (this.syncInFlight) throw new Error("Maildir sync is already in progress");
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
    const unscanned = index
      .allFiles()
      .filter(
        (file) =>
          file.key === null &&
          plan.mailboxDirs.has(file.mailboxId) &&
          !plan.unscannable.has(fileKey(file.mailboxId, file.uniq)),
      );
    if (unscanned.length > 0) {
      const batch = unscanned.slice(0, this.limits.scanPageSize);
      await this.scan(batch, plan, index, signal);
      return {
        documents: [],
        deletedExternalIds: [],
        cursor: next,
        hasMore: true,
        progress: {
          phase: plan.bootstrap ? "bootstrap" : "incremental",
          processed: 0,
          detail: `Reading message headers: ${unscanned.length - batch.length} left`,
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
      throw new Error("The Maildir source was restarted while this page was being built");
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
      unscannable: new Set(),
      extraGaps: [],
      bootstrap,
    };
    this.reconcile(plan, index);
    return plan;
  }

  private isInGap(plan: CyclePlan, mailboxId: string): boolean {
    return [...plan.walk.gaps, ...plan.extraGaps].some(
      (gap) =>
        gap.mailboxId === mailboxId ||
        gap.mailboxId === "" ||
        mailboxId.startsWith(`${gap.mailboxId}/`),
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
    const scans: Array<{
      mailboxId: string;
      uniq: string;
      key: string;
      dateMs: number;
      size: number;
    }> = [];
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
        plan.unscannable.add(fileKey(file.mailboxId, file.uniq));
        if (isGoneError(err)) continue; // Moved or deleted since the walk; the next walk sees where.
        if (isAccessError(err)) {
          plan.extraGaps.push({
            mailboxId: file.mailboxId,
            reason: "a message file could not be read",
          });
        }
        log.warn(
          `Skipping unreadable message in ${plan.mailboxNames.get(file.mailboxId) ?? file.mailboxId}: ${err instanceof Error ? err.message : String(err)}`,
        );
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
      if (emitted.get(key)?.signature === entry.signature) continue;
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
    const folders = [...new Set(named.map((n) => n.name))].sort();
    const sent = files.some((file) => plan.sentMailboxes.has(file.mailboxId));
    const flagged = files.some((file) => file.flags.includes("F"));
    const answered = files.some((file) => file.flags.includes("R"));
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
    };
  }

  /**
   * Parse one message and build its documents.
   *
   * Returns nothing when no copy could be opened: every copy moved or went
   * since the walk, and the next cycle's walk finds where. A copy the process
   * may not read withholds this cycle's snapshot. A message that opens but
   * will not parse is recorded with no document, so it is not retried every
   * cycle until it changes.
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
        if (isGoneError(err)) continue;
        if (isAccessError(err)) {
          plan.extraGaps.push({ mailboxId: "", reason: "a message file could not be read" });
          log.warn(
            `Cannot read a message file: ${err instanceof Error ? err.message : String(err)}`,
          );
          return undefined;
        }
        log.warn(
          `Skipping a message that will not parse: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          documents: [],
          row: {
            key: entry.key,
            signature: entry.signature,
            seq,
            hasDocument: false,
            attachments: [],
          },
        };
      }
      const normalized = await normalizeMessage(parsed, entry, this.ctx);
      return {
        documents: normalized.documents,
        row: {
          key: entry.key,
          signature: entry.signature,
          seq,
          hasDocument: true,
          attachments: normalized.attachments,
        },
      };
    }
    return undefined;
  }

  /**
   * Name every message still on disk, one partition per folder.
   *
   * A message is named when it has a copy in a folder and was emitted with a
   * document — in this generation, which is the only one the gateway holds.
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
    const gaps = [...plan.walk.gaps, ...plan.extraGaps];
    const partitions = [...plan.walk.mailboxes.map((m) => m.id), ...gaps.map((g) => g.mailboxId)];
    const snapshot = new SnapshotEnumeration(new Set(partitions));
    const gapped = new Set<string>();
    for (const gap of gaps) {
      if (gapped.has(gap.mailboxId)) continue;
      gapped.add(gap.mailboxId);
      snapshot.gap(gap.mailboxId, gap.reason);
    }

    const files = index.allFiles().filter((file) => file.key !== null);
    // A message's date is its earliest copy's, as the emit stage decided it.
    const keyDates = new Map<string, number>();
    for (const file of files) {
      const date = file.dateMs ?? 0;
      keyDates.set(file.key!, Math.min(keyDates.get(file.key!) ?? date, date));
    }
    const byMailbox = new Map<string, string[]>();
    let named = 0;
    for (const file of files) {
      const key = file.key!;
      if (gapped.has(file.mailboxId) || !plan.mailboxDirs.has(file.mailboxId)) continue;
      if (this.cutoffMs !== undefined && keyDates.get(key)! < this.cutoffMs) continue;
      const row = emitted.get(key);
      if (!row?.hasDocument) continue;
      const ids = [key, ...attachmentChildIds(key, row.attachments, this.ctx)];
      named += ids.length;
      if (named > this.limits.maxPresentIds) {
        throw new SyncError(
          "unknown",
          `The Maildir at ${this.options.root} names more than ${this.limits.maxPresentIds} documents; use the source's exclude setting to leave some folders out`,
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
    const forget = [...emitted.keys()].filter((key) => !keyDates.has(key));
    return { snapshot, forget };
  }
}
