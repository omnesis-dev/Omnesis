// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a sync page writes to one analytics table.
 *
 * ## Why a page describes several tables
 *
 * A page used to describe exactly one: `tableName` and `records` sat on the
 * result, alongside that table's deletions, its schema and its snapshot. That
 * is the right shape for a source whose upstream record is a row. It is the
 * wrong shape for one whose upstream record fans out — an activity that is
 * also its splits, its laps, its best efforts and its segment efforts, each a
 * table of its own.
 *
 * A source in that position had one way out: write the other tables through
 * the host's analytics handle, outside the page. That works, and it costs
 * everything the page is for. A write outside the page is not covered by the
 * cursor that follows it, so a crash between the two leaves rows the cursor
 * says were never fetched. It is not fenced by the write epoch, so a wipe
 * racing a sync can be undone by a write the wipe did not know about. It is
 * not checked against the sync lease, so a member that has lost the lease
 * still writes. And it is invisible to the replica ledger, which reasons about
 * who wrote what from the pages it sees.
 *
 * None of that was a decision. It was the shape of the result type, and a
 * source with five tables to fill worked around it.
 *
 * So the page carries a list. One table stays a one-liner — the field accepts
 * a bare {@link TableWrite} — and a source with five tables names five,
 * getting the checkpoint, the epoch, the lease and the ledger for all of them
 * because there is no longer a reason to leave.
 *
 * ## What belongs on one page, and what does not
 *
 * A page groups writes that must land *together*. An upstream record that fans
 * out is the case it exists for: the parent row and its children are one read,
 * and a checkpoint between them could claim the parent was stored while its
 * children were not.
 *
 * Writes that merely happen to be available at the same moment are a different
 * thing, and putting them on one page makes the source worse. A source that
 * already holds its account list and is about to walk each account's history
 * over the network should write the accounts on their own page: that page
 * checkpoints, so a failure in the network walk that follows leaves the
 * accounts stored rather than rolling them back into the retry. Splitting
 * there is not a workaround for anything — it is how partial progress
 * survives.
 *
 * The question to ask is not "are these rows in hand at the same time" but
 * "would a checkpoint between them be a lie". If the answer is no, they are
 * two pages.
 *
 * ## Order is preserved and duplicates are allowed
 *
 * The host writes these in the order given, so a source that must fill a
 * parent before its children can rely on it. The same table may appear twice:
 * a page that rewrites one set of rows and then another is two writes, not one
 * merged set, and merging them would silently drop the second write's
 * intention to follow the first.
 */

import type { AnalyticsTableSchema } from "./structured-source.js";
import type { RowKey } from "./row-key.js";

/** One table's worth of a page: rows to write, rows to remove, or both. */
export interface TableWrite {
  /** The table these rows belong to. */
  tableName: string;

  /**
   * Rows to insert or update, matched on the table's declared primary key.
   *
   * Ingest is at-least-once, so a replayed page rewrites rows it already
   * wrote; the primary key is what makes that harmless.
   */
  records?: Record<string, unknown>[];

  /**
   * Rows to delete, each named by the table's declared delete key.
   *
   * A key is a record over `AnalyticsTableSchema.deleteKey` (or, when the
   * table declares none, over its primary key): `{ item_id, transaction_id }`
   * for a table keyed by both, `{ activity_id }` for one whose upstream
   * addresses whole activities. The host refuses a key that does not name
   * exactly those columns, rather than deleting by the part of it that
   * matches — a partial key silently means "and everything else that shares
   * these values".
   *
   * Which columns those are is the table's own declaration, not this page's:
   * a page free to choose would let one table be addressed two ways, and the
   * absence and replica ledgers built on these keys hold both with nothing to
   * tell them apart.
   */
  deletedKeys?: Record<string, unknown>[];

  /**
   * Values identifying rows to delete, matched against a single column.
   *
   * @deprecated Superseded by {@link deletedKeys}. Kept for a source that has
   * not migrated; the host normalises it into a one-column key and refuses a
   * page that sets both.
   */
  deletedIds?: string[];

  /**
   * The column {@link deletedIds} and {@link presentIds} values match on.
   *
   * @deprecated The delete key belongs to the table
   * (`AnalyticsTableSchema.deleteKey`), not to a page.
   */
  deleteKeyColumn?: string;

  /**
   * This table's schema, when the source discovers it at runtime rather than
   * declaring it statically.
   *
   * A source whose columns are fixed declares them once on the instance and
   * omits this. A source whose columns come from the upstream — a database
   * whose properties the user defines — sends the shape it just observed, and
   * the host creates or evolves the table to match.
   */
  schema?: AnalyticsTableSchema;

  /**
   * Every row currently present upstream, for this table, each named by the
   * table's declared delete key.
   *
   * Set it only on the final page of a walk that saw the whole table; a
   * partial view here reads as "everything else is gone". A row the snapshot
   * omits is recorded as absent rather than deleted outright, and a later
   * snapshot naming it again clears the record — but the deadline is real, so
   * omit the field entirely for a read you cannot vouch for. An omitted
   * snapshot does nothing at all, which is the safe answer.
   */
  presentKeys?: Record<string, unknown>[];

  /**
   * Every row identifier currently present upstream, as single-column values.
   *
   * @deprecated Superseded by {@link presentKeys}, on the same terms as
   * {@link deletedIds}.
   */
  presentIds?: string[];
}

/**
 * The analytics writes a page makes: one table, several, or none.
 *
 * The bare form exists because most sources write one table and should not
 * pay a nesting level for the two that do not.
 */
export type PageTableWrites = TableWrite | readonly TableWrite[];

/**
 * Normalize a page's analytics field to the list the host writes.
 *
 * Empty writes are dropped: a `TableWrite` naming a table but carrying no
 * rows, no deletions, no snapshot and no schema asks the host for nothing,
 * and sending it would cost a round trip to say so. A source that composes
 * its page from optional parts therefore does not have to filter its own
 * list.
 */
export function tableWrites(writes: PageTableWrites | undefined): TableWrite[] {
  if (writes === undefined) return [];
  const list = Array.isArray(writes) ? writes : [writes as TableWrite];
  return (list as readonly TableWrite[]).filter(
    (w) =>
      (w.records?.length ?? 0) > 0 ||
      (w.deletedKeys?.length ?? 0) > 0 ||
      (w.deletedIds?.length ?? 0) > 0 ||
      w.presentKeys !== undefined ||
      w.presentIds !== undefined ||
      w.schema !== undefined,
  );
}

/**
 * Total rows a page writes, for progress accounting.
 *
 * Counts rows written, not tables touched: a page filling five child tables
 * from one upstream record has done more work than the record count suggests,
 * and the count a user sees should say so.
 */
export function tableWriteRowCount(writes: PageTableWrites | undefined): number {
  let total = 0;
  for (const w of tableWrites(writes)) total += w.records?.length ?? 0;
  return total;
}

/** One table's deletions and snapshot, in the one shape the host applies. */
export interface NormalizedTableKeys {
  /** Rows this page deletes, as keys over the table's delete key. */
  deletedKeys: RowKey[] | undefined;
  /** Every row the page vouches for, or `undefined` for no snapshot. */
  presentKeys: RowKey[] | undefined;
}

/**
 * Collapse a write's two spellings of a row key into one.
 *
 * `deletedIds` / `presentIds` name a single column, chosen by the page through
 * `deleteKeyColumn`; `deletedKeys` / `presentKeys` name the table's declared
 * delete key. They answer the same question at the same scope, so the host
 * normalises here and has one path — the alternative is every consumer
 * remembering the second shape, and the one that forgets deletes by a key it
 * does not understand.
 *
 * Both spellings on one write is refused rather than resolved: a precedence
 * would be a rule nobody reading a source could predict, and the disagreement
 * it papers over is about which columns address the table.
 *
 * `keyColumns` is what the table declares. A single-column list is what makes
 * the older spelling expressible at all; for a wider key it cannot say what a
 * key is, so a page still using it is refused with the columns named.
 */
export function normalizeTableKeys(
  write: TableWrite,
  keyColumns: readonly string[],
): NormalizedTableKeys {
  const single = keyColumns.length === 1 ? keyColumns[0]! : undefined;
  const legacy = (
    field: "deletedIds" | "presentIds",
    values: readonly string[] | undefined,
  ): RowKey[] | undefined => {
    if (values === undefined) return undefined;
    const column = write.deleteKeyColumn ?? single;
    const wide = `${write.tableName}: ${field} names one column, but the table is addressed by (${keyColumns.join(", ")}).`;
    if (column === undefined) {
      throw new Error(`${wide} Send ${field === "deletedIds" ? "deletedKeys" : "presentKeys"}.`);
    }
    if (column !== single) {
      throw new Error(`${wide} The delete key belongs to the table, not the page.`);
    }
    return values.map((value) => ({ [column]: value }));
  };
  const both = (a: unknown, b: unknown, names: string): void => {
    if (a !== undefined && b !== undefined) {
      throw new Error(`${write.tableName}: ${names} are two answers to one question — send one.`);
    }
  };
  both(write.deletedKeys, write.deletedIds, "deletedKeys and deletedIds");
  both(write.presentKeys, write.presentIds, "presentKeys and presentIds");
  return {
    deletedKeys: write.deletedKeys ?? legacy("deletedIds", write.deletedIds),
    presentKeys: write.presentKeys ?? legacy("presentIds", write.presentIds),
  };
}
