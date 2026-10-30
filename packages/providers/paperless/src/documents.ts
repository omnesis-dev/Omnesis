// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createLogger } from "@omnesis/core";
import { SnapshotEnumeration } from "@omnesis/source-sdk";
import { SyncError } from "@omnesis/types";
import { isDocumentId } from "./types.js";
import { normalizeDocument } from "./normalizer.js";
import { paperlessCustomFieldValuesSchema, paperlessDocumentsSchema } from "./schemas.js";
import type { ProviderId, SourceId, SyncIssue } from "@omnesis/types";
import type { StructuredSyncResult, SyncOptions, TableWrite } from "@omnesis/source-sdk";
import type { DocumentListingEntry, PaperlessClient } from "./client.js";
import type {
  PaperlessCustomFieldInstance,
  PaperlessDocument,
  PaperlessDocumentsCursor,
  PaperlessLookups,
} from "./types.js";

const log = createLogger("source:paperless-documents");

/**
 * Documents fetched per page. Each carries its full OCR text, so this is what
 * bounds one response — and one writer burst on the gateway — on small NAS
 * hardware.
 */
const PAGE_SIZE = 25;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Defensive bound, not a partial-enumeration policy: a listing past it fails
 * the page without advancing state or asserting absence. It keeps the
 * cursor, which carries one entry per document, inside its state ceiling.
 */
const MAX_SNAPSHOT_ITEMS = 500_000;
const DOCUMENTS_PARTITION = "documents";

export interface PaperlessDocumentsSourceOptions {
  /** Injectable clock for deterministic tests. */
  now?: () => string;
  pageSize?: number;
  snapshotIntervalMs?: number;
}

/**
 * Hybrid source: each page emits searchable documents plus their
 * `paperless_documents` rows and `paperless_custom_field_values` rows. See
 * `PaperlessDocumentsCursor` for how sweeps are planned and why each walks a
 * fixed id list rather than Paperless's own page numbers.
 */
export class PaperlessDocumentsSource {
  private readonly now: () => string;
  private readonly pageSize: number;
  private readonly snapshotIntervalMs: number;
  private selfUserId: Promise<number> | undefined;

  constructor(
    private readonly client: PaperlessClient,
    private readonly providerId: ProviderId,
    private readonly sourceId: SourceId,
    /** Stamped on every row so a sibling instance's rows stay distinguishable. */
    private readonly accountId: string,
    private readonly dataCutoff: string | undefined,
    opts: PaperlessDocumentsSourceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.pageSize = opts.pageSize ?? PAGE_SIZE;
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS;
  }

  async syncStructured(
    cursor: PaperlessDocumentsCursor | null,
    opts: SyncOptions = {},
  ): Promise<StructuredSyncResult<PaperlessDocumentsCursor>> {
    const { signal } = opts;
    const syncedAt = this.now();
    // Fetched every page, never carried in the cursor: a rename between pages
    // then shows on the documents still to come, and the fingerprints recorded
    // at the sweep's start differ next time, so the next sweep re-renders all.
    const lookups = await this.client.lookups(signal);
    const selfUserId = await this.whoami(signal);
    const sweep = cursor?.pending
      ? resumeSweep(cursor)
      : await this.startSweep(cursor, lookups, syncedAt, signal);

    const batch = sweep.pending.slice(0, this.pageSize);
    const rest = sweep.pending.slice(this.pageSize);
    const { fetched, unreadable } = await this.fetchBatch(batch, signal);

    const wanted = new Set(batch);
    const known = sweep.known ? { ...sweep.known } : undefined;
    const skipped = [...sweep.skipped, ...unreadable];
    const documents = [];
    const rows: Record<string, unknown>[] = [];
    const fieldRows: Record<string, unknown>[] = [];
    const rendered: number[] = [];
    for (const doc of fetched) {
      if (!doc || !wanted.has(doc.id)) continue;
      // One document that cannot be read is that document's problem, not the
      // page's: its prior copy stays as it was, the rest of the page lands,
      // and it is reported and tried again at the next snapshot.
      let out: ReturnType<typeof normalizeDocument> | undefined;
      if (isWellFormed(doc)) {
        try {
          out = normalizeDocument(doc, lookups, {
            providerId: this.providerId,
            sourceId: this.sourceId,
            accountId: this.accountId,
            selfUserId,
            documentUrl: (id) => this.client.documentUrl(id),
            syncedAt,
          });
        } catch (err) {
          log.warn(`Could not render Paperless-ngx document ${doc.id}: ${(err as Error).message}`);
        }
      }
      if (!out) {
        skipped.push(doc.id);
        continue;
      }
      documents.push(out.document);
      rows.push(out.row);
      fieldRows.push(...out.fieldRows);
      rendered.push(doc.id);
      if (known) known[String(doc.id)] = fieldFingerprint(doc.custom_fields);
    }
    // An id the listing named and the fetch did not return was deleted
    // between the two requests. Nothing is said about it here: the next
    // snapshot is what decides absence, from its own listing.
    for (const id of unreadable) log.warn(`Paperless-ngx could not serve document ${id}`);
    // Forgotten, so the next snapshot treats it as never read and tries again.
    if (known) for (const id of skipped) delete known[String(id)];

    const done = rest.length === 0;
    const presentIds = done ? sweep.enumeration?.cover(DOCUMENTS_PARTITION).result() : undefined;
    const presentDocIds = presentIds?.map(Number);
    const account = this.accountId;

    const analytics: TableWrite[] = [
      {
        tableName: paperlessDocumentsSchema.tableName,
        records: rows,
        ...(presentDocIds
          ? { presentKeys: presentDocIds.map((id) => ({ source_account_id: account, id })) }
          : {}),
      },
      // A document's custom field values are re-read whole, so they are
      // replaced whole: the deletion first, then the rows, in two writes —
      // within one write the host would delete the rows it had just stored.
      {
        tableName: paperlessCustomFieldValuesSchema.tableName,
        deletedKeys: rendered.map((document_id) => ({ source_account_id: account, document_id })),
      },
      {
        tableName: paperlessCustomFieldValuesSchema.tableName,
        records: fieldRows,
        ...(presentDocIds
          ? {
              presentKeys: presentDocIds.map((document_id) => ({
                source_account_id: account,
                document_id,
              })),
            }
          : {}),
      },
    ];

    if (!done) {
      return {
        analytics,
        documents,
        cursor: {
          phase: sweep.phase,
          watermark: cursor?.watermark,
          sweepWatermark: sweep.sweepWatermark,
          pending: rest,
          lookups: sweep.lookups,
          ...(known ? { known } : {}),
          ...(skipped.length > 0 ? { skipped } : {}),
          lastSnapshotAt: cursor?.lastSnapshotAt,
          ...(sweep.enumeration ? { snapshot: sweep.enumeration.toLedger() } : {}),
        },
        hasMore: true,
      };
    }

    if (sweep.phase === "full") log.info(`Full sweep complete for ${this.accountId}`);
    return {
      analytics,
      documents,
      ...(presentIds !== undefined
        ? { presentExternalIds: presentIds, issues: skippedIssues(skipped) }
        : {}),
      cursor: {
        phase: "incremental",
        watermark: newer(cursor?.watermark, sweep.sweepWatermark),
        lookups: sweep.lookups,
        ...(known ? { known } : {}),
        lastSnapshotAt: presentIds !== undefined ? syncedAt : cursor?.lastSnapshotAt,
      },
      hasMore: false,
    };
  }

  /** The token's own Paperless user id, asked once per source instance. */
  private whoami(signal: AbortSignal | undefined): Promise<number> {
    this.selfUserId ??= this.client.whoami(signal).then((u) => u.id);
    // A failed ask is not remembered, so the next page asks again.
    this.selfUserId.catch(() => (this.selfUserId = undefined));
    return this.selfUserId;
  }

  /**
   * Fetch one page's documents. A document the server fails to serialize
   * fails the whole batch request, so a failed batch is retried one id at a
   * time; ids that still fail on a server that otherwise answers are that
   * document's problem and come back as `unreadable`, while a server that
   * answers nothing fails the page as it would have.
   */
  private async fetchBatch(
    ids: number[],
    signal: AbortSignal | undefined,
  ): Promise<{ fetched: PaperlessDocument[]; unreadable: number[] }> {
    try {
      return { fetched: await this.client.getDocuments(ids, signal), unreadable: [] };
    } catch (err) {
      if (!(err instanceof SyncError) || err.kind !== "transient") throw err;
      const fetched: PaperlessDocument[] = [];
      const unreadable: number[] = [];
      for (const id of ids) {
        try {
          fetched.push(...(await this.client.getDocuments([id], signal)));
        } catch (one) {
          if (!(one instanceof SyncError) || one.kind !== "transient") throw one;
          unreadable.push(id);
        }
      }
      if (fetched.length === 0) await this.client.whoami(signal);
      return { fetched, unreadable };
    }
  }

  /**
   * Plan a sweep: decide what kind it is, list its ids, and note the newest
   * `modified` as the watermark it will promote.
   */
  private async startSweep(
    cursor: PaperlessDocumentsCursor | null,
    lookups: PaperlessLookups,
    syncedAt: string,
    signal: AbortSignal | undefined,
  ): Promise<Sweep> {
    const fingerprints = lookupFingerprints(lookups);
    const lookupsChanged = !!cursor?.lookups && changedEntries(cursor.lookups, fingerprints);
    const snapshotDue =
      !cursor?.lastSnapshotAt ||
      Date.parse(syncedAt) - Date.parse(cursor.lastSnapshotAt) >= this.snapshotIntervalMs;
    const phase: PaperlessDocumentsCursor["phase"] =
      !cursor?.watermark || !cursor.lookups || lookupsChanged
        ? "full"
        : snapshotDue
          ? "snapshot"
          : "incremental";
    if (lookupsChanged) {
      log.info(`Paperless-ngx metadata changed for ${this.accountId}; re-reading every document`);
    }

    const createdFrom = this.dataCutoff ? this.dataCutoff.slice(0, 10) : undefined;
    const listing = await this.client.listDocuments(
      {
        ...(phase === "incremental" ? { modifiedAfter: cursor?.watermark } : {}),
        ...(createdFrom ? { createdFrom } : {}),
        withCustomFields: phase !== "incremental",
      },
      signal,
    );
    validateListing(listing);

    if (phase === "incremental") {
      return {
        phase,
        pending: listing.map((e) => e.id),
        sweepWatermark: newestModified(listing),
        lookups: fingerprints,
        known: cursor?.known,
        skipped: [],
        enumeration: undefined,
      };
    }

    if (listing.length > MAX_SNAPSHOT_ITEMS) {
      throw new SyncError(
        "unknown",
        `Paperless-ngx listed ${listing.length} documents, past the ${MAX_SNAPSHOT_ITEMS} one source can track`,
      );
    }
    const enumeration = SnapshotEnumeration.resume([DOCUMENTS_PARTITION], undefined).add(
      DOCUMENTS_PARTITION,
      listing.map((e) => String(e.id)),
    );
    const known = Object.fromEntries(
      listing.map((e) => [String(e.id), fieldFingerprint(e.custom_fields)]),
    );

    // A snapshot re-reads what changed since the watermark, what it has never
    // read, and documents whose custom fields changed without `modified`
    // moving; the rest is named present without being fetched.
    const prior = cursor?.known;
    const since = phase === "snapshot" ? modifiedKey(cursor!.watermark!) : undefined;
    const pending = listing
      .filter(
        (e) =>
          since === undefined ||
          modifiedKey(e.modified) > since ||
          prior?.[String(e.id)] !== known[String(e.id)],
      )
      .map((e) => e.id);

    return {
      phase,
      pending,
      sweepWatermark: newestModified(listing),
      lookups: fingerprints,
      known,
      skipped: [],
      enumeration,
    };
  }
}

interface Sweep {
  phase: PaperlessDocumentsCursor["phase"];
  pending: number[];
  sweepWatermark: string | undefined;
  lookups: Record<string, string>;
  known: Record<string, string> | undefined;
  skipped: number[];
  enumeration: SnapshotEnumeration | undefined;
}

function resumeSweep(cursor: PaperlessDocumentsCursor): Sweep {
  return {
    phase: cursor.phase,
    pending: cursor.pending ?? [],
    sweepWatermark: cursor.sweepWatermark,
    lookups: cursor.lookups ?? {},
    known: cursor.known,
    skipped: cursor.skipped ?? [],
    enumeration:
      cursor.phase === "incremental"
        ? undefined
        : SnapshotEnumeration.resume([DOCUMENTS_PARTITION], cursor.snapshot),
  };
}

/** The sweep's documents that could not be read, as the issue an operator sees. */
function skippedIssues(skipped: number[]): SyncIssue[] {
  if (skipped.length === 0) return [];
  const ids = [...new Set(skipped)];
  return [
    {
      scope: "item",
      kind: "unknown",
      code: "paperless-unreadable-document",
      count: ids.length,
      subject: ids.slice(0, 20).join(", "),
      message: `Paperless-ngx could not serve ${ids.length} document${ids.length === 1 ? "" : "s"}; ${ids.length === 1 ? "it is" : "they are"} tried again at the next snapshot.`,
    },
  ];
}

/**
 * A listing has unique ids and parseable times; anything else would plan a
 * sweep on a list that cannot be trusted, so it fails the page before any
 * state moves.
 */
function validateListing(listing: DocumentListingEntry[]): void {
  const seen = new Set<number>();
  for (const entry of listing) {
    if (
      !entry ||
      !isDocumentId(entry.id) ||
      seen.has(entry.id) ||
      typeof entry.modified !== "string" ||
      !Number.isFinite(Date.parse(entry.modified))
    ) {
      throw new SyncError("unknown", "Paperless-ngx returned an invalid document listing");
    }
    seen.add(entry.id);
  }
}

function isWellFormed(doc: PaperlessDocument): boolean {
  return (
    isDocumentId(doc.id) &&
    typeof doc.modified === "string" &&
    Number.isFinite(Date.parse(doc.modified)) &&
    Array.isArray(doc.tags)
  );
}

/** The newest `modified` in a listing. */
function newestModified(listing: DocumentListingEntry[]): string | undefined {
  let best: string | undefined;
  for (const { modified } of listing) best = newer(best, modified);
  return best;
}

function newer(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return modifiedKey(b) > modifiedKey(a) ? b : a;
}

/**
 * A `modified` value as microseconds since the epoch. Paperless writes
 * microseconds and `Date.parse` keeps milliseconds, so two edits in one
 * millisecond would otherwise compare equal and the later could be missed.
 */
function modifiedKey(value: string): number {
  const ms = Date.parse(value);
  const fraction = /T[^.]*\.(\d+)/.exec(value)?.[1] ?? "";
  const micros = Number(fraction.padEnd(6, "0").slice(0, 6));
  return Math.floor(ms / 1000) * 1_000_000 + micros;
}

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 10);
}

/** A document's custom field values, as one short comparable string. */
function fieldFingerprint(fields: PaperlessCustomFieldInstance[] | null | undefined): string {
  if (!Array.isArray(fields) || fields.length === 0) return "";
  const sorted = [...fields]
    .filter((f) => f && typeof f.field === "number")
    .sort((a, b) => a.field - b.field)
    .map((f) => [f.field, f.value ?? null]);
  return shortHash(sorted);
}

/** Everything about each lookup entry that changes how a document reads, keyed by kind and id. */
function lookupFingerprints(lookups: PaperlessLookups): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, name] of lookups.tags) out[`t${id}`] = shortHash(name);
  for (const [id, name] of lookups.correspondents) out[`c${id}`] = shortHash(name);
  for (const [id, name] of lookups.documentTypes) out[`d${id}`] = shortHash(name);
  for (const [id, f] of lookups.customFields) {
    out[`f${id}`] = shortHash([f.name, f.data_type, f.extra_data ?? null]);
  }
  return out;
}

/**
 * Whether any entry the last sweep rendered with was renamed or removed. An
 * added entry is not a change: no document refers to it until that document
 * is edited, which moves its own `modified`.
 */
function changedEntries(prior: Record<string, string>, current: Record<string, string>): boolean {
  return Object.entries(prior).some(([key, value]) => current[key] !== value);
}
