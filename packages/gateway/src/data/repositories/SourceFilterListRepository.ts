// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Durable store of the lists collectors publish: for one filterable field of
 * one source account, everything that exists — labels and their names, folders
 * and which folder each sits in, chats and their members.
 *
 * A list is identified by the source, the field's path in the source's
 * profile, and a device: the id of the device whose data the list describes
 * for a field whose ids only mean something on that device, and `''` for a
 * list every device of the source shares.
 *
 * **Replacement is atomic.** A new version of a list is written under a
 * generation number of its own, beside the version being read. Every read
 * joins an item to its list row through `generation`, so the rows of a version
 * still being written, and of versions already replaced, are invisible. The
 * last page of a publication moves the list row's `generation` in one update;
 * that single row write is the whole switch. A list row whose `generation` is
 * 0 has never been published.
 *
 * **Writes are bounded.** A page of a publication is applied in sub-batches of
 * a fixed number of rows, each its own transaction, with a chance to give the
 * writer up between them. The page counter moves only after a page's last
 * sub-batch, so an interrupted page is applied again whole.
 *
 * Rows of replaced and abandoned generations, and the rows of a list whose
 * list row was deleted, are collected later by {@link sweepFilterListRows}.
 */

import type { FilterIdentifier, FilterIdentifierType, FilterListOutcome } from "@omnesis/types";
import type { Db } from "../types.js";

export function createSourceFilterListTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_filter_lists (
      source_id TEXT NOT NULL,
      field TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL,
      digest TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      published_at INTEGER NOT NULL,
      staging_generation INTEGER,
      staging_digest TEXT,
      staging_part INTEGER,
      PRIMARY KEY (source_id, field, device_id)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS source_filter_items (
      source_id TEXT NOT NULL,
      field TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      parent_id TEXT,
      label TEXT NOT NULL,
      members_incomplete INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (source_id, field, device_id, generation, item_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_source_filter_items_parent
      ON source_filter_items(source_id, field, device_id, generation, parent_id, item_id);
    CREATE TABLE IF NOT EXISTS source_filter_item_members (
      source_id TEXT NOT NULL,
      field TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      generation INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      PRIMARY KEY (source_id, field, device_id, generation, item_id, identifier_type, identifier_value)
    ) WITHOUT ROWID;
  `);
}

/** Which list: a source account, a filterable field, and the device its ids belong to (`''` when shared). */
export interface FilterListKey {
  sourceId: string;
  field: string;
  deviceId: string;
}

/** The published version of a list. */
export interface FilterListVersion {
  generation: number;
  digest: string;
  itemCount: number;
  /** Epoch milliseconds at which this version became the current one. */
  publishedAt: number;
}

/** One entry of a published list. */
export interface FilterListEntry {
  id: string;
  label: string;
  /** `null` on a root, and on every item of a list that is not a tree. */
  parentId: string | null;
  /**
   * Whether the item has members its member rows do not name, so that who
   * belongs to it is not fully known. Always false where the field lists no
   * members.
   */
  membersIncomplete: boolean;
}

/**
 * One row a page of a publication writes: an item, or one member of an item.
 * Built off the writer, so the writer only inserts.
 */
export type FilterListStagedRow =
  | [
      kind: "item",
      itemId: string,
      parentId: string | null,
      label: string,
      membersIncomplete?: boolean,
    ]
  | [kind: "member", itemId: string, type: FilterIdentifierType, value: string];

export interface StageFilterListPartArgs {
  key: FilterListKey;
  digest: string;
  part: number;
  final: boolean;
  rows: readonly FilterListStagedRow[];
  /** Epoch milliseconds, stamped on the list when this page completes it. */
  now: number;
  /** Where an interrupted call picks up; absent on the first call for a page. */
  resume?: { stagingGeneration: number; offset: number };
}

export type StageFilterListPartResult =
  | { kind: "done"; outcome: FilterListOutcome }
  /** The writer was asked for; call again with `resume` to apply the rest of the page. */
  | { kind: "yield"; resume: { stagingGeneration: number; offset: number } };

/** Rows one sub-batch transaction writes. */
export const FILTER_LIST_STAGE_BATCH_ROWS = 500;

interface ListRow {
  generation: number;
  digest: string;
  item_count: number;
  published_at: number;
  staging_generation: number | null;
  staging_digest: string | null;
  staging_part: number | null;
}

function readListRow(db: Db, key: FilterListKey): ListRow | undefined {
  return db
    .prepare<[string, string, string], ListRow>(
      `SELECT generation, digest, item_count, published_at,
              staging_generation, staging_digest, staging_part
         FROM source_filter_lists
        WHERE source_id = ? AND field = ? AND device_id = ?`,
    )
    .get(key.sourceId, key.field, key.deviceId);
}

/**
 * Apply one page of a publication.
 *
 * - A digest equal to the published one changes nothing, and abandons a
 *   different version that was being written.
 * - Page 0 starts a new version under a generation no row of this list has
 *   used, whatever was being written before.
 * - A later page must be the next one of the version being written; a page
 *   already applied is acknowledged again, anything else is out of sequence.
 * - A final page publishes the version.
 *
 * `shouldYield` is asked between sub-batches; when it answers true the call
 * returns what is left as a `yield`, and a different version started in the
 * meantime makes the resumed call answer `superseded`.
 */
export function stageFilterListPart(
  db: Db,
  args: StageFilterListPartArgs,
  options: { shouldYield?: () => boolean; batchRows?: number } = {},
): StageFilterListPartResult {
  const { key, digest, part, final, rows, now } = args;
  const batchRows = Math.max(1, options.batchRows ?? FILTER_LIST_STAGE_BATCH_ROWS);
  const done = (outcome: FilterListOutcome): StageFilterListPartResult => ({
    kind: "done",
    outcome,
  });

  let stagingGeneration: number;
  let offset: number;
  if (args.resume) {
    ({ stagingGeneration, offset } = args.resume);
  } else {
    const begun = db.transaction((): FilterListOutcome | number => {
      // A page admitted before its source was removed must not bring the list back.
      const removed = db
        .prepare<[string], { one: number }>("SELECT 1 AS one FROM removed_sources WHERE id = ?")
        .get(key.sourceId);
      if (removed) return "superseded";
      const row = readListRow(db, key);
      if (row && row.generation > 0 && row.digest === digest) {
        if (row.staging_generation !== null) clearStaging(db, key);
        return "current";
      }
      if (part > 0) {
        if (!row || row.staging_generation === null || row.staging_digest !== digest) {
          return "out-of-sequence";
        }
        const expected = row.staging_part ?? 0;
        if (part < expected) return "staged";
        if (part > expected) return "out-of-sequence";
        return row.staging_generation;
      }
      // Rows of an abandoned version, or of a list whose row was deleted, may
      // still be waiting for the sweep; the new version must not share a
      // generation with them.
      const highest = db
        .prepare<[string, string, string], { generation: number | null }>(
          `SELECT MAX(generation) AS generation FROM source_filter_items
            WHERE source_id = ? AND field = ? AND device_id = ?`,
        )
        .get(key.sourceId, key.field, key.deviceId);
      const next =
        Math.max(row?.generation ?? 0, row?.staging_generation ?? 0, highest?.generation ?? 0) + 1;
      db.prepare(
        `INSERT INTO source_filter_lists
           (source_id, field, device_id, generation, digest, item_count, published_at,
            staging_generation, staging_digest, staging_part)
         VALUES (?, ?, ?, 0, '', 0, 0, ?, ?, 0)
         ON CONFLICT(source_id, field, device_id) DO UPDATE SET
           staging_generation = excluded.staging_generation,
           staging_digest = excluded.staging_digest,
           staging_part = 0`,
      ).run(key.sourceId, key.field, key.deviceId, next, digest);
      return next;
    })();
    if (typeof begun !== "number") return done(begun);
    stagingGeneration = begun;
    offset = 0;
  }

  const insertItem = db.prepare(
    `INSERT OR REPLACE INTO source_filter_items
       (source_id, field, device_id, generation, item_id, parent_id, label, members_incomplete)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMember = db.prepare(
    `INSERT OR IGNORE INTO source_filter_item_members
       (source_id, field, device_id, generation, item_id, identifier_type, identifier_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const applyBatch = db.transaction((from: number): FilterListOutcome | null => {
    const row = readListRow(db, key);
    if (
      !row ||
      row.staging_generation !== stagingGeneration ||
      row.staging_digest !== digest ||
      row.staging_part !== part
    ) {
      return "superseded";
    }
    const to = Math.min(rows.length, from + batchRows);
    for (let i = from; i < to; i++) {
      const staged = rows[i]!;
      if (staged[0] === "item") {
        insertItem.run(
          key.sourceId,
          key.field,
          key.deviceId,
          stagingGeneration,
          staged[1],
          staged[2],
          staged[3],
          staged[4] === true ? 1 : 0,
        );
      } else {
        insertMember.run(
          key.sourceId,
          key.field,
          key.deviceId,
          stagingGeneration,
          staged[1],
          staged[2],
          staged[3],
        );
      }
    }
    if (to < rows.length) return null;
    if (!final) {
      db.prepare(
        `UPDATE source_filter_lists SET staging_part = ?
          WHERE source_id = ? AND field = ? AND device_id = ?`,
      ).run(part + 1, key.sourceId, key.field, key.deviceId);
      return "staged";
    }
    const counted = db
      .prepare<[string, string, string, number], { n: number }>(
        `SELECT COUNT(*) AS n FROM source_filter_items
          WHERE source_id = ? AND field = ? AND device_id = ? AND generation = ?`,
      )
      .get(key.sourceId, key.field, key.deviceId, stagingGeneration);
    db.prepare(
      `UPDATE source_filter_lists
          SET generation = ?, digest = ?, item_count = ?, published_at = ?,
              staging_generation = NULL, staging_digest = NULL, staging_part = NULL
        WHERE source_id = ? AND field = ? AND device_id = ?`,
    ).run(stagingGeneration, digest, counted?.n ?? 0, now, key.sourceId, key.field, key.deviceId);
    return "published";
  });

  for (;;) {
    const outcome = applyBatch(offset);
    if (outcome !== null) return done(outcome);
    offset += batchRows;
    if (options.shouldYield?.()) return { kind: "yield", resume: { stagingGeneration, offset } };
  }
}

function clearStaging(db: Db, key: FilterListKey): void {
  db.prepare(
    `UPDATE source_filter_lists
        SET staging_generation = NULL, staging_digest = NULL, staging_part = NULL
      WHERE source_id = ? AND field = ? AND device_id = ?`,
  ).run(key.sourceId, key.field, key.deviceId);
}

/**
 * Forget the lists of a source, or only those of one of its devices. Only the
 * list rows go here, which is what makes every item unreadable at once; the
 * item rows are collected by {@link sweepFilterListRows}.
 */
export function deleteFilterLists(db: Db, sourceId: string, deviceId?: string): number {
  if (deviceId === undefined) {
    return db.prepare("DELETE FROM source_filter_lists WHERE source_id = ?").run(sourceId).changes;
  }
  return db
    .prepare("DELETE FROM source_filter_lists WHERE source_id = ? AND device_id = ?")
    .run(sourceId, deviceId).changes;
}

/** Lists one sweep call looks at before handing the writer back. */
const SWEEP_LISTS_PER_CALL = 200;

/**
 * Delete rows no read can reach: generations a newer one replaced, versions
 * abandoned before they were published, and everything under a list whose row
 * is gone.
 *
 * Deletes at most `limit` rows and looks at a bounded number of lists, then
 * returns where to continue. A `null` cursor in the result means the pass
 * reached the end; pass the returned cursor back to carry on.
 */
export function sweepFilterListRows(
  db: Db,
  cursor: FilterListKey | null,
  limit: number,
): { deleted: number; cursor: FilterListKey | null } {
  const firstList = db.prepare<[], KeyRow>(
    `SELECT source_id, field, device_id FROM source_filter_items
      ORDER BY source_id, field, device_id LIMIT 1`,
  );
  const listFrom = db.prepare<[string, string, string], KeyRow>(
    `SELECT source_id, field, device_id FROM source_filter_items
      WHERE (source_id, field, device_id) >= (?, ?, ?)
      ORDER BY source_id, field, device_id LIMIT 1`,
  );
  const listAfter = db.prepare<[string, string, string], KeyRow>(
    `SELECT source_id, field, device_id FROM source_filter_items
      WHERE (source_id, field, device_id) > (?, ?, ?)
      ORDER BY source_id, field, device_id LIMIT 1`,
  );
  // Two ranges, so neither scans the rows being kept: everything below the
  // published generation, and everything above it that is not the version
  // being written, which always holds the highest generation of its list.
  const stale = (table: "source_filter_items" | "source_filter_item_members", range: string) => {
    const columns =
      table === "source_filter_items"
        ? "source_id, field, device_id, generation, item_id"
        : "source_id, field, device_id, generation, item_id, identifier_type, identifier_value";
    return db.prepare<[string, string, string, number, number, number]>(
      `DELETE FROM ${table} WHERE (${columns}) IN (
         SELECT ${columns} FROM ${table}
          WHERE source_id = ? AND field = ? AND device_id = ? AND ${range}
          LIMIT ?)`,
    );
  };
  const BELOW = "generation < ? AND generation < ?";
  const ABOVE = "generation > ? AND generation < ?";
  const statements = [
    stale("source_filter_item_members", BELOW),
    stale("source_filter_item_members", ABOVE),
    stale("source_filter_items", BELOW),
    stale("source_filter_items", ABOVE),
  ];

  let deleted = 0;
  let at = cursor;
  return db.transaction(() => {
    for (let visited = 0; visited < SWEEP_LISTS_PER_CALL; visited++) {
      const found: KeyRow | undefined =
        at === null
          ? visited === 0
            ? firstList.get()
            : undefined
          : visited === 0
            ? listFrom.get(at.sourceId, at.field, at.deviceId)
            : listAfter.get(at.sourceId, at.field, at.deviceId);
      if (!found) return { deleted, cursor: null };
      at = { sourceId: found.source_id, field: found.field, deviceId: found.device_id };
      const row = readListRow(db, at);
      // With no list row nothing is kept: every generation is above -1 and
      // below the unbounded upper end.
      const published = row && row.generation > 0 ? row.generation : -1;
      const staging = row?.staging_generation ?? Number.MAX_SAFE_INTEGER;
      for (const statement of statements) {
        if (deleted >= limit) break;
        deleted += statement.run(
          at.sourceId,
          at.field,
          at.deviceId,
          published,
          staging,
          limit - deleted,
        ).changes;
      }
      if (deleted >= limit) return { deleted, cursor: at };
    }
    // The visit budget ran out on a list that is now clean; continue after it.
    const next = at === null ? undefined : listAfter.get(at.sourceId, at.field, at.deviceId);
    return {
      deleted,
      cursor: next
        ? { sourceId: next.source_id, field: next.field, deviceId: next.device_id }
        : null,
    };
  })();
}

interface KeyRow {
  source_id: string;
  field: string;
  device_id: string;
}

// ── Reads ───────────────────────────────────────────────────────────────────
//
// Each read is one statement, so it sees one version of a list from start to
// end even when a publication completes while it runs.

/** The published version of a list, or `null` when none has been published. */
export function getFilterListVersion(db: Db, key: FilterListKey): FilterListVersion | null {
  const row = readListRow(db, key);
  if (!row || row.generation === 0) return null;
  return {
    generation: row.generation,
    digest: row.digest,
    itemCount: row.item_count,
    publishedAt: row.published_at,
  };
}

/** The digest of every published list of a source, with the field and device each belongs to. */
export function listFilterListDigests(
  db: Db,
  sourceId: string,
): Array<{ field: string; deviceId: string; digest: string }> {
  return db
    .prepare<[string], { field: string; deviceId: string; digest: string }>(
      `SELECT field, device_id AS deviceId, digest FROM source_filter_lists
        WHERE source_id = ? AND generation > 0`,
    )
    .all(sourceId);
}

type FilterListEntryRow = Omit<FilterListEntry, "membersIncomplete"> & {
  membersIncomplete: number;
};

function entryFromRow(row: FilterListEntryRow): FilterListEntry {
  return { ...row, membersIncomplete: row.membersIncomplete === 1 };
}

/**
 * The items directly under `parentId`, or the roots when it is `null`, in id
 * order. `after` continues a listing from the last id of the previous page.
 */
export function listFilterListItemsByParent(
  db: Db,
  key: FilterListKey,
  parentId: string | null,
  page: { after?: string; limit: number },
): FilterListEntry[] {
  return db
    .prepare<[string, string, string, string | null, string], FilterListEntryRow>(
      `SELECT i.item_id AS id, i.label AS label, i.parent_id AS parentId,
              i.members_incomplete AS membersIncomplete
         FROM source_filter_lists l
         JOIN source_filter_items i INDEXED BY idx_source_filter_items_parent
           ON i.source_id = l.source_id AND i.field = l.field AND i.device_id = l.device_id
          AND i.generation = l.generation
        WHERE l.source_id = ? AND l.field = ? AND l.device_id = ?
          AND i.parent_id IS ?
          AND i.item_id > ?
        ORDER BY i.item_id
        LIMIT ${Math.max(1, Math.floor(page.limit))}`,
    )
    .all(key.sourceId, key.field, key.deviceId, parentId, page.after ?? "")
    .map(entryFromRow);
}

/** The entries of a list with the given ids, keyed by id. Ids the list does not hold are absent. */
export function getFilterListItems(
  db: Db,
  key: FilterListKey,
  ids: readonly string[],
): Map<string, FilterListEntry> {
  const found = new Map<string, FilterListEntry>();
  const statement = db.prepare<[string, string, string, string], FilterListEntryRow>(
    `SELECT i.item_id AS id, i.label AS label, i.parent_id AS parentId,
              i.members_incomplete AS membersIncomplete
       FROM source_filter_lists l
       JOIN source_filter_items i
         ON i.source_id = l.source_id AND i.field = l.field AND i.device_id = l.device_id
        AND i.generation = l.generation
      WHERE l.source_id = ? AND l.field = ? AND l.device_id = ?
        AND i.item_id IN (SELECT value FROM json_each(?))`,
  );
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    for (const entry of statement.all(
      key.sourceId,
      key.field,
      key.deviceId,
      JSON.stringify(chunk),
    )) {
      found.set(entry.id, entryFromRow(entry));
    }
  }
  return found;
}

/** Levels a walk up a tree follows before it gives up. */
export const FILTER_LIST_MAX_DEPTH = 256;

/**
 * The chain above an item, nearest first.
 *
 * `complete` is false when the walk did not end at a root: the item is not in
 * the list, a parent it names is not, or the chain is deeper than
 * {@link FILTER_LIST_MAX_DEPTH}. What sits above the item is then not known.
 */
export function getFilterListAncestors(
  db: Db,
  key: FilterListKey,
  itemId: string,
): { ids: string[]; complete: boolean } {
  const rows = db
    .prepare<
      [FilterListKey & { itemId: string }],
      { id: string; parentId: string | null; found: number; depth: number }
    >(
      `WITH RECURSIVE
         list AS (
           SELECT source_id, field, device_id, generation FROM source_filter_lists
            WHERE source_id = @sourceId AND field = @field AND device_id = @deviceId
         ),
         chain(id, parent_id, found, depth) AS (
           SELECT @itemId, (SELECT i.parent_id FROM source_filter_items i, list
                        WHERE i.source_id = list.source_id AND i.field = list.field
                          AND i.device_id = list.device_id AND i.generation = list.generation
                          AND i.item_id = @itemId),
                  EXISTS (SELECT 1 FROM source_filter_items i, list
                           WHERE i.source_id = list.source_id AND i.field = list.field
                             AND i.device_id = list.device_id AND i.generation = list.generation
                             AND i.item_id = @itemId),
                  0
           UNION ALL
           SELECT chain.parent_id,
                  (SELECT i.parent_id FROM source_filter_items i, list
                    WHERE i.source_id = list.source_id AND i.field = list.field
                      AND i.device_id = list.device_id AND i.generation = list.generation
                      AND i.item_id = chain.parent_id),
                  EXISTS (SELECT 1 FROM source_filter_items i, list
                           WHERE i.source_id = list.source_id AND i.field = list.field
                             AND i.device_id = list.device_id AND i.generation = list.generation
                             AND i.item_id = chain.parent_id),
                  chain.depth + 1
             FROM chain
            WHERE chain.found = 1 AND chain.parent_id IS NOT NULL
              AND chain.depth < ${FILTER_LIST_MAX_DEPTH}
         )
       SELECT id, parent_id AS parentId, found, depth FROM chain ORDER BY depth`,
    )
    .all({ ...key, itemId });
  const last = rows[rows.length - 1];
  const complete =
    rows.every((row) => row.found === 1) && last !== undefined && last.parentId === null;
  return {
    ids: rows
      .slice(1)
      .filter((row) => row.found === 1)
      .map((row) => row.id),
    complete,
  };
}

/**
 * Every item beneath `itemId`, at any depth, not including it unless the list
 * loops back to it.
 *
 * `truncated` is true when there are more than `limit`; the ids returned are
 * then only some of them.
 */
export function getFilterListDescendants(
  db: Db,
  key: FilterListKey,
  itemId: string,
  limit: number,
): { ids: string[]; truncated: boolean } {
  const bound = Math.max(1, Math.floor(limit));
  // `UNION` keeps each id once, which is also what ends the walk on a list
  // whose parents loop.
  const rows = db
    .prepare<[FilterListKey & { itemId: string }], { id: string }>(
      `WITH RECURSIVE
         list AS (
           SELECT source_id, field, device_id, generation FROM source_filter_lists
            WHERE source_id = @sourceId AND field = @field AND device_id = @deviceId
         ),
         below(id) AS (
           SELECT i.item_id
             FROM list
             JOIN source_filter_items i INDEXED BY idx_source_filter_items_parent
               ON i.source_id = list.source_id AND i.field = list.field
              AND i.device_id = list.device_id AND i.generation = list.generation
            WHERE i.parent_id = @itemId
           UNION
           SELECT i.item_id
             FROM below
             JOIN list
             JOIN source_filter_items i INDEXED BY idx_source_filter_items_parent
               ON i.source_id = list.source_id AND i.field = list.field
              AND i.device_id = list.device_id AND i.generation = list.generation
            WHERE i.parent_id = below.id
         )
       SELECT id FROM below LIMIT ${bound + 1}`,
    )
    .all({ ...key, itemId });
  return { ids: rows.slice(0, bound).map((row) => row.id), truncated: rows.length > bound };
}

/** The members of one item of a list, in identifier order. Empty when the item has none or is not listed. */
export function getFilterListMembers(
  db: Db,
  key: FilterListKey,
  itemId: string,
): FilterIdentifier[] {
  return db
    .prepare<[string, string, string, string], FilterIdentifier>(
      `SELECT m.identifier_type AS type, m.identifier_value AS value
         FROM source_filter_lists l
         JOIN source_filter_item_members m
           ON m.source_id = l.source_id AND m.field = l.field AND m.device_id = l.device_id
          AND m.generation = l.generation
        WHERE l.source_id = ? AND l.field = ? AND l.device_id = ? AND m.item_id = ?
        ORDER BY m.identifier_type, m.identifier_value`,
    )
    .all(key.sourceId, key.field, key.deviceId, itemId);
}
