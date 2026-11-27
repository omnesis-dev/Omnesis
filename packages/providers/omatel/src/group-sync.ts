// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { SnapshotEnumeration, type StructuredSyncResult } from "@omnesis/source-sdk";
import { historyCoverage } from "./coverage.js";

/**
 * Both omatel sources render one document per group of rows — a conversation's
 * day, or a day of calls — and omatel has no modification time to watch: a
 * message changes in place when it is delivered, read or retried, and the
 * owner can delete a message, a conversation or a call. So every page reads
 * the whole store (a phone's history is small) and compares a fingerprint of
 * each group with the one it rendered last time. Only changed groups are
 * rendered and sent; groups that disappeared are deleted by their document id.
 *
 * Every cycle that read the store ends by naming every row it holds to the
 * analytics plane, changed or not: the gateway deletes a row only after
 * several spaced snapshots have omitted it, so a snapshot sent only when
 * something changed would leave a deleted row in place until the next edit.
 */
export type OmatelCursor = {
  /**
   * Version of how groups are rendered. A cursor from another rendering
   * version reads as empty, so every group renders again with the same ids.
   */
  render: number;
  /** Fingerprint of every group as last rendered, by group key. */
  groups: Record<string, string>;
};

export function isOmatelCursor(value: unknown): value is OmatelCursor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.render !== "number" || !Number.isInteger(v.render)) return false;
  if (typeof v.groups !== "object" || v.groups === null || Array.isArray(v.groups)) return false;
  return Object.values(v.groups).every((h) => typeof h === "string");
}

/** Short, stable fingerprint of a group's rows and the context they render in. */
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export interface PagePlan {
  /** Groups to render on this page, in key order. */
  render: string[];
  /** Groups rendered before that no longer exist. */
  removed: string[];
  /** Whether changed groups are left for later pages. */
  hasMore: boolean;
  /** The cursor once this page is written. */
  next: OmatelCursor;
}

/**
 * Decide what one page renders, given what the store holds now.
 *
 * A group whose fingerprint differs from the cursor's, or that the cursor has
 * never seen, is rendered; at most `pageSize` of them per page. Removals are
 * taken all at once: they cost an id each.
 */
export function planPage(
  previous: OmatelCursor | null,
  current: ReadonlyMap<string, string>,
  renderVersion: number,
  pageSize: number,
): PagePlan {
  const prior = previous && previous.render === renderVersion ? previous.groups : {};
  const changed = [...current.keys()].filter((key) => prior[key] !== current.get(key)).sort();
  const removed = Object.keys(prior)
    .filter((key) => !current.has(key))
    .sort();
  const render = changed.slice(0, pageSize);
  const hasMore = changed.length > pageSize;
  const groups: Record<string, string> = {};
  for (const [key, hash] of Object.entries(prior)) {
    if (current.has(key)) groups[key] = hash;
  }
  for (const key of render) groups[key] = current.get(key)!;
  return { render, removed, hasMore, next: { render: renderVersion, groups } };
}

/**
 * The page for a store that is not on disk to read.
 *
 * omatel creates each store the first time its app needs it, so while
 * nothing has been indexed from it a missing store is one not created yet,
 * and the page reports an empty, complete read. Once groups have been
 * rendered from it, a missing store is no evidence that the owner deleted
 * everything — the file may be mid-replace or its folder moved — so the page
 * keeps the cursor, deletes nothing, sends no analytics snapshot, and reports
 * the snapshot as withheld until the store reads again.
 */
export function storeUnavailablePage(
  previous: OmatelCursor | null,
  renderVersion: number,
  file: string,
  dataCutoff: string | undefined,
): StructuredSyncResult<OmatelCursor> {
  const observed = previous !== null && Object.keys(previous.groups).length > 0;
  if (observed) {
    return {
      documents: [],
      deletedExternalIds: [],
      cursor: previous,
      hasMore: false,
      issues: [
        new SnapshotEnumeration(["store"])
          .gap("store", `omatel's ${file} is missing; what was indexed from it is kept`)
          .withheldIssue()!,
      ],
    };
  }
  return {
    documents: [],
    deletedExternalIds: [],
    cursor: previous ?? { render: renderVersion, groups: {} },
    hasMore: false,
    issues: [],
    progress: {
      phase: previous === null ? "bootstrap" : "incremental",
      processed: 0,
      total: 0,
      percentComplete: 100,
      ...historyCoverage(dataCutoff),
    },
  };
}

/** Group rows by key, keeping each group's rows in the order they were read. */
export function groupRows<Row>(
  rows: Iterable<Row>,
  keyOf: (row: Row) => string,
): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** UTC calendar day (`YYYY-MM-DD`) of an epoch-milliseconds instant. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC wall-clock time (`HH:MM`) of an epoch-milliseconds instant. */
export function utcTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

/** The epoch-milliseconds lower bound a `dataCutoff` sets, or 0 for none. */
export function cutoffMs(dataCutoff: string | undefined): number {
  if (!dataCutoff) return 0;
  const ms = Date.parse(dataCutoff);
  return Number.isFinite(ms) ? ms : 0;
}
