// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { createLogger, experimentalEnabled, readTypedFilterIdentifier } from "@omnesis/core";
import { accountResyncText } from "../../access/filter-wording.js";
import { runWithPriority } from "../../priority.js";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "../errors.js";
import type {
  DocumentAccessAudit,
  DocumentFilterDetailsView,
  FilterEditorField,
  FilterFieldCounts,
  SOURCE_FILTER_READS,
  SourceFilterPreview,
} from "../../access/source-filter-editor.js";
import type { FilterEditorResult, FilterOptionsRequest } from "../../access/filter-editor-reads.js";
import type { ReadPort } from "../../scheduler/read-port.js";
import type { FilterIdentifierType, FilterRef, SourceFilter } from "@omnesis/types";

const log = createLogger("gateway:source-filters");

export type SourceFilterReads = ReadPort<typeof SOURCE_FILTER_READS>;

/** How long a client waits before asking again for counts still being taken. */
export const FILTER_COUNTS_RETRY_MS = 1_500;
/** Whole-account passes run at once; more wait for a later request to start them. */
const MAX_BACKGROUND_PASSES = 2;
/** Results kept; the oldest go first. */
const CACHE_LIMIT = 512;
/** Interactive reads in flight at once. */
const MAX_CONCURRENT_READS = 4;

export interface SourceFilterEditorResponse {
  sourceId: string;
  sourceType: string;
  devices: Array<{ id: string; name: string }>;
  showDeviceLevel: boolean;
  profile: "declared" | "no-profile" | "collector-behind";
  profileText: string | null;
  /** False for an account that is gone while a saved filter still names it. */
  connected: boolean;
  /**
   * Present while fields of the account wait on a resync: every field in
   * `needs-resync`, or, when every field that is not ready is being resynced,
   * those. `text` is the one sentence to show for all of them.
   */
  resync?: SourceFilterResync;
  fields: Array<
    FilterEditorField & {
      counts: { status: "pending" } | ({ status: "ready" } & FilterFieldCounts);
    }
  >;
  retryAfterMs?: number;
}

export interface SourceFilterOptionsResponse {
  sourceId: string;
  field: string;
  items: Array<{
    ref: FilterRef;
    label: string;
    shortLabel: string;
    count: number | null;
    parentId?: string;
    hasChildren?: boolean;
    depth?: number;
    personId?: string;
  }>;
  nextCursor?: string;
  retryAfterMs?: number;
}

export interface SourceFilterResync {
  state: "needs-resync" | "resyncing";
  /** The fields it covers, in the editor's field order. */
  fields: string[];
  text: string;
  processed?: number;
  /** About how many records the read covers; absent on a first read, which has nothing to compare with. */
  total?: number;
}

/**
 * The account-level resync summary of an editor's fields; see
 * {@link SourceFilterEditorResponse.resync}. Fields come in declaration
 * order with people last, which is the order the sentence names them in.
 */
export function summarizeResync(
  sourceName: string,
  fields: readonly FilterEditorField[],
  contentNoun?: string,
): SourceFilterResync | undefined {
  const needs = fields.filter((field) => field.state.status === "needs-resync");
  if (needs.length > 0) {
    const first = needs[0]!.state;
    return {
      state: "needs-resync",
      fields: needs.map((field) => field.field),
      text: accountResyncText({
        status: "needs-resync",
        sourceName,
        fields: needs.map((field) => ({ noun: field.noun, person: field.capability === "person" })),
        cost: first.status === "needs-resync" ? first.cost : null,
        contentNoun,
      }),
    };
  }
  const waiting = fields.filter(
    (field) => field.state.status !== "ready" && field.state.status !== "disconnected",
  );
  if (waiting.length === 0 || !waiting.every((field) => field.state.status === "resyncing"))
    return undefined;
  const first = waiting[0]!.state;
  if (first.status !== "resyncing") return undefined;
  return {
    state: "resyncing",
    fields: waiting.map((field) => field.field),
    text: accountResyncText({
      status: "resyncing",
      sourceName,
      processed: first.processed,
      total: first.total,
      contentNoun,
    }),
    processed: first.processed,
    ...(first.total === null ? {} : { total: first.total }),
  };
}

export type SourceFilterPreviewResponse =
  { status: "pending"; retryAfterMs: number } | ({ status: "ready" } & SourceFilterPreview);

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

/**
 * Results of whole-account passes, keyed by what they depend on. A key that
 * is not cached starts its pass in the background, at most
 * {@link MAX_BACKGROUND_PASSES} at a time, and reads as pending until it lands.
 */
class PassCache {
  private readonly values = new Map<string, unknown>();
  private readonly inflight = new Set<string>();

  get<T>(key: string): T | undefined {
    if (!this.values.has(key)) return undefined;
    const value = this.values.get(key) as T;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  /** The cached value, or `undefined` after starting (or while waiting for) its pass. */
  getOrStart<T>(key: string, pass: () => Promise<T>): T | undefined {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    if (this.inflight.has(key) || this.inflight.size >= MAX_BACKGROUND_PASSES) return undefined;
    this.inflight.add(key);
    void Promise.resolve(runWithPriority("user", pass))
      .then((value) => {
        if (value === undefined) return;
        this.values.set(key, value);
        while (this.values.size > CACHE_LIMIT) {
          const oldest = this.values.keys().next().value;
          if (oldest === undefined) break;
          this.values.delete(oldest);
        }
      })
      .catch((error: unknown) => {
        log.warn(
          `Filter count pass failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => this.inflight.delete(key));
    return undefined;
  }
}

function unwrap<T>(result: FilterEditorResult<T> | null): T {
  if (!result) throw new NotFoundError("Source filter metadata was not found.");
  if (result.ok) return result.value;
  switch (result.error) {
    case "source-not-found":
      throw new NotFoundError("Source filter metadata was not found.");
    case "unsupported-field":
      throw new BadRequestError("This field cannot be filtered on.");
    case "invalid-cursor":
      throw new BadRequestError("This page of results has expired. Search again.");
    case "invalid-filter":
      throw new BadRequestError("This filter cannot be applied to this source.");
  }
}

/**
 * The owner's filter screens over the read worker. Structure and lists come
 * back at once; counts that need a pass over the whole account come back as
 * pending and are taken in the background, so no request waits for them.
 */
export class SourceFilterService {
  private active = 0;
  private readonly passes = new PassCache();

  constructor(
    private readonly reads: Partial<SourceFilterReads> | undefined,
    private readonly canInspectSavedSource: (sourceId: string) => boolean = () => false,
    /** The source's own word for what an account holds ("emails"), when known. */
    private readonly contentNoun: (sourceId: string) => string | undefined = () => undefined,
  ) {}

  private assertEditable(sourceId: string): void {
    if (!experimentalEnabled() && !this.canInspectSavedSource(sourceId))
      throw new NotFoundError("Source filter editing is not enabled.");
  }

  private port(): SourceFilterReads {
    const reads = this.reads;
    if (
      !reads?.sourceFilterEditor ||
      !reads.sourceFilterFieldCounts ||
      !reads.sourceFilterOptionsPage ||
      !reads.sourceFilterEntryCounts ||
      !reads.sourceFilterPreview ||
      !reads.documentFilterDetails ||
      !reads.documentAccessAudit
    )
      throw new ServiceUnavailableError("Source filter editing requires an available read worker.");
    return reads as SourceFilterReads;
  }

  private async interactive<T>(read: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_READS)
      throw new ServiceUnavailableError("Filter previews are busy. Try again shortly.");
    this.active++;
    try {
      return await runWithPriority("user", read);
    } finally {
      this.active--;
    }
  }

  async editor(sourceId: string): Promise<SourceFilterEditorResponse> {
    this.assertEditable(sourceId);
    const reads = this.port();
    const structure = await this.interactive(() => reads.sourceFilterEditor(sourceId));
    if (!structure) throw new NotFoundError("Source filter metadata was not found.");
    let pending = false;
    const fields = structure.fields.map((field) => {
      // A gone account has nothing to count.
      const counts = !structure.connected
        ? { tooOld: 0, unmatched: 0, tooOldText: null, unmatchedText: null }
        : this.passes.getOrStart(
            digest(["field-counts", structure.stamp, field.field]),
            async () =>
              (await reads.sourceFilterFieldCounts(sourceId, field.field)) ?? {
                tooOld: 0,
                unmatched: 0,
                tooOldText: null,
                unmatchedText: null,
              },
          );
      if (!counts) pending = true;
      return {
        ...field,
        counts: counts ? { status: "ready" as const, ...counts } : { status: "pending" as const },
      };
    });
    if (fields.some((field) => field.state.status === "resyncing")) pending = true;
    const resync = summarizeResync(
      structure.sourceName,
      structure.fields,
      this.contentNoun(sourceId),
    );
    return {
      sourceId: structure.sourceId,
      sourceType: structure.sourceType,
      devices: structure.devices,
      showDeviceLevel: structure.showDeviceLevel,
      profile: structure.profile,
      profileText: structure.profileText,
      connected: structure.connected,
      ...(resync ? { resync } : {}),
      fields,
      ...(pending ? { retryAfterMs: FILTER_COUNTS_RETRY_MS } : {}),
    };
  }

  async options(request: FilterOptionsRequest): Promise<SourceFilterOptionsResponse> {
    this.assertEditable(request.sourceId);
    const reads = this.port();
    const page = unwrap(await this.interactive(() => reads.sourceFilterOptionsPage(request)));
    const refs = page.items.map((item) => item.ref);
    const counts =
      refs.length === 0
        ? []
        : this.passes.getOrStart(
            digest(["entry-counts", page.stamp, refs]),
            async () => await reads.sourceFilterEntryCounts(request.sourceId, refs),
          );
    return {
      sourceId: page.sourceId,
      field: page.field,
      items: page.items.map((item, index) => ({ ...item, count: counts?.[index] ?? null })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      ...(counts ? {} : { retryAfterMs: FILTER_COUNTS_RETRY_MS }),
    };
  }

  async preview(sourceId: string, filter: SourceFilter): Promise<SourceFilterPreviewResponse> {
    this.assertEditable(sourceId);
    const reads = this.port();
    const structure = await this.interactive(() => reads.sourceFilterEditor(sourceId));
    if (!structure) throw new NotFoundError("Source filter metadata was not found.");
    // A gone account is only named, never counted: answered at once.
    if (!structure.connected)
      return {
        status: "ready",
        ...unwrap(await this.interactive(() => reads.sourceFilterPreview(sourceId, filter))),
      };
    const key = digest(["preview", structure.stamp, filter]);
    const cached = this.passes.get<FilterEditorResult<SourceFilterPreview>>(key);
    if (cached) return { status: "ready", ...unwrap(cached) };
    this.passes.getOrStart(key, async () => await reads.sourceFilterPreview(sourceId, filter));
    return { status: "pending", retryAfterMs: FILTER_COUNTS_RETRY_MS };
  }

  identifier(
    type: FilterIdentifierType,
    value: string,
  ): ReturnType<typeof readTypedFilterIdentifier> {
    return readTypedFilterIdentifier(type, value);
  }

  async documentFilterDetails(
    documentId: string,
  ): Promise<Omit<DocumentFilterDetailsView, "sourceId">> {
    const reads = this.port();
    const view = await this.interactive(() => reads.documentFilterDetails(documentId));
    if (!view) throw new NotFoundError("Document not found.");
    const { sourceId, ...details } = view;
    // Without filter editing, a document has no filter details to show
    // unless its account already carries a saved filter.
    if (!experimentalEnabled() && !this.canInspectSavedSource(sourceId))
      return { ...details, fields: [] };
    return details;
  }

  async documentAccess(documentId: string): Promise<DocumentAccessAudit> {
    const reads = this.port();
    const audit = await this.interactive(() => reads.documentAccessAudit(documentId, Date.now()));
    if (!audit) throw new NotFoundError("Document not found.");
    return audit;
  }
}
