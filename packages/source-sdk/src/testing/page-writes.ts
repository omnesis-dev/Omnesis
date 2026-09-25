// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading a sync page's analytics writes, for a test that asserts on them.
 *
 * A page names the tables it fills, and a source with several fills more than
 * one, so "the rows this page wrote" is a question with a table in it. These
 * answer it without a test having to know whether the page spelled its writes
 * as one entry or a list.
 */

import { tableWrites, type PageTableWrites, type TableWrite } from "../table-write.js";
import type { EmittedRow } from "./sync-cycle.js";

/** Just the analytics part of a page — both result shapes carry one. */
interface PageWithAnalytics {
  analytics?: PageTableWrites;
}

/**
 * Every row a page writes to one table, in order.
 *
 * Concatenates across writes when the page names the table more than once,
 * which is how a source spells "clear these, then write these": asking for
 * the rows should give all of them, not the first batch.
 */
export function rowsFor(page: PageWithAnalytics, tableName: string): Record<string, unknown>[] {
  return tableWrites(page.analytics)
    .filter((w) => w.tableName === tableName)
    .flatMap((w) => w.records ?? []);
}

/**
 * The tables a page writes, in the order the host will write them, with a
 * table named twice appearing twice.
 *
 * The repetition is the point: a test asserting that a clear precedes its
 * rewrite is asserting about this sequence.
 */
export function tablesWritten(page: PageWithAnalytics): string[] {
  return tableWrites(page.analytics).map((w) => w.tableName);
}

/** Every key a page asks to delete from one table, in order. */
export function deletionsFor(page: PageWithAnalytics, tableName: string): string[] {
  return deletionKeysFor(page, tableName).map((key) => {
    const values = Object.values(key);
    if (values.length !== 1) {
      throw new Error(
        `deletionsFor(${tableName}) reads one-column keys; this page names ` +
          `(${Object.keys(key).join(", ")}). Use deletionKeysFor.`,
      );
    }
    return String(values[0]);
  });
}

/** The rows a page deletes from one table, as the keys it named them by. */
export function deletionKeysFor(
  page: PageWithAnalytics,
  tableName: string,
): Record<string, unknown>[] {
  return tableWrites(page.analytics)
    .filter((w) => w.tableName === tableName)
    .flatMap((w) => [
      ...(w.deletedKeys ?? []),
      ...(w.deletedIds ?? []).map((id) => ({ [w.deleteKeyColumn ?? "id"]: id })),
    ]);
}

/**
 * The page's writes to one table, unflattened — for a test that needs the
 * schema, the delete key column or the snapshot rather than the rows.
 */
export function writesFor(page: PageWithAnalytics, tableName: string): TableWrite[] {
  return tableWrites(page.analytics).filter((w) => w.tableName === tableName);
}

/**
 * A page's rows as the sync-cycle contract wants them: every table it writes,
 * each row tagged with the table it belongs to.
 *
 * This is the whole page, not the one table a caller happened to have in mind
 * — which is the point, since a source whose upstream record fans out is
 * exactly the one whose no-op behaviour is worth checking.
 */
export function emittedRows(page: PageWithAnalytics): EmittedRow[] {
  return tableWrites(page.analytics).flatMap((w) =>
    (w.records ?? []).map((row) => ({ table: w.tableName, row })),
  );
}
