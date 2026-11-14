// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Counts and candidate sets of a source filter, read from the rows
 * `filter-values.ts` keeps for every record instead of from each record's
 * metadata.
 *
 * Each statement answers what the verdict of `filter-sql.ts` would answer
 * over every record of the account, from the same conditions in the same
 * order:
 *
 * 1. a record that cannot be decided (`[record]` is `U`) is unknown;
 * 2. one below the highest minimum version of the details used is too old;
 * 3. one on which a detail used is not known (its bit is clear in `known`),
 *    or that carries an id the account's current list does not hold for a
 *    field that must be listed, is unknown;
 * 4. one matching an entry gets the filter's answer for a match;
 * 5. one whose chat has members that are not all known is unknown;
 * 6. every other gets the filter's answer otherwise.
 *
 * Steps 1–3 are counts of `[record]` rows read from the running counts; the
 * ids that are not listed are found from the distinct values of the field,
 * which the counts also hold, and only the records carrying them are read.
 * Steps 4 and 5 read the rows of the entries' values and of the chats
 * concerned, so their cost follows how many records match, not the account's
 * size. Every row carries the version and known details of the record it
 * stands for, so a matched row is checked without reading anything else.
 *
 * Use these only on an account whose rows are ready (`filterValuesReady`),
 * inside the transaction that asked; anything else is decided from the
 * records themselves.
 */

import { registerFilterSqlFunctions } from "./filter-people.js";
import {
  CORPUS_FILTER_TABLES,
  chatsWhereSql,
  filterVerdictSql,
  fragment,
  generationSql,
  memberKeysSql,
  savedKeysSql,
  type CompiledFilter,
  type FieldDetail,
  type FilterSql,
  type PersonDetail,
  type SqlBuilder,
} from "./filter-sql.js";
import {
  FILTER_VALUE_PEOPLE,
  FILTER_VALUE_RECORD,
  RECORD_DERIVED,
  RECORD_SELF,
  RECORD_UNKNOWN,
  filterValueBit,
  filterValueDeclaration,
  filterValuesReady,
  filterValuesReadySql,
  manyValuesField,
  personKeyRows,
  type FilterValueDeclaration,
} from "./filter-values.js";
import type { SourceFilterFields } from "./filter-fields.js";
import type { Db } from "../data/types.js";

const MAP = CORPUS_FILTER_TABLES;
const DECIDED = `('${RECORD_SELF}', '${RECORD_DERIVED}')`;

/** What the conditions of steps 1–3 need from a compiled filter. */
interface Plan {
  compiled: CompiledFilter;
  sourceId: string;
  /** The bits of every detail used. */
  mask: number;
  /** The highest minimum version among them; 0 with none. */
  minVersion: number;
  /** Fields whose ids must be in the account's list. */
  listed: FieldDetail[];
}

function planOf(compiled: CompiledFilter, declaration: FilterValueDeclaration): Plan | null {
  if (compiled.unusable !== null) return null;
  let mask = 0;
  let minVersion = 0;
  for (const detail of compiled.details) {
    const bit = filterValueBit(
      declaration,
      detail.kind === "person" ? FILTER_VALUE_PEOPLE : detail.path,
    );
    if (bit === null) return null;
    mask |= 1 << bit;
    minVersion = Math.max(minVersion, detail.spec.minVersion);
  }
  const listed = compiled.details.filter(
    (detail): detail is FieldDetail =>
      detail.kind === "field" &&
      (detail.listed ||
        compiled.details.some((other) => other.kind === "person" && other.members === detail)),
  );
  return { compiled, sourceId: compiled.sourceId, mask, minVersion, listed };
}

/** The row named `row` stands for a record new enough with every detail used known. */
function qualifies(sql: SqlBuilder, plan: Plan, row: string): string {
  return `${row}.source_version >= ${sql.bind(plan.minVersion)} AND (${row}.known & ${sql.bind(plan.mask)}) = ${sql.bind(plan.mask)}`;
}

function slotSql(sql: SqlBuilder, sourceId: string, field: string, device: string): string {
  return `(SELECT slot FROM document_filter_slots WHERE source_id = ${sql.bind(sourceId)} AND field = ${sql.bind(field)} AND device_id = ${device})`;
}

/**
 * The records carrying an id the current list does not hold, for any field
 * of the plan that must be listed: a SELECT of `document_id`, possibly
 * repeated.
 */
function unlistedRecordsSql(sql: SqlBuilder, plan: Plan): string {
  if (plan.listed.length === 0) return "SELECT NULL AS document_id WHERE 0";
  return plan.listed
    .map(
      (detail) => `SELECT v.document_id AS document_id FROM (
        SELECT DISTINCT c.slot AS slot, c.value AS value
          FROM document_filter_slots s
          JOIN document_filter_value_counts c ON c.slot = s.slot
         WHERE s.source_id = ${sql.bind(plan.sourceId)} AND s.field = ${sql.bind(detail.path)}
           AND c.value <> ''
           AND NOT EXISTS (SELECT 1 FROM ${MAP.items} fi
                WHERE fi.source_id = s.source_id AND fi.field = s.field AND fi.device_id = s.device_id
                  AND fi.generation = (SELECT fl.generation FROM ${MAP.lists} fl
                        WHERE fl.source_id = s.source_id AND fl.field = s.field AND fl.device_id = s.device_id)
                  AND fi.item_id = c.value)
      ) u CROSS JOIN document_filter_values v ON v.slot = u.slot AND v.value = u.value`,
    )
    .join(" UNION ALL ");
}

/**
 * The entries `seeds` (a SELECT of `idx, device, id`, bound already) and, for
 * a tree, every node beneath them in the account's current list, as a SELECT
 * of `idx, device, id`. Each seed's list generation is read once and carried
 * down, so a step is one seek of a node's children.
 */
function expandedSql(sql: SqlBuilder, plan: Plan, detail: FieldDetail, seeds: string): string {
  if (detail.spec.capability !== "tree") return `SELECT idx, device, id FROM (${seeds})`;
  return `WITH RECURSIVE fexp(idx, device, generation, id) AS (
        SELECT e.idx, e.device, fl.generation, e.id FROM (${seeds}) e
          LEFT JOIN ${MAP.lists} fl
            ON fl.source_id = ${sql.bind(plan.sourceId)} AND fl.field = ${sql.bind(detail.path)} AND fl.device_id = e.device
        UNION
        SELECT fexp.idx, fexp.device, fexp.generation, fi.item_id
          FROM fexp
          CROSS JOIN ${MAP.items} fi INDEXED BY ${MAP.itemsByParent}
            ON fi.source_id = ${sql.bind(plan.sourceId)} AND fi.field = ${sql.bind(detail.path)}
           AND fi.device_id = fexp.device AND fi.generation = fexp.generation AND fi.parent_id = fexp.id
      ) SELECT idx, device, id FROM fexp`;
}

/** Rows of a field's values matching the detail's saved entries. */
function fieldMatchRowsSql(sql: SqlBuilder, plan: Plan, detail: FieldDetail): string[] {
  const parts: string[] = [];
  if (detail.devices.length > 0) {
    parts.push(`SELECT v.document_id AS document_id
        FROM json_each(${sql.bind(JSON.stringify(detail.devices))}) fj
        CROSS JOIN document_filter_slots s
          ON s.source_id = ${sql.bind(plan.sourceId)} AND s.field = ${sql.bind(detail.path)} AND s.device_id = fj.value
        CROSS JOIN document_filter_values v ON v.slot = s.slot AND v.value = ''
       WHERE ${qualifies(sql, plan, "v")}`);
  }
  if (detail.pairs.length > 0) {
    const seeds = `SELECT 0 AS idx, json_extract(fj.value, '$[0]') AS device, json_extract(fj.value, '$[1]') AS id
        FROM json_each(${sql.bind(JSON.stringify(detail.pairs))}) fj`;
    parts.push(`SELECT v.document_id AS document_id
        FROM (${expandedSql(sql, plan, detail, seeds)}) fsel
        CROSS JOIN document_filter_slots s
          ON s.source_id = ${sql.bind(plan.sourceId)} AND s.field = ${sql.bind(detail.path)} AND s.device_id = fsel.device
        CROSS JOIN document_filter_values v ON v.slot = s.slot AND v.value = fsel.id
       WHERE ${qualifies(sql, plan, "v")}`);
  }
  return parts;
}

/** Rows of a chat field's values for the chats `chats` names, a SELECT of (device_id, item_id). */
function chatRowsSql(sql: SqlBuilder, plan: Plan, members: FieldDetail, chats: string): string {
  return `SELECT v.document_id AS document_id
      FROM (${chats}) fch
      CROSS JOIN document_filter_slots s
        ON s.source_id = ${sql.bind(plan.sourceId)} AND s.field = ${sql.bind(members.path)} AND s.device_id = fch.device_id
      CROSS JOIN document_filter_values v ON v.slot = s.slot AND v.value = fch.item_id
     WHERE ${qualifies(sql, plan, "v")}`;
}

/**
 * The people rows of saved keys, as `[idx, value, from, before]`: `value` for
 * a key stored as itself, `[from, before)` for a domain.
 */
function personKeyRanges(
  entries: ReadonlyArray<readonly [idx: number, key: string]>,
): Array<[number, string | null, string | null, string | null]> {
  return entries.map(([idx, key]) => {
    const rows = personKeyRows(key);
    return "value" in rows ? [idx, rows.value, null, null] : [idx, null, rows.from, rows.before];
  });
}

/**
 * Rows of `(idx, document_id)` for the people rows of `[idx, value, from,
 * before]` entries bound as JSON; the exact values and the domain ranges are
 * two seeks.
 */
function personRowsSql(sql: SqlBuilder, plan: Plan, ranges: string): string {
  const entries = (
    bound: string,
  ) => `SELECT json_extract(fj.value, '$[0]') AS idx, json_extract(fj.value, '$[1]') AS value,
        json_extract(fj.value, '$[2]') AS low, json_extract(fj.value, '$[3]') AS high
      FROM json_each(${bound}) fj`;
  return `SELECT fk.idx AS idx, v.document_id AS document_id
      FROM (${entries(sql.bind(ranges))}) fk
      CROSS JOIN document_filter_values v
        ON v.slot = ${slotSql(sql, plan.sourceId, FILTER_VALUE_PEOPLE, "''")} AND v.value = fk.value
     WHERE fk.value IS NOT NULL AND ${qualifies(sql, plan, "v")}
    UNION ALL
    SELECT fk.idx AS idx, v.document_id AS document_id
      FROM (${entries(sql.bind(ranges))}) fk
      CROSS JOIN document_filter_values v
        ON v.slot = ${slotSql(sql, plan.sourceId, FILTER_VALUE_PEOPLE, "''")}
       AND v.value >= fk.low AND v.value < fk.high
     WHERE fk.low IS NOT NULL AND ${qualifies(sql, plan, "v")}`;
}

function personMatchRowsSql(sql: SqlBuilder, plan: Plan, person: PersonDetail): string[] {
  if (person.keys.length === 0) return [];
  const ranges = JSON.stringify(personKeyRanges(person.keys.map((key) => [0, key] as const)));
  const parts = [`SELECT document_id FROM (${personRowsSql(sql, plan, ranges)})`];
  const members = person.members;
  if (members) {
    const chats = chatsWhereSql(
      sql,
      MAP,
      plan.sourceId,
      members,
      () =>
        `EXISTS (SELECT 1 FROM json_each(${memberKeysSql(sql, person)}) fk WHERE fk.value IN ${savedKeysSql(sql, person)})`,
    );
    parts.push(chatRowsSql(sql, plan, members, chats));
  }
  return parts;
}

/** Every row matching a saved entry of the filter, as a SELECT of `document_id`, possibly repeated. */
function matchRowsSql(sql: SqlBuilder, plan: Plan): string {
  const parts = plan.compiled.details.flatMap((detail) =>
    detail.kind === "field"
      ? fieldMatchRowsSql(sql, plan, detail)
      : personMatchRowsSql(sql, plan, detail),
  );
  return parts.length > 0 ? parts.join(" UNION ALL ") : "SELECT NULL AS document_id WHERE 0";
}

/** Rows of records whose chat's members are not all known, as a SELECT of `document_id`. */
function rosterRowsSql(sql: SqlBuilder, plan: Plan): string {
  const parts: string[] = [];
  for (const detail of plan.compiled.details) {
    if (detail.kind !== "person" || !detail.members) continue;
    const members = detail.members;
    const incomplete = `SELECT fi.device_id AS device_id, fi.item_id AS item_id FROM ${MAP.items} fi
        WHERE fi.source_id = ${sql.bind(plan.sourceId)} AND fi.field = ${sql.bind(members.path)}
          AND fi.generation = ${generationSql(sql, MAP, plan.sourceId, members, "fi.device_id")}
          AND fi.members_incomplete = 1`;
    const unreadable = chatsWhereSql(
      sql,
      MAP,
      plan.sourceId,
      members,
      () => `${memberKeysSql(sql, detail)} IS NULL`,
    );
    parts.push(chatRowsSql(sql, plan, members, `${incomplete} UNION ${unreadable}`));
  }
  return parts.length > 0 ? parts.join(" UNION ALL ") : "SELECT NULL AS document_id WHERE 0";
}

export interface FilterValueVerdicts {
  total: number;
  R: number;
  H: number;
  N: number;
  O: number;
  U: number;
}

/**
 * How many records of the account get each verdict. `null` when the filter
 * cannot be read against the declaration the rows were cut under; the caller
 * then decides from the records.
 */
export function filterValueVerdictsSql(
  compiled: CompiledFilter,
  declaration: FilterValueDeclaration,
): FilterSql | null {
  const plan = planOf(compiled, declaration);
  if (!plan) return null;
  // Every value is bound where it appears, in the order the text reads.
  return fragment(
    (sql) => `WITH
        bad(document_id) AS MATERIALIZED (SELECT DISTINCT document_id FROM (${unlistedRecordsSql(sql, plan)})),
        matched(document_id) AS MATERIALIZED (
          SELECT document_id FROM (${matchRowsSql(sql, plan)}) EXCEPT SELECT document_id FROM bad),
        roster(document_id) AS MATERIALIZED (
          SELECT document_id FROM (${rosterRowsSql(sql, plan)})
          EXCEPT SELECT document_id FROM bad EXCEPT SELECT document_id FROM matched),
        rec AS MATERIALIZED (
          SELECT c.value AS value, c.source_version AS source_version, c.known AS known, c.records AS records
            FROM document_filter_value_counts c
           WHERE c.slot = ${slotSql(sql, plan.sourceId, FILTER_VALUE_RECORD, "''")})
      SELECT
        (SELECT coalesce(sum(records), 0) FROM rec) AS total,
        (SELECT coalesce(sum(records), 0) FROM rec WHERE value = '${RECORD_UNKNOWN}') AS undecided,
        (SELECT coalesce(sum(records), 0) FROM rec
          WHERE value IN ${DECIDED} AND source_version < ${sql.bind(plan.minVersion)}) AS tooOld,
        (SELECT coalesce(sum(records), 0) FROM rec
          WHERE value IN ${DECIDED} AND source_version >= ${sql.bind(plan.minVersion)}) AS current,
        (SELECT coalesce(sum(records), 0) FROM rec
          WHERE value IN ${DECIDED} AND ${qualifies(sql, plan, "rec")}) AS known,
        (SELECT count(*) FROM bad b
           CROSS JOIN document_filter_values r
             ON r.slot = ${slotSql(sql, plan.sourceId, FILTER_VALUE_RECORD, "''")}
            AND r.value IN ${DECIDED} AND r.document_id = b.document_id
          WHERE ${qualifies(sql, plan, "r")}) AS unlisted,
        (SELECT count(*) FROM matched) AS matched,
        (SELECT count(*) FROM roster) AS roster`,
  );
}

/** Read the row {@link filterValueVerdictsSql} returns. */
export function filterValueVerdicts(
  compiled: CompiledFilter,
  row: {
    total: number;
    undecided: number;
    tooOld: number;
    current: number;
    known: number;
    unlisted: number;
    matched: number;
    roster: number;
  },
): FilterValueVerdicts {
  const decidable = row.known - row.unlisted;
  const rest = decidable - row.matched - row.roster;
  const verdicts: FilterValueVerdicts = { total: row.total, R: 0, H: 0, N: 0, O: row.tooOld, U: 0 };
  verdicts.U = row.undecided + (row.current - row.known) + row.unlisted + row.roster;
  verdicts[compiled.whenMatched] += row.matched;
  verdicts[compiled.otherwise] += rest;
  return verdicts;
}

/**
 * Rows of `(idx, n)` as `filterItemCountsSql` returns them, for each entry
 * `[idx, device, id]` of a field probed with `compileFieldProbe`.
 */
export function filterValueItemCountsSql(
  probe: CompiledFilter,
  declaration: FilterValueDeclaration,
  entries: ReadonlyArray<readonly [idx: number, device: string, id: string]>,
): FilterSql | null {
  const plan = planOf(probe, declaration);
  const detail = probe.details[probe.details.length - 1];
  if (!plan || !detail || detail.kind !== "field") return null;
  return fragment((sql) => {
    const entriesSql = `SELECT json_extract(fj.value, '$[0]') AS idx, json_extract(fj.value, '$[1]') AS device, json_extract(fj.value, '$[2]') AS id
        FROM json_each(${sql.bind(JSON.stringify(entries))}) fj`;
    if (detail.spec.capability !== "tree" && plan.listed.length === 0) {
      // An entry is one value, held at most once per record: its count is
      // the running count of its rows.
      return `SELECT e.idx AS idx, sum(c.records) AS n FROM (${entriesSql}) e
          CROSS JOIN document_filter_slots s
            ON s.source_id = ${sql.bind(plan.sourceId)} AND s.field = ${sql.bind(detail.path)} AND s.device_id = e.device
          CROSS JOIN document_filter_value_counts c ON c.slot = s.slot AND c.value = e.id
         WHERE ${qualifies(sql, plan, "c")}
         GROUP BY e.idx`;
    }
    // An entry of a tree is the node and everything beneath it: a record
    // holding two of those ids is one record. Its count is the sum of the
    // running counts of the ids, less the second and later ids of each record
    // holding several (found from their `[many]` rows), or, when those
    // records are more than the ids' rows, the distinct records of the rows.
    // Either way the records holding an id the list does not have are then
    // taken out.
    const selected = expandedSql(sql, plan, detail, entriesSql);
    const bad = unlistedRecordsSql(sql, plan);
    const slot = (device: string) =>
      `(SELECT slot FROM document_filter_slots WHERE source_id = ${sql.bind(plan.sourceId)} AND field = ${sql.bind(detail.path)} AND device_id = ${device})`;
    return `WITH
        sel(idx, device, id) AS MATERIALIZED (${selected}),
        bad(document_id) AS MATERIALIZED (SELECT DISTINCT document_id FROM (${bad})),
        sums(idx, n) AS MATERIALIZED (
          SELECT sel.idx, coalesce(sum(c.records), 0) FROM sel
            CROSS JOIN document_filter_value_counts c ON c.slot = ${slot("sel.device")} AND c.value = sel.id
           WHERE ${qualifies(sql, plan, "c")}
           GROUP BY sel.idx),
        several(document_id, device) AS MATERIALIZED (
          SELECT m.document_id, s.device_id FROM document_filter_slots s
            CROSS JOIN document_filter_values m ON m.slot = s.slot AND m.value = ''
           WHERE s.source_id = ${sql.bind(plan.sourceId)} AND s.field = ${sql.bind(manyValuesField(detail.path))}
             AND ${qualifies(sql, plan, "m")}),
        extra(idx, n) AS MATERIALIZED (
          SELECT idx, sum(held - 1) FROM (
            SELECT sel.idx AS idx, count(*) AS held FROM several
              CROSS JOIN document_filter_values v
                ON v.document_id = several.document_id AND v.slot = ${slot("several.device")}
              CROSS JOIN sel ON sel.device = several.device AND sel.id = v.value
             GROUP BY sel.idx, several.document_id)
           WHERE held > 1 GROUP BY idx),
        distinct_records(idx, n) AS MATERIALIZED (
          SELECT sel.idx, count(DISTINCT v.document_id) FROM sel
            CROSS JOIN document_filter_values v ON v.slot = ${slot("sel.device")} AND v.value = sel.id
           WHERE ${qualifies(sql, plan, "v")}
           GROUP BY sel.idx),
        unlisted(idx, n) AS MATERIALIZED (
          SELECT sel.idx, count(DISTINCT b.document_id) FROM bad b
            CROSS JOIN document_filter_values v ON v.document_id = b.document_id
            CROSS JOIN document_filter_slots s
              ON s.slot = v.slot AND s.source_id = ${sql.bind(plan.sourceId)} AND s.field = ${sql.bind(detail.path)}
            CROSS JOIN sel ON sel.device = s.device_id AND sel.id = v.value
           WHERE ${qualifies(sql, plan, "v")}
           GROUP BY sel.idx)
      SELECT sums.idx AS idx,
             CASE
               WHEN (SELECT count(*) FROM several) <= (SELECT coalesce(sum(n), 0) FROM sums)
                 THEN sums.n - coalesce((SELECT n FROM extra WHERE extra.idx = sums.idx), 0)
               ELSE coalesce((SELECT n FROM distinct_records d WHERE d.idx = sums.idx), 0)
             END - coalesce((SELECT n FROM unlisted u WHERE u.idx = sums.idx), 0) AS n
        FROM sums`;
  });
}

/** Rows of `(device, n)` as `filterDeviceCountsSql` returns them. */
export function filterValueDeviceCountsSql(
  probe: CompiledFilter,
  declaration: FilterValueDeclaration,
): FilterSql | null {
  const plan = planOf(probe, declaration);
  const detail = probe.details[probe.details.length - 1];
  if (!plan || !detail || detail.kind !== "field") return null;
  return fragment((sql) => {
    const bad = unlistedRecordsSql(sql, plan);
    return `WITH bad(document_id) AS MATERIALIZED (SELECT DISTINCT document_id FROM (${bad}))
      SELECT s.device_id AS device,
             (SELECT coalesce(sum(c.records), 0) FROM document_filter_value_counts c
               WHERE c.slot = s.slot AND c.value = '' AND ${qualifies(sql, plan, "c")})
           - (SELECT count(*) FROM bad b
               CROSS JOIN document_filter_values m ON m.slot = s.slot AND m.value = '' AND m.document_id = b.document_id
              WHERE ${qualifies(sql, plan, "m")}) AS n
        FROM document_filter_slots s
       WHERE s.source_id = ${sql.bind(plan.sourceId)} AND s.field = ${sql.bind(detail.path)}`;
  });
}

/** Rows of `(idx, n)` as `filterPersonCountsSql` returns them, for `[idx, key]` entries. */
export function filterValuePersonCountsSql(
  probe: CompiledFilter,
  declaration: FilterValueDeclaration,
  entries: ReadonlyArray<readonly [idx: number, key: string]>,
): FilterSql | null {
  const plan = planOf(probe, declaration);
  const person = probe.details[probe.details.length - 1];
  if (!plan || !person || person.kind !== "person") return null;
  return fragment((sql) => {
    const wanted = `SELECT json_extract(fj.value, '$[0]') AS idx, json_extract(fj.value, '$[1]') AS key
        FROM json_each(${sql.bind(JSON.stringify(entries))}) fj`;
    const members = person.members;
    const chats = members
      ? `, chats(device_id, item_id, idx) AS MATERIALIZED (
           SELECT DISTINCT fm.device_id, fm.item_id, wanted.idx
             FROM ${MAP.members} fm, json_each(${memberKeysSql(sql, person)}) fk
             JOIN wanted ON wanted.key = fk.value
            WHERE fm.source_id = ${sql.bind(plan.sourceId)} AND fm.field = ${sql.bind(members.path)}
              AND fm.generation = (SELECT fl.generation FROM ${MAP.lists} fl
                    WHERE fl.source_id = fm.source_id AND fl.field = fm.field AND fl.device_id = fm.device_id))`
      : "";
    const bad = unlistedRecordsSql(sql, plan);
    const onRecord = personRowsSql(sql, plan, JSON.stringify(personKeyRanges(entries)));
    const inChat = members
      ? ` UNION SELECT chats.idx AS idx, v.document_id AS document_id
          FROM chats
          CROSS JOIN document_filter_slots s
            ON s.source_id = ${sql.bind(plan.sourceId)} AND s.field = ${sql.bind(members.path)} AND s.device_id = chats.device_id
          CROSS JOIN document_filter_values v ON v.slot = s.slot AND v.value = chats.item_id
         WHERE ${qualifies(sql, plan, "v")}`
      : "";
    return `WITH wanted(idx, key) AS MATERIALIZED (${wanted})${chats},
        bad(document_id) AS MATERIALIZED (SELECT DISTINCT document_id FROM (${bad}))
      SELECT hit.idx AS idx, count(DISTINCT hit.document_id) AS n FROM (${onRecord}${inChat}) hit
       WHERE hit.document_id NOT IN bad
       GROUP BY hit.idx`;
  });
}

/** Above this many matching rows a share-only filter is not narrowed: scanning finds its records soon enough. */
export const FILTER_CANDIDATE_LIMIT = 10_000;

/**
 * A condition that holds for every record a share-only filter could let
 * through, and that reads no record's metadata: the record belongs to another
 * account, or one of its rows matches a saved entry. Placed beside the filter
 * check it settles most records of a filter that rarely matches before the
 * check reads anything, so a statement over the whole account costs the
 * matching records rather than all of them. It holds for every record when
 * the account's rows are not ready, or when more than
 * {@link FILTER_CANDIDATE_LIMIT} rows match; both are decided once per
 * statement, in its own snapshot.
 *
 * `target` is the alias of the statement's `documents` row, or a column
 * holding a document id. `null` for a filter that is not share-only, or that
 * cannot be read against the declaration.
 */
export function filterCandidateSql(
  compiled: CompiledFilter,
  declaration: FilterValueDeclaration,
  target: { row: string } | { id: string },
  sourceColumn: string,
): FilterSql | null {
  if (compiled.whenMatched !== "R" || compiled.otherwise !== "N") return null;
  const plan = planOf(compiled, declaration);
  if (!plan) return null;
  const ready = filterValuesReadySql(plan.sourceId, declaration);
  return fragment((sql) => {
    const source = sql.bind(plan.sourceId);
    const readySql = `${ready.sql}`;
    for (const value of ready.params) sql.bind(value);
    const few = `(SELECT count(*) FROM (${matchRowsSql(sql, plan)} LIMIT ${FILTER_CANDIDATE_LIMIT + 1})) <= ${FILTER_CANDIDATE_LIMIT}`;
    const candidates = matchRowsSql(sql, plan);
    const inside =
      "row" in target
        ? `${target.row}.rowid IN (SELECT fd.rowid FROM documents fd WHERE fd.id IN (${candidates}))`
        : `${target.id} IN (${candidates})`;
    return `(${sourceColumn} <> ${source} OR NOT (${readySql} AND ${few}) OR ${inside})`;
  });
}

/**
 * How many records of the account get each verdict of the filter: from the
 * account's filter rows when they are ready, otherwise from every record's
 * own details. Run it on a reader, inside the transaction that compiled the
 * filter, with `fields` the declaration it was compiled against.
 */
export function countFilterVerdicts(
  db: Db,
  compiled: CompiledFilter,
  fields: SourceFilterFields,
): FilterValueVerdicts {
  registerFilterSqlFunctions(db);
  const values = filterValueDeclaration(fields);
  if (filterValuesReady(db, compiled.sourceId, values)) {
    const sql = filterValueVerdictsSql(compiled, values);
    if (sql) {
      const row = db
        .prepare<unknown[], Parameters<typeof filterValueVerdicts>[1]>(sql.sql)
        .get(...sql.params)!;
      return filterValueVerdicts(compiled, row);
    }
  }
  const verdict = filterVerdictSql(compiled, { row: "d" });
  return db
    .prepare<unknown[], FilterValueVerdicts>(
      `SELECT count(*) AS total,
              coalesce(sum(verdict = 'R'), 0) AS R,
              coalesce(sum(verdict = 'H'), 0) AS H,
              coalesce(sum(verdict = 'N'), 0) AS N,
              coalesce(sum(verdict = 'O'), 0) AS O,
              coalesce(sum(verdict = 'U'), 0) AS U
         FROM (SELECT (${verdict.sql}) AS verdict FROM documents d WHERE d.source_id = ?)`,
    )
    .get(...verdict.params, compiled.sourceId)!;
}
