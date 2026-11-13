// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The one compiler of a saved source filter into SQL.
 *
 * For a filter and a record it emits a **verdict**: one letter saying what
 * the filter makes of the record.
 *
 * - `R` readable;
 * - `H` hidden by an item of a "hide" filter;
 * - `N` not included by a "share only" filter;
 * - `O` the record is older than a detail the filter needs: its source version
 *   is below the minimum the field declares;
 * - `U` a detail the filter needs is not known on the record.
 *
 * A record is readable exactly when its verdict is `R`:
 * {@link filterAllowSql} is defined as that comparison, and the explanation
 * shown to the owner ({@link filterDetailSql}, {@link filterMatchSql}) is
 * built from the same conditions, so what is enforced and what is explained
 * cannot differ.
 *
 * **The rule.** Two things are checked on the record itself before the filter
 * is applied: its version is at least the minimum of every field the filter
 * uses, and each of those details is there. A record failing either is hidden
 * whatever the filter says, "share only" or "hide". Nothing is stored per
 * record for this: the details are read from the record's own metadata.
 *
 * - *membership*: the record's ids against the saved ids.
 * - *tree*: the record's immediate container against the saved nodes and
 *   everything inside them. The saved set is expanded downward through the
 *   account's published list once per statement; no row walks upward. A
 *   container the list does not hold is unknown.
 * - *person*: the people of the record in the declared roles, and for a
 *   source whose chats list their members also the members of the record's
 *   chat, against the saved identifiers. A person who cannot be identified is
 *   unknown.
 *
 * A field whose ids belong to a device is compared as (device, id), the device
 * being the record's stream; a saved entry naming only a device covers that
 * whole device. An attachment is decided through the record it was attached
 * to, and is unknown when that record is missing.
 *
 * A filter this build cannot apply (an entry for a field the source does not
 * declare, a capability it does not have, no declaration at all) makes every
 * record of the account `U`.
 *
 * **Two stores, one compiler.** The same functions emit the check for the
 * corpus database and for the copy kept in the search index database; a
 * {@link FilterTableMap} names the tables.
 *
 * **Values are bound.** Ids, paths, identifiers and source ids travel as
 * parameters. The only text spliced into a statement is the table map, which
 * is one of the two constants below, and the caller's column or alias, which
 * is checked against a strict pattern.
 *
 * The statements call the SQL functions `filter-people.ts` registers; run
 * them only on a connection passed to `registerFilterSqlFunctions`.
 *
 * ## If reading the metadata of every record proves too slow
 *
 * The design held in reserve, not built: a table
 * `document_filter_values(document_id, field, device_id, value)` WITHOUT
 * ROWID, with a second index on `(source_id, field, device_id, value,
 * document_id)`, plus one presence row per `(document_id, field)` so that
 * "none" and "not known" stay different, and the record's people-keys stored
 * the same way under a reserved field name. It is filled in the transaction
 * that writes the document, from the declared paths, and rewritten when the
 * declaration changes. A third {@link FilterTableMap} form then turns each
 * per-record JSON probe below into an index seek, and a count for one item
 * into a range scan of that item's rows; the verdict, its order of checks and
 * every caller stay as they are. Two ways to fill it are open: for every
 * account from the start, or for an account when its first filter is saved.
 */

import { createHash } from "node:crypto";
import { storedSpellings } from "@omnesis/core";
import {
  FILTER_MEMBER_SQL_FUNCTION,
  FILTER_PEOPLE_SQL_FUNCTION,
  encodeFilterPeopleSpec,
  filterPeopleSpec,
  filterPersonKey,
} from "./filter-people.js";
import type {
  DocumentFieldFilterSpec,
  FilterRef,
  PersonFilterSpec,
  SourceFilter,
} from "@omnesis/types";
import type { FilterField, SourceFilterFields } from "./filter-fields.js";

export interface FilterSql {
  sql: string;
  params: Array<string | number>;
}

export type FilterVerdict = "R" | "H" | "N" | "O" | "U";

/** Why a detail is not known on a record. */
export type FilterUnknownCause =
  /** The filter cannot be applied by this build. */
  | "filter-unusable"
  /** The record's metadata cannot be read, or the detail is missing or malformed. */
  | "absent"
  /** The record sits in something the account's list does not hold. */
  | "not-listed"
  /** Someone the record involves cannot be identified. */
  | "person-unreadable"
  /** The detail belongs to a device and the record does not say which. */
  | "device-unknown"
  /** The record is an attachment and what it was attached to is missing. */
  | "parent-missing";

/** The names of the tables a compiled check reads. */
export interface FilterTableMap {
  /** One row per record. */
  documents: string;
  /** Column of `documents` holding the document id. */
  id: string;
  /** Column of `documents` holding the JSON the details are read from. */
  metadata: string;
  /**
   * How the record an attachment is decided through is found: `external-id`
   * by the source's own id of the parent, read from the attachment's
   * metadata; `subject-id` by a column holding the parent's document id
   * (`''` on a record that is its own subject).
   */
  subject: "external-id" | "subject-id";
  /**
   * Column holding the digest of the declaration a row was written under, in
   * a store that keeps only the declared details. A row written under another
   * declaration is unknown.
   */
  declaration?: string;
  lists: string;
  items: string;
  /** The index of `items` on (source, field, device, generation, parent). */
  itemsByParent: string;
  members: string;
}

export const CORPUS_FILTER_TABLES: FilterTableMap = {
  documents: "documents",
  id: "id",
  metadata: "metadata",
  subject: "external-id",
  lists: "source_filter_lists",
  items: "source_filter_items",
  itemsByParent: "idx_source_filter_items_parent",
  members: "source_filter_item_members",
};

export const INDEX_FILTER_TABLES: FilterTableMap = {
  documents: "index_filter_documents",
  id: "document_id",
  metadata: "details",
  subject: "subject-id",
  declaration: "declaration",
  lists: "index_filter_lists",
  items: "index_filter_items",
  itemsByParent: "idx_index_filter_items_parent",
  members: "index_filter_item_members",
};

/**
 * Where the record is, in the statement the check is spliced into: the alias
 * of a row of the map's documents table, or a column holding a document id
 * that the check looks up.
 */
export type FilterTarget = { row: string } | { id: string };

/** Aliases the compiled SQL uses; an outer alias equal to one would be captured. */
const RESERVED_ALIASES = new Set(["fx", "fs", "fv", "fi", "fl", "fm", "fk", "fj", "sel"]);

function alias(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value) || RESERVED_ALIASES.has(value.toLowerCase())) {
    throw new Error("Invalid filter SQL alias.");
  }
  return value;
}

function column(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[a-z_][a-z0-9_]*$/i.test(parts[1]!)) {
    throw new Error("Invalid filter SQL column.");
  }
  return `${alias(parts[0]!)}.${parts[1]}`;
}

const DOCUMENT_TYPE_PATH = "$.documentType";
const PARENT_PATH = "$.extra.parentExternalId";
const PEOPLE_PATH = "$.people";

/**
 * Whether stored metadata cannot be read as a JSON object. Written as a CASE
 * so the type is only asked of text that is JSON: a JSON function raises on
 * text that is not, and a raised error would fail the whole read.
 */
function unreadableSql(meta: string): string {
  return `(CASE WHEN json_valid(${meta}) THEN json_type(${meta}) IS NOT 'object' ELSE 1 END)`;
}

/** The path of a declared field as SQLite reads it, or `null` when it cannot be written as one. */
export function filterFieldJsonPath(path: string): string | null {
  const segments = path.split(".");
  if (segments.some((segment) => segment === "" || /["\\[\]]/.test(segment))) return null;
  return `$.${segments.map((segment) => `"${segment}"`).join(".")}`;
}

type ReadyField = Extract<FilterField, { state: "ready" }>;

/** A declared field a filter uses, with what the filter saved for it. */
export interface FieldDetail {
  kind: "field";
  path: string;
  jsonPath: string;
  array: boolean;
  spec: DocumentFieldFilterSpec;
  /** Whether every value must be an item of the account's list. */
  listed: boolean;
  /** Saved (device, id) pairs; the device is `''` for a field shared by every device. */
  pairs: Array<[string, string]>;
  /** Devices saved whole. */
  devices: string[];
}

/** The source's person filter, with the people-keys the filter saved. */
export interface PersonDetail {
  kind: "person";
  spec: PersonFilterSpec;
  specText: string;
  kindsText: string;
  /** Saved people-keys, with every spelling a stored record may hold. */
  keys: string[];
  /** The field whose list carries the members of the record's chat. */
  members: FieldDetail | null;
}

export type FilterDetail = FieldDetail | PersonDetail;

/** A filter read against a source's declaration: what it needs from a record. */
export interface CompiledFilter {
  sourceId: string;
  /** Set when the filter cannot be applied; every record of the account is then `U`. */
  unusable: string | null;
  details: FilterDetail[];
  whenMatched: "R" | "H";
  otherwise: "R" | "N";
  /** Digest of the declaration, compared with the one an index copy row was written under. */
  declaration: string;
  /**
   * How the members of a record's chat are looked up; see
   * {@link forFewRecords}. Absent is `per-statement`.
   */
  memberLookup?: "per-statement" | "per-record";
}

/**
 * The same filter, compiled for a statement that checks a few records: one
 * document, a page of search results.
 *
 * Only the way a chat's members are read differs. By default the chats that
 * hold a saved person, and the chats with a member that cannot be read, are
 * each worked out once for the statement by a pass over the account's member
 * list: right when the statement reads many records. For a few records it is
 * cheaper to read the members of each record's own chat. The verdict is the
 * same either way.
 */
export function forFewRecords(compiled: CompiledFilter): CompiledFilter {
  return { ...compiled, memberLookup: "per-record" };
}

/**
 * The digest of what a source declares as filterable: the paths, their types
 * and scopes, and how people are read. The copy in the search index keeps
 * only these details of a record, so a row written under another declaration
 * says nothing reliable about the current one.
 */
export function filterDeclarationDigest(fields: SourceFilterFields): string {
  const declared =
    fields.state === "declared"
      ? {
          fields: fields.fields
            .filter((field): field is ReadyField => field.state === "ready")
            .map((field) => [field.path, field.type, field.filter.scope])
            .sort(),
          person:
            fields.person?.state === "ready"
              ? encodeFilterPeopleSpec(filterPeopleSpec(fields.person.filter))
              : null,
        }
      : null;
  return createHash("sha256").update(JSON.stringify(declared)).digest("hex").slice(0, 32);
}

function fieldDetail(field: ReadyField): FieldDetail | null {
  const jsonPath = filterFieldJsonPath(field.path);
  if (jsonPath === null) return null;
  return {
    kind: "field",
    path: field.path,
    jsonPath,
    array: field.type === "string-array",
    spec: field.filter,
    listed: field.filter.capability === "tree",
    pairs: [],
    devices: [],
  };
}

/**
 * Read a saved filter against the source's declaration.
 *
 * Nothing here trusts the filter to be well formed: a filter that names
 * something this build cannot apply compiles to "every record unknown", never
 * to a filter with the entry left out.
 */
export function compileSourceFilter(
  filter: SourceFilter,
  fields: SourceFilterFields,
): CompiledFilter {
  const rule = filter.rules?.[0];
  const compiled: CompiledFilter = {
    sourceId: filter.sourceId,
    unusable: null,
    details: [],
    whenMatched: rule?.action === "share" ? "R" : "H",
    otherwise: filter.otherwise === "share" ? "R" : "N",
    declaration: filterDeclarationDigest(fields),
  };
  const unusable = (why: string): CompiledFilter => ({ ...compiled, details: [], unusable: why });

  if (typeof filter.sourceId !== "string" || filter.sourceId === "") return unusable("no source");
  if (!Array.isArray(filter.rules) || filter.rules.length !== 1 || !rule) {
    return unusable("the filter does not hold exactly one rule");
  }
  if (
    (rule.action !== "share" && rule.action !== "hide") ||
    (filter.otherwise !== "share" && filter.otherwise !== "hide") ||
    rule.action === filter.otherwise
  ) {
    return unusable("the filter is neither share-only nor hide");
  }
  if (!Array.isArray(rule.match)) return unusable("the filter's entries are not a list");
  if (rule.match.length === 0) return compiled;
  if (fields.state !== "declared") return unusable("the source declares no filterable field");

  const byPath = new Map<string, FieldDetail>();
  const fieldFor = (path: string): FieldDetail | string => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const declared = fields.fields.find((field) => field.path === path);
    if (!declared) return `the source does not declare "${path}" as filterable`;
    if (declared.state !== "ready") return `"${path}" cannot be applied by this gateway`;
    const detail = fieldDetail(declared);
    if (!detail) return `"${path}" is not a readable path`;
    byPath.set(path, detail);
    return detail;
  };

  let person: PersonDetail | null = null;
  const personKeys = new Set<string>();
  for (const ref of rule.match as FilterRef[]) {
    if (typeof ref !== "object" || ref === null) return unusable("an entry is not an object");
    if (ref.capability === "person") {
      if (fields.person?.state !== "ready") {
        return unusable("the source declares no usable person filter");
      }
      const spec = fields.person.filter;
      if (!Array.isArray(ref.identifiers) || ref.identifiers.length === 0) {
        return unusable("a person entry names no identifier");
      }
      for (const identifier of ref.identifiers) {
        if (
          typeof identifier !== "object" ||
          identifier === null ||
          typeof identifier.value !== "string" ||
          !spec.identifiers.includes(identifier.type)
        ) {
          return unusable("a person entry names an identifier the source does not declare");
        }
        for (const spelling of storedSpellings(identifier)) {
          personKeys.add(filterPersonKey(identifier.type, spelling));
        }
      }
      if (!person) {
        let members: FieldDetail | null = null;
        if (spec.membersOf !== undefined) {
          const found = fieldFor(spec.membersOf);
          if (typeof found === "string") return unusable(found);
          if (found.spec.listsMembers !== true) {
            return unusable(`"${spec.membersOf}" does not list members`);
          }
          members = found;
        }
        const peopleSpec = filterPeopleSpec(spec);
        person = {
          kind: "person",
          spec,
          specText: encodeFilterPeopleSpec(peopleSpec),
          kindsText: JSON.stringify(peopleSpec.kinds),
          keys: [],
          members,
        };
      }
      continue;
    }
    if (ref.capability !== "membership" && ref.capability !== "tree") {
      return unusable("an entry names a capability this gateway does not have");
    }
    if (typeof ref.field !== "string" || typeof ref.id !== "string") {
      return unusable("an entry names no field or id");
    }
    const detail = fieldFor(ref.field);
    if (typeof detail === "string") return unusable(detail);
    if (detail.spec.capability !== ref.capability) {
      return unusable(`"${ref.field}" is not a ${ref.capability} field`);
    }
    if (detail.spec.scope === "device") {
      if (typeof ref.device !== "string" || ref.device === "") {
        return unusable(`an entry for "${ref.field}" names no device`);
      }
      if (ref.id === "") detail.devices.push(ref.device);
      else detail.pairs.push([ref.device, ref.id]);
    } else {
      if (ref.device !== undefined) {
        return unusable(`an entry for "${ref.field}" names a device the field does not have`);
      }
      if (ref.id === "") return unusable(`an entry for "${ref.field}" names no id`);
      detail.pairs.push(["", ref.id]);
    }
  }

  // The field carrying a chat's members is needed by the person check even
  // when no entry selects a chat; fields are listed in declaration order so
  // the compiled text is stable for a given filter.
  const order = new Map(fields.fields.map((field, index) => [field.path, index]));
  compiled.details = [...byPath.values()].sort(
    (left, right) => (order.get(left.path) ?? 0) - (order.get(right.path) ?? 0),
  );
  if (person) {
    person.keys = [...personKeys].sort();
    compiled.details.push(person);
  }
  return compiled;
}

/** The name a caller uses for the people of a record where a field has its path. */
export const FILTER_PEOPLE_FIELD = "$people";

/**
 * A filter that uses one detail and saves nothing for it: a hide filter with
 * no entry, except that the detail is still required of every record. Its
 * verdict is `O` for a record too old for the detail, `U` for one on which
 * the detail is not known, and `R` for every other. It is how the records
 * that cannot be placed for a field are counted with the conditions the real
 * check uses. `field` is a declared path or {@link FILTER_PEOPLE_FIELD}.
 */
export function compileFieldProbe(
  sourceId: string,
  fields: SourceFilterFields,
  field: string,
): CompiledFilter {
  const compiled: CompiledFilter = {
    sourceId,
    unusable: null,
    details: [],
    whenMatched: "H",
    otherwise: "R",
    declaration: filterDeclarationDigest(fields),
  };
  const unusable = (why: string): CompiledFilter => ({ ...compiled, unusable: why });
  if (fields.state !== "declared") return unusable("the source declares no filterable field");
  const declared = (path: string): FieldDetail | null => {
    const found = fields.fields.find((candidate) => candidate.path === path);
    return found?.state === "ready" ? fieldDetail(found) : null;
  };
  if (field !== FILTER_PEOPLE_FIELD) {
    const detail = declared(field);
    if (!detail) return unusable(`"${field}" cannot be applied by this gateway`);
    compiled.details = [detail];
    return compiled;
  }
  if (fields.person?.state !== "ready")
    return unusable("the source declares no usable person filter");
  const spec = fields.person.filter;
  let members: FieldDetail | null = null;
  if (spec.membersOf !== undefined) {
    members = declared(spec.membersOf);
    if (!members || members.spec.listsMembers !== true) {
      return unusable(`"${spec.membersOf}" does not list members`);
    }
    compiled.details.push(members);
  }
  const peopleSpec = filterPeopleSpec(spec);
  compiled.details.push({
    kind: "person",
    spec,
    specText: encodeFilterPeopleSpec(peopleSpec),
    kindsText: JSON.stringify(peopleSpec.kinds),
    keys: [],
    members,
  });
  return compiled;
}

/** One condition of a verdict, in the order they are checked. */
interface Branch {
  when: FilterSql;
  verdict: FilterVerdict;
  /** Position in {@link CompiledFilter.details} of the detail concerned. */
  detail?: number;
  cause?: FilterUnknownCause;
}

class SqlBuilder {
  readonly params: Array<string | number> = [];
  /** Record a bound value and return its placeholder. */
  bind(value: string | number): string {
    this.params.push(value);
    return "?";
  }
  splice(fragment: FilterSql): string {
    this.params.push(...fragment.params);
    return fragment.sql;
  }
}

function fragment(build: (sql: SqlBuilder) => string): FilterSql {
  const builder = new SqlBuilder();
  const sql = build(builder);
  return { sql, params: builder.params };
}

/** The device a record's value of a field belongs to, as SQL over the subject row. */
function rowDevice(detail: FieldDetail, subject: string): string {
  return detail.spec.scope === "device" ? `${subject}.stream_id` : "''";
}

/** The current generation of the list of `detail` for the device `deviceSql`. */
function generationSql(
  sql: SqlBuilder,
  map: FilterTableMap,
  sourceId: string,
  detail: FieldDetail,
  deviceSql: string,
): string {
  return `(SELECT fl.generation FROM ${map.lists} fl WHERE fl.source_id = ${sql.bind(sourceId)} AND fl.field = ${sql.bind(detail.path)} AND fl.device_id = ${deviceSql})`;
}

/**
 * The values the record carries in the field, as a FROM item named `fv` with
 * a `value` column. Its one parameter is bound here, so it must be spliced
 * before anything the caller binds afterwards.
 */
function valuesFrom(
  sql: SqlBuilder,
  map: FilterTableMap,
  detail: FieldDetail,
  subject: string,
): string {
  const meta = `${subject}.${map.metadata}`;
  return detail.array
    ? `json_each(${meta}, ${sql.bind(detail.jsonPath)}) fv`
    : `json_each(json_array(json_extract(${meta}, ${sql.bind(detail.jsonPath)}))) fv`;
}

/**
 * `predicate` holds for at least one value the record carries in the field.
 * `predicate` receives the SQL of one value.
 */
function anyValue(
  sql: SqlBuilder,
  map: FilterTableMap,
  detail: FieldDetail,
  subject: string,
  predicate: (value: string) => string,
): string {
  return `EXISTS (SELECT 1 FROM ${valuesFrom(sql, map, detail, subject)} WHERE ${predicate("fv.value")})`;
}

/**
 * The saved set of a field as rows of (device, id): the saved nodes and, for
 * a tree, everything beneath them in the current list. Uncorrelated, so it is
 * computed once for the statement.
 */
function selectedSetSql(
  sql: SqlBuilder,
  map: FilterTableMap,
  sourceId: string,
  detail: FieldDetail,
): string {
  const seeds = `SELECT json_extract(fj.value, '$[0]'), json_extract(fj.value, '$[1]') FROM json_each(${sql.bind(JSON.stringify(detail.pairs))}) fj`;
  if (detail.spec.capability !== "tree") return seeds;
  return `WITH RECURSIVE sel(device, id) AS (
      ${seeds}
      UNION
      SELECT fi.device_id, fi.item_id
        FROM sel
        -- CROSS JOIN fixes the order: one seek of a node's children per
        -- node reached, never a pass over the list per node.
        CROSS JOIN ${map.items} fi INDEXED BY ${map.itemsByParent}
          ON fi.source_id = ${sql.bind(sourceId)} AND fi.field = ${sql.bind(detail.path)}
         AND fi.device_id = sel.device
         AND fi.generation = ${generationSql(sql, map, sourceId, detail, "sel.device")}
         AND fi.parent_id = sel.id
    ) SELECT device, id FROM sel`;
}

/** A value of the record's field is one the filter saved. */
function fieldMatchSql(
  sql: SqlBuilder,
  map: FilterTableMap,
  sourceId: string,
  detail: FieldDetail,
  subject: string,
): string {
  const parts: string[] = [];
  if (detail.devices.length > 0) {
    parts.push(
      `${subject}.stream_id IN (SELECT fj.value FROM json_each(${sql.bind(JSON.stringify(detail.devices))}) fj)`,
    );
  }
  if (detail.pairs.length > 0) {
    parts.push(
      anyValue(
        sql,
        map,
        detail,
        subject,
        (value) =>
          `(${rowDevice(detail, subject)}, ${value}) IN (${selectedSetSql(sql, map, sourceId, detail)})`,
      ),
    );
  }
  return parts.length > 0 ? `(${parts.join(" OR ")})` : "0";
}

/** The record's people, as the JSON text of their keys, or NULL when unknown. */
function peopleSql(sql: SqlBuilder, map: FilterTableMap, person: PersonDetail, subject: string) {
  return `${FILTER_PEOPLE_SQL_FUNCTION}(json_extract(${subject}.${map.metadata}, '${PEOPLE_PATH}'), ${sql.bind(person.specText)})`;
}

/** The keys of one member row `fm`, or NULL when the member cannot be read. */
function memberKeysSql(sql: SqlBuilder, person: PersonDetail): string {
  return `${FILTER_MEMBER_SQL_FUNCTION}(fm.identifier_type, fm.identifier_value, ${sql.bind(person.kindsText)})`;
}

/**
 * The chats, as rows of (device, id), that have a member satisfying
 * `condition` in the current list. Uncorrelated: one pass over the account's
 * member rows for the statement.
 */
function chatsWhereSql(
  sql: SqlBuilder,
  map: FilterTableMap,
  sourceId: string,
  members: FieldDetail,
  condition: () => string,
): string {
  return `SELECT fm.device_id, fm.item_id FROM ${map.members} fm
      WHERE fm.source_id = ${sql.bind(sourceId)} AND fm.field = ${sql.bind(members.path)}
        AND fm.generation = (SELECT fl.generation FROM ${map.lists} fl WHERE fl.source_id = fm.source_id AND fl.field = fm.field AND fl.device_id = fm.device_id)
        AND ${condition()}`;
}

/**
 * The record's chat has a member satisfying `condition`, which is SQL over a
 * member row `fm`. Emitted in one of two shapes, chosen by
 * {@link CompiledFilter.memberLookup}.
 */
function chatHasMemberSql(
  sql: SqlBuilder,
  compiled: CompiledFilter,
  map: FilterTableMap,
  members: FieldDetail,
  subject: string,
  condition: () => string,
): string {
  const device = rowDevice(members, subject);
  if (compiled.memberLookup !== "per-record") {
    return anyValue(
      sql,
      map,
      members,
      subject,
      (value) =>
        `(${device}, ${value}) IN (${chatsWhereSql(sql, map, compiled.sourceId, members, condition)})`,
    );
  }
  return `EXISTS (SELECT 1 FROM ${map.members} fm
      WHERE fm.source_id = ${sql.bind(compiled.sourceId)} AND fm.field = ${sql.bind(members.path)}
        AND fm.device_id = ${device}
        AND fm.generation = ${generationSql(sql, map, compiled.sourceId, members, device)}
        AND fm.item_id IN (SELECT fv.value FROM ${valuesFrom(sql, map, members, subject)})
        AND ${condition()})`;
}

function savedKeysSql(sql: SqlBuilder, person: PersonDetail): string {
  return `(SELECT fj.value FROM json_each(${sql.bind(JSON.stringify(person.keys))}) fj)`;
}

/** The conditions of a verdict over the subject row, in checking order. */
function branches(compiled: CompiledFilter, map: FilterTableMap, subject: string): Branch[] {
  const out: Branch[] = [];
  const meta = `${subject}.${map.metadata}`;
  const push = (
    verdict: FilterVerdict,
    build: (sql: SqlBuilder) => string,
    detail?: number,
    cause?: FilterUnknownCause,
  ): void => {
    out.push({ when: fragment(build), verdict, detail, cause });
  };

  if (compiled.unusable !== null) {
    push("U", () => "1", undefined, "filter-unusable");
    return out;
  }
  // The row is the one the caller's source column describes.
  push(
    "U",
    (sql) => `${subject}.source_id IS NOT ${sql.bind(compiled.sourceId)}`,
    undefined,
    "absent",
  );
  if (map.declaration) {
    push(
      "U",
      (sql) => `${subject}.${map.declaration} IS NOT ${sql.bind(compiled.declaration)}`,
      undefined,
      "absent",
    );
  }
  // Every later condition reads the JSON; a row whose JSON cannot be read is
  // settled here, so no JSON function ever raises.
  push("U", () => unreadableSql(meta), undefined, "absent");
  // An attachment is decided through a record that is not itself one.
  push(
    "U",
    () =>
      map.subject === "subject-id"
        ? `${subject}.subject_document_id <> ''`
        : `(json_extract(${meta}, '${DOCUMENT_TYPE_PATH}') IS 'attachment' OR json_type(${meta}, '${PARENT_PATH}') IS NOT NULL)`,
    undefined,
    "parent-missing",
  );

  // Too old: a version below the minimum of any detail the filter uses.
  compiled.details.forEach((detail, index) => {
    push("O", (sql) => `${subject}.source_version < ${sql.bind(detail.spec.minVersion)}`, index);
  });

  // Unknown: a detail the filter uses is not there, or cannot be placed.
  compiled.details.forEach((detail, index) => {
    if (detail.kind === "field") {
      if (detail.spec.scope === "device") {
        push("U", () => `${subject}.stream_id = ''`, index, "device-unknown");
      }
      if (detail.array) {
        push(
          "U",
          (sql) =>
            `(json_type(${meta}, ${sql.bind(detail.jsonPath)}) IS NOT 'array' OR EXISTS (SELECT 1 FROM json_each(${meta}, ${sql.bind(detail.jsonPath)}) fv WHERE fv.type <> 'text' OR fv.value = ''))`,
          index,
          "absent",
        );
      } else {
        push(
          "U",
          (sql) =>
            `(json_type(${meta}, ${sql.bind(detail.jsonPath)}) IS NOT 'text' OR json_extract(${meta}, ${sql.bind(detail.jsonPath)}) = '')`,
          index,
          "absent",
        );
      }
      const personUsesList = compiled.details.some(
        (other) => other.kind === "person" && other.members === detail,
      );
      if (detail.listed || personUsesList) {
        push(
          "U",
          (sql) =>
            anyValue(
              sql,
              map,
              detail,
              subject,
              (value) =>
                `NOT EXISTS (SELECT 1 FROM ${map.items} fi WHERE fi.source_id = ${sql.bind(compiled.sourceId)} AND fi.field = ${sql.bind(detail.path)} AND fi.device_id = ${rowDevice(detail, subject)} AND fi.generation = ${generationSql(sql, map, compiled.sourceId, detail, rowDevice(detail, subject))} AND fi.item_id = ${value})`,
            ),
          index,
          "not-listed",
        );
      }
      return;
    }
    push("U", () => `json_type(${meta}, '${PEOPLE_PATH}') IS NOT 'array'`, index, "absent");
    push(
      "U",
      (sql) => `${peopleSql(sql, map, detail, subject)} IS NULL`,
      index,
      "person-unreadable",
    );
    const members = detail.members;
    if (members) {
      // A chat is unknown to a person filter when the list says one of its
      // members cannot be identified. Today the list says so with a member
      // whose value cannot be read; any other way a list item comes to say
      // it (a flag on the item) is one more condition here, selecting the
      // same (device, id) rows from the items table.
      push(
        "U",
        (sql) =>
          chatHasMemberSql(
            sql,
            compiled,
            map,
            members,
            subject,
            () => `${memberKeysSql(sql, detail)} IS NULL`,
          ),
        index,
        "person-unreadable",
      );
    }
  });

  // The filter itself.
  const matches = compiled.details.map((detail) =>
    fragment((sql) => matchSql(sql, compiled, map, detail, subject)),
  );
  if (matches.length > 0) {
    push(compiled.whenMatched, (sql) => matches.map((match) => sql.splice(match)).join(" OR "));
  }
  push(compiled.otherwise, () => "1");
  return out;
}

function matchSql(
  sql: SqlBuilder,
  compiled: CompiledFilter,
  map: FilterTableMap,
  detail: FilterDetail,
  subject: string,
): string {
  if (detail.kind === "field") return fieldMatchSql(sql, map, compiled.sourceId, detail, subject);
  if (detail.keys.length === 0) return "0";
  const parts = [
    `EXISTS (SELECT 1 FROM json_each(${peopleSql(sql, map, detail, subject)}) fv WHERE fv.value IN ${savedKeysSql(sql, detail)})`,
  ];
  const members = detail.members;
  if (members) {
    parts.push(
      chatHasMemberSql(
        sql,
        compiled,
        map,
        members,
        subject,
        () =>
          `EXISTS (SELECT 1 FROM json_each(${memberKeysSql(sql, detail)}) fk WHERE fk.value IN ${savedKeysSql(sql, detail)})`,
      ),
    );
  }
  return `(${parts.join(" OR ")})`;
}

/** What a branch answers in the detailed form: the verdict, the detail and the cause. */
function detailCode(branch: Branch): string {
  if (branch.verdict === "O") return `O:${branch.detail ?? ""}`;
  if (branch.verdict === "U") return `U:${branch.detail ?? ""}:${branch.cause ?? "absent"}`;
  return branch.verdict;
}

/**
 * An expression over the subject row `subject`. The same conditions serve
 * the verdict and its explanation; only what each condition answers differs.
 */
function caseSql(list: Branch[], answer: (branch: Branch) => string): FilterSql {
  return fragment((sql) => {
    const whens = list
      .slice(0, -1)
      .map((branch) => `WHEN ${sql.splice(branch.when)} THEN '${answer(branch)}'`);
    const last = `'${answer(list[list.length - 1]!)}'`;
    return whens.length > 0 ? `CASE ${whens.join(" ")} ELSE ${last} END` : last;
  });
}

/**
 * Evaluate `over(subject alias)` on the record `target` is decided through:
 * the record itself, or for an attachment the record it was attached to.
 * `missing` is what the expression is when there is no such record.
 */
function overSubject(
  map: FilterTableMap,
  target: FilterTarget,
  over: (subject: string) => FilterSql,
  missing: string,
): FilterSql {
  return fragment((sql) => {
    if (map.subject === "subject-id") {
      const id = "row" in target ? `${alias(target.row)}.${map.id}` : column(target.id);
      return `COALESCE((SELECT ${sql.splice(over("fs"))}
        FROM ${map.documents} fx
        JOIN ${map.documents} fs
          ON fs.${map.id} = CASE WHEN fx.subject_document_id = '' THEN fx.${map.id} ELSE fx.subject_document_id END
       WHERE fx.${map.id} = ${id}), ${missing})`;
    }
    const outer = "row" in target ? alias(target.row) : "fx";
    const meta = `${outer}.${map.metadata}`;
    const inner = `CASE
        WHEN ${unreadableSql(meta)} THEN ${missing}
        WHEN json_extract(${meta}, '${DOCUMENT_TYPE_PATH}') IS 'attachment' OR json_type(${meta}, '${PARENT_PATH}') IS NOT NULL
          THEN COALESCE((SELECT ${sql.splice(over("fs"))}
                 FROM ${map.documents} fs
                WHERE fs.provider_id = ${outer}.provider_id AND fs.source_id = ${outer}.source_id
                  AND json_type(${meta}, '${PARENT_PATH}') IS 'text'
                  AND fs.external_id = json_extract(${meta}, '${PARENT_PATH}')
                  AND fs.stream_id = ${outer}.stream_id AND fs.${map.id} <> ${outer}.${map.id}), ${missing})
        ELSE ${sql.splice(over(outer))}
      END`;
    if ("row" in target) return `(${inner})`;
    return `COALESCE((SELECT ${inner} FROM ${map.documents} fx WHERE fx.${map.id} = ${column(target.id)}), ${missing})`;
  });
}

/** The verdict of a filter on a record: one of `R`, `H`, `N`, `O`, `U`. */
export function filterVerdictSql(
  compiled: CompiledFilter,
  target: FilterTarget,
  map: FilterTableMap = CORPUS_FILTER_TABLES,
): FilterSql {
  return overSubject(
    map,
    target,
    (subject) => caseSql(branches(compiled, map, subject), (branch) => branch.verdict),
    "'U'",
  );
}

/**
 * The verdict with its explanation: `R`, `H`, `N`, `O:<detail>` or
 * `U:<detail>:<cause>`, where `<detail>` is a position in
 * {@link CompiledFilter.details} (empty when no single detail is concerned).
 * Its first letter is always the verdict {@link filterVerdictSql} gives.
 */
export function filterDetailSql(
  compiled: CompiledFilter,
  target: FilterTarget,
  map: FilterTableMap = CORPUS_FILTER_TABLES,
): FilterSql {
  return overSubject(
    map,
    target,
    (subject) => caseSql(branches(compiled, map, subject), detailCode),
    "'U::parent-missing'",
  );
}

/**
 * The source version of the record `target` is decided through, or NULL when
 * there is none. For the explanation of a record that is too old.
 */
export function filterSubjectVersionSql(
  target: FilterTarget,
  map: FilterTableMap = CORPUS_FILTER_TABLES,
): FilterSql {
  return overSubject(
    map,
    target,
    (subject) => ({ sql: `${subject}.source_version`, params: [] }),
    "NULL",
  );
}

/** A record is readable exactly when its verdict is `R`. */
export function filterAllowSql(
  compiled: CompiledFilter,
  target: FilterTarget,
  map: FilterTableMap = CORPUS_FILTER_TABLES,
): FilterSql {
  const verdict = filterVerdictSql(compiled, target, map);
  return { sql: `(${verdict.sql}) = 'R'`, params: verdict.params };
}

/** How {@link filterMatchSql} names what matched; see {@link parseFilterMatch}. */
export type FilterMatch =
  | { detail: number; kind: "device"; device: string }
  | { detail: number; kind: "value"; device: string; value: string }
  | { detail: number; kind: "person"; key: string };

/**
 * Which saved entry a record matches, for an explanation: NULL when none
 * does, otherwise text {@link parseFilterMatch} reads. It says nothing about
 * whether the record is readable; ask the verdict for that.
 */
export function filterMatchSql(
  compiled: CompiledFilter,
  target: FilterTarget,
  map: FilterTableMap = CORPUS_FILTER_TABLES,
): FilterSql {
  return overSubject(
    map,
    target,
    (subject) =>
      fragment((sql) => {
        if (compiled.unusable !== null || compiled.details.length === 0) return "NULL";
        const found = compiled.details.map((detail, index) => {
          if (detail.kind === "field") {
            const parts: string[] = [];
            if (detail.devices.length > 0) {
              parts.push(
                `(SELECT json_array(${sql.bind(index)}, 'device', ${subject}.stream_id) WHERE ${subject}.stream_id IN (SELECT fj.value FROM json_each(${sql.bind(JSON.stringify(detail.devices))}) fj))`,
              );
            }
            if (detail.pairs.length > 0) {
              const device = rowDevice(detail, subject);
              const selected = (value: string): string =>
                `(${device}, ${value}) IN (${selectedSetSql(sql, map, compiled.sourceId, detail)})`;
              parts.push(
                `(SELECT json_array(${sql.bind(index)}, 'value', ${device}, fv.value) FROM ${valuesFrom(sql, map, detail, subject)} WHERE ${selected("fv.value")} LIMIT 1)`,
              );
            }
            return parts;
          }
          if (detail.keys.length === 0) return [];
          const parts = [
            `(SELECT json_array(${sql.bind(index)}, 'person', fv.value) FROM json_each(${peopleSql(sql, map, detail, subject)}) fv WHERE fv.value IN ${savedKeysSql(sql, detail)} LIMIT 1)`,
          ];
          const members = detail.members;
          if (members) {
            parts.push(
              `(SELECT json_array(${sql.bind(index)}, 'person', fk.value)
                  FROM ${map.members} fm, json_each(${memberKeysSql(sql, detail)}) fk
                 WHERE fm.source_id = ${sql.bind(compiled.sourceId)} AND fm.field = ${sql.bind(members.path)}
                   AND fm.device_id = ${rowDevice(members, subject)}
                   AND fm.generation = ${generationSql(sql, map, compiled.sourceId, members, rowDevice(members, subject))}
                   AND fm.item_id IN (SELECT fv.value FROM ${valuesFrom(sql, map, members, subject)})
                   AND fk.value IN ${savedKeysSql(sql, detail)} LIMIT 1)`,
            );
          }
          return parts;
        });
        const all = found.flat();
        if (all.length === 0) return "NULL";
        return all.length === 1 ? all[0]! : `COALESCE(${all.join(", ")})`;
      }),
    "NULL",
  );
}

/** Read what {@link filterMatchSql} returned. */
export function parseFilterMatch(text: unknown): FilterMatch | null {
  if (typeof text !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || typeof value[0] !== "number") return null;
  const [detail, kind, first, second] = value as [number, unknown, unknown, unknown];
  if (kind === "device" && typeof first === "string") return { detail, kind, device: first };
  if (kind === "value" && typeof first === "string" && typeof second === "string") {
    return { detail, kind, device: first, value: second };
  }
  if (kind === "person" && typeof first === "string") return { detail, kind, key: first };
  return null;
}

/** Read what {@link filterDetailSql} returned. Anything unexpected reads as unknown. */
export function parseFilterDetail(text: unknown): {
  verdict: FilterVerdict;
  detail: number | null;
  cause: FilterUnknownCause | null;
} {
  const unknown = { verdict: "U" as const, detail: null, cause: "absent" as const };
  if (typeof text !== "string") return unknown;
  if (text === "R" || text === "H" || text === "N") {
    return { verdict: text, detail: null, cause: null };
  }
  const [verdict, position, cause] = text.split(":");
  const detail = position !== undefined && /^[0-9]+$/.test(position) ? Number(position) : null;
  if (verdict === "O") return { verdict, detail, cause: null };
  if (verdict !== "U") return unknown;
  const causes: readonly FilterUnknownCause[] = [
    "filter-unusable",
    "absent",
    "not-listed",
    "person-unreadable",
    "device-unknown",
    "parent-missing",
  ];
  const known = causes.find((candidate) => candidate === cause);
  return { verdict, detail, cause: known ?? "absent" };
}

/**
 * The check for several filtered accounts at once: a record of an account
 * that has a filter must be readable under it, and a record of any other
 * account passes. Choosing which accounts are shared at all stays a separate
 * check made by the caller.
 *
 * `documentColumn` holds the record's document id and `sourceColumn` its
 * source id, in the statement the check is spliced into.
 */
export function sourceFilterInclusionSql(
  filters: readonly CompiledFilter[],
  documentColumn: string,
  sourceColumn: string,
  options: {
    map?: FilterTableMap;
    /**
     * The alias of the record's own row, when the statement already reads it
     * from the map's documents table. The check then reads that row in place
     * and does not look the document up a second time.
     */
    row?: string;
  } = {},
): FilterSql {
  const document = column(documentColumn);
  const source = column(sourceColumn);
  const map = options.map ?? CORPUS_FILTER_TABLES;
  const target: FilterTarget =
    options.row !== undefined ? { row: alias(options.row) } : { id: document };
  if (filters.length === 0) return { sql: "1", params: [] };
  return fragment((sql) =>
    filters
      .map(
        (compiled) =>
          // `<>` rather than `IS NOT`: a row without a source id is not
          // waved through, it falls to the check and is hidden by it.
          `(${source} <> ${sql.bind(compiled.sourceId)} OR ${sql.splice(filterAllowSql(compiled, target, map))})`,
      )
      .join(" AND "),
  );
}

// ── Counts for the filter editor ────────────────────────────────────────────
//
// How many records each offered entry would share, counted in one pass over
// the account rather than one pass per entry. A record counts for an entry
// exactly when a share-only filter holding only that entry reads it: it is
// new enough, the detail is known (the probe's verdict is `R`), and one of
// its values is the entry or inside it. These read the corpus only.

/** The id of the record `outer` is decided through, or NULL when there is none. */
function subjectIdSql(outer: string): string {
  const meta = `${outer}.metadata`;
  return `CASE
      WHEN ${unreadableSql(meta)} THEN ${outer}.id
      WHEN json_extract(${meta}, '${DOCUMENT_TYPE_PATH}') IS 'attachment' OR json_type(${meta}, '${PARENT_PATH}') IS NOT NULL
        THEN (SELECT fx.id FROM documents fx
               WHERE fx.provider_id = ${outer}.provider_id AND fx.source_id = ${outer}.source_id
                 AND json_type(${meta}, '${PARENT_PATH}') IS 'text'
                 AND fx.external_id = json_extract(${meta}, '${PARENT_PATH}')
                 AND fx.stream_id = ${outer}.stream_id AND fx.id <> ${outer}.id)
      ELSE ${outer}.id
    END`;
}

function probeDetail<K extends FilterDetail["kind"]>(
  probe: CompiledFilter,
  kind: K,
): Extract<FilterDetail, { kind: K }> {
  const detail = probe.details[probe.details.length - 1];
  if (probe.unusable !== null || !detail || detail.kind !== kind) {
    throw new Error("The field cannot be counted.");
  }
  return detail as Extract<FilterDetail, { kind: K }>;
}

/**
 * Rows of `(idx, n)`: for each entry `[idx, device, id]` of a field probed
 * with {@link compileFieldProbe}, how many records it would share. An entry
 * no record matches has no row.
 */
export function filterItemCountsSql(
  probe: CompiledFilter,
  entries: ReadonlyArray<readonly [idx: number, device: string, id: string]>,
): FilterSql {
  const detail = probeDetail(probe, "field");
  const map = CORPUS_FILTER_TABLES;
  return fragment((sql) => {
    const seeds = `SELECT json_extract(fj.value, '$[0]'), json_extract(fj.value, '$[1]'), json_extract(fj.value, '$[2]') FROM json_each(${sql.bind(JSON.stringify(entries))}) fj`;
    const selected =
      detail.spec.capability === "tree"
        ? `${seeds}
           UNION
           SELECT sel.idx, fi.device_id, fi.item_id
             FROM sel
             CROSS JOIN ${map.items} fi INDEXED BY ${map.itemsByParent}
               ON fi.source_id = ${sql.bind(probe.sourceId)} AND fi.field = ${sql.bind(detail.path)}
              AND fi.device_id = sel.device
              AND fi.generation = ${generationSql(sql, map, probe.sourceId, detail, "sel.device")}
              AND fi.parent_id = sel.id`
        : seeds;
    const values = valuesFrom(sql, map, detail, "fs");
    return `WITH RECURSIVE sel(idx, device, id) AS (${selected}),
        chosen(device, id, idx) AS MATERIALIZED (SELECT device, id, idx FROM sel)
      SELECT hit.idx AS idx, count(*) AS n FROM (
        SELECT DISTINCT chosen.idx AS idx, d.id AS id
          FROM documents d
          CROSS JOIN documents fs ON fs.id = ${subjectIdSql("d")}
          CROSS JOIN ${values}
          CROSS JOIN chosen ON chosen.device = ${rowDevice(detail, "fs")} AND chosen.id = fv.value
         WHERE d.source_id = ${sql.bind(probe.sourceId)}
           AND (${sql.splice(caseSql(branches(probe, map, "fs"), (branch) => branch.verdict))}) = 'R'
      ) hit GROUP BY hit.idx`;
  });
}

/** Rows of `(device, n)`: how many records each whole device would share for a device-scoped field. */
export function filterDeviceCountsSql(probe: CompiledFilter): FilterSql {
  probeDetail(probe, "field");
  return fragment(
    (sql) =>
      `SELECT fs.stream_id AS device, count(*) AS n FROM ${knownRecordsSql(sql, probe)} GROUP BY fs.stream_id`,
  );
}

/**
 * Rows of `(idx, n)`: for each person, given as `[idx, key]` pairs of their
 * people-keys, how many records a share-only filter naming them would share.
 */
export function filterPersonCountsSql(
  probe: CompiledFilter,
  entries: ReadonlyArray<readonly [idx: number, key: string]>,
): FilterSql {
  const person = probeDetail(probe, "person");
  const map = CORPUS_FILTER_TABLES;
  return fragment((sql) => {
    const keys = `SELECT json_extract(fj.value, '$[0]') AS idx, json_extract(fj.value, '$[1]') AS key FROM json_each(${sql.bind(JSON.stringify(entries))}) fj`;
    const members = person.members;
    const chats = members
      ? `, chats(device, id, idx) AS MATERIALIZED (
           SELECT DISTINCT fm.device_id, fm.item_id, wanted.idx
             FROM ${map.members} fm, json_each(${memberKeysSql(sql, person)}) fk
             JOIN wanted ON wanted.key = fk.value
            WHERE fm.source_id = ${sql.bind(probe.sourceId)} AND fm.field = ${sql.bind(members.path)}
              AND fm.generation = (SELECT fl.generation FROM ${map.lists} fl WHERE fl.source_id = fm.source_id AND fl.field = fm.field AND fl.device_id = fm.device_id))`
      : "";
    const onRecord = `SELECT wanted.idx AS idx, d.id AS id
        FROM ${knownRecordsSql(sql, probe, `CROSS JOIN json_each(${peopleSql(sql, map, person, "fs")}) fv CROSS JOIN wanted ON wanted.key = fv.value`)}`;
    const inChat = members
      ? ` UNION SELECT chats.idx AS idx, d.id AS id
        FROM ${knownRecordsSql(sql, probe, `CROSS JOIN ${valuesFrom(sql, map, members, "fs")} CROSS JOIN chats ON chats.device = ${rowDevice(members, "fs")} AND chats.id = fv.value`)}`
      : "";
    return `WITH wanted(idx, key) AS MATERIALIZED (${keys})${chats}
      SELECT hit.idx AS idx, count(*) AS n FROM (${onRecord}${inChat}) hit GROUP BY hit.idx`;
  });
}

/**
 * The records of the account whose detail is known, as a FROM clause and its
 * WHERE: `d` is the record and `fs` the row it is decided through. `joins`
 * are further joins on `fs`; build them before calling, so their parameters
 * are bound first, as they come first in the text.
 */
function knownRecordsSql(sql: SqlBuilder, probe: CompiledFilter, joins = ""): string {
  return `documents d
      CROSS JOIN documents fs ON fs.id = ${subjectIdSql("d")}
      ${joins}
     WHERE d.source_id = ${sql.bind(probe.sourceId)}
       AND (${sql.splice(caseSql(branches(probe, CORPUS_FILTER_TABLES, "fs"), (branch) => branch.verdict))}) = 'R'`;
}
