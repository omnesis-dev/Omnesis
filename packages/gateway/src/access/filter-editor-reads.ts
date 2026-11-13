// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the filter editor reads: the entries a field offers, and what a draft
 * filter would do to an account.
 *
 * Entries come from the list the account's hosts publish for the field: a
 * page of a searchable list, or one level of a tree. People come from the
 * people the gateway already knows, with the identifiers a filter can name
 * them by. Every entry carries the number of records a filter holding only
 * that entry would share, counted with the conditions of the real check.
 *
 * These are pure reads of the corpus. The counts and the preview read every
 * record of the account, so all of this runs on a reader, never on the
 * thread that serves requests. Pages are bounded.
 */

import { createHash } from "node:crypto";
import { canonicalFilterIdentifier, normalizeEmail, storedSpellings } from "@omnesis/core";
import {
  sourceTypeOf,
  type FilterIdentifier,
  type FilterRef,
  type SourceFilter,
} from "@omnesis/types";
import { escapeLike } from "../data/repositories/person-match.js";
import { filterFieldsFor, type SourceFilterFields } from "./filter-fields.js";
import { getFilterListAncestors, getFilterListItems } from "./filter-lists.js";
import { filterPersonKey, registerFilterSqlFunctions } from "./filter-people.js";
import {
  FILTER_PEOPLE_FIELD,
  compileFieldProbe,
  compileSourceFilter,
  filterDeviceCountsSql,
  filterItemCountsSql,
  filterPersonCountsSql,
  filterVerdictSql,
  type CompiledFilter,
  type FieldDetail,
} from "./filter-sql.js";
import type { Db } from "../data/types.js";

/** Entries on one page. */
export const FILTER_OPTIONS_PAGE = 50;
/** Entries or identifiers one filter may hold. */
export const FILTER_MAX_ENTRIES = 256;

export type FilterEditorResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: "source-not-found" | "unsupported-field" | "invalid-cursor" | "invalid-filter";
    };

export interface FilterOptionsRequest {
  sourceId: string;
  /** A declared field's path, or `$people`. */
  field: string;
  /** Text to search names for. Empty browses. */
  q?: string;
  /** Tree only: list what sits directly under this node. Absent lists the top level. */
  parentId?: string;
  /** For a field whose ids belong to a device: the device to list. */
  device?: string;
  cursor?: string;
}

export interface FilterOption {
  /** What a filter saves when this entry is picked. */
  ref: FilterRef;
  /** The full name: for the filter table and for search results. */
  label: string;
  /** The last part of the name: for a row shown under its parent in the picker. */
  shortLabel: string;
  /** Records a share-only filter holding only this entry would share. */
  count: number;
  parentId?: string;
  /** Tree only. */
  hasChildren?: boolean;
  /** Tree only: how many nodes sit above this one in the list. */
  depth?: number;
  /** People only: the person the identifiers were taken from. */
  personId?: string;
}

export interface FilterOptions {
  sourceId: string;
  field: string;
  items: FilterOption[];
  nextCursor?: string;
}

export interface FilterPreview {
  sourceId: string;
  /** Records of the account. */
  total: number;
  /** Records an agent using the filter could read. */
  visible: number;
  /** Every other record, including the two kinds below. */
  hidden: number;
  /** Hidden because they are older than a field the filter uses. */
  tooOld: number;
  /** Hidden because a detail the filter uses is not known on them. */
  unmatched: number;
  /** The filter's entries, in order, with what each matches on its own. */
  items: Array<{
    ref: FilterRef;
    label: string;
    count: number;
    /** The entry names something the account's list does not hold. */
    missing?: boolean;
  }>;
}

// ── Cursors ─────────────────────────────────────────────────────────────────

interface Cursor {
  label: string;
  device: string;
  id: string;
}

/** A cursor is only good for the listing it came from. */
function cursorScope(request: FilterOptionsRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        request.sourceId,
        request.field,
        (request.q ?? "").trim(),
        request.parentId ?? null,
        request.device ?? null,
      ]),
    )
    .digest("hex");
}

function encodeCursor(scope: string, cursor: Cursor): string {
  return Buffer.from(JSON.stringify([1, scope, cursor.label, cursor.device, cursor.id])).toString(
    "base64url",
  );
}

/** `null` for no cursor; throws for one that is malformed or belongs to another listing. */
function decodeCursor(raw: string | undefined, scope: string): Cursor | null {
  if (raw === undefined) return null;
  if (raw.length > 8192) throw new Error("Invalid cursor.");
  const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  if (!Array.isArray(value) || value.length !== 5) throw new Error("Invalid cursor.");
  const [version, cursorScopeValue, label, device, id] = value as unknown[];
  if (
    version !== 1 ||
    cursorScopeValue !== scope ||
    typeof label !== "string" ||
    typeof device !== "string" ||
    typeof id !== "string"
  ) {
    throw new Error("Invalid cursor.");
  }
  return { label, device, id };
}

// ── Shared pieces ───────────────────────────────────────────────────────────

function sourceFields(db: Db, sourceId: string): SourceFilterFields | null {
  const exists = db.prepare<[string], { one: number }>("SELECT 1 AS one FROM sources WHERE id = ?");
  return exists.get(sourceId) ? filterFieldsFor(db, sourceTypeOf(sourceId)) : null;
}

/**
 * The last part of a name whose beginning is the name of the node above it:
 * `~/work/atlas-api` under `~/work` is `atlas-api`. A name that does not
 * continue its parent's with a separator is shown whole.
 */
export function shortFilterLabel(label: string, parentLabel: string | undefined): string {
  if (!parentLabel || !label.startsWith(parentLabel)) return label;
  const rest = label.slice(parentLabel.length);
  const trimmed = rest.replace(/^[/\\:]+/, "");
  return trimmed !== "" && trimmed !== rest ? trimmed : label;
}

function deviceNames(db: Db, ids: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  const read = db.prepare<[string], { name: string }>("SELECT name FROM devices WHERE id = ?");
  for (const id of ids) names.set(id, read.get(id)?.name ?? id);
  return names;
}

/** The people-keys of a person entry, with every spelling a stored record may hold. */
function personKeys(identifiers: readonly FilterIdentifier[]): string[] {
  const keys = new Set<string>();
  for (const identifier of identifiers) {
    for (const spelling of storedSpellings(identifier)) {
      keys.add(filterPersonKey(identifier.type, spelling));
    }
  }
  return [...keys];
}

function rowsToCounts(rows: Array<{ idx: number; n: number }>, length: number): number[] {
  const counts = new Array<number>(length).fill(0);
  for (const row of rows) if (row.idx >= 0 && row.idx < length) counts[row.idx] = row.n;
  return counts;
}

/**
 * How many records each entry would share on its own, in the entries' order.
 * One pass over the account per kind of entry, whatever their number.
 */
export function countFilterEntries(
  db: Db,
  sourceId: string,
  fields: SourceFilterFields,
  refs: readonly FilterRef[],
): number[] {
  registerFilterSqlFunctions(db);
  const counts = new Array<number>(refs.length).fill(0);
  const byField = new Map<string, number[]>();
  refs.forEach((ref, index) => {
    const field = ref.capability === "person" ? FILTER_PEOPLE_FIELD : ref.field;
    byField.set(field, [...(byField.get(field) ?? []), index]);
  });
  for (const [field, indexes] of byField) {
    const probe = compileFieldProbe(sourceId, fields, field);
    if (probe.unusable !== null) continue;
    if (field === FILTER_PEOPLE_FIELD) {
      const entries: Array<[number, string]> = [];
      for (const index of indexes) {
        const ref = refs[index]!;
        if (ref.capability !== "person") continue;
        for (const key of personKeys(ref.identifiers)) entries.push([index, key]);
      }
      if (entries.length === 0) continue;
      const sql = filterPersonCountsSql(probe, entries);
      const rows = db.prepare<unknown[], { idx: number; n: number }>(sql.sql).all(...sql.params);
      rowsToCounts(rows, refs.length).forEach((n, index) => {
        if (n > 0) counts[index] = n;
      });
      continue;
    }
    const detail = probe.details[0] as FieldDetail;
    const deviceScoped = detail.spec.scope === "device";
    const entries: Array<[number, string, string]> = [];
    const wholeDevices: Array<[number, string]> = [];
    for (const index of indexes) {
      const ref = refs[index]!;
      if (ref.capability === "person" || ref.capability !== detail.spec.capability) continue;
      if (deviceScoped) {
        if (!ref.device) continue;
        if (ref.id === "") wholeDevices.push([index, ref.device]);
        else entries.push([index, ref.device, ref.id]);
      } else if (ref.device === undefined && ref.id !== "") {
        entries.push([index, "", ref.id]);
      }
    }
    if (entries.length > 0) {
      const sql = filterItemCountsSql(probe, entries);
      for (const row of db
        .prepare<unknown[], { idx: number; n: number }>(sql.sql)
        .all(...sql.params)) {
        if (row.idx >= 0 && row.idx < counts.length) counts[row.idx] = row.n;
      }
    }
    if (wholeDevices.length > 0) {
      const sql = filterDeviceCountsSql(probe);
      const perDevice = new Map(
        db
          .prepare<unknown[], { device: string; n: number }>(sql.sql)
          .all(...sql.params)
          .map((row) => [row.device, row.n]),
      );
      for (const [index, device] of wholeDevices) counts[index] = perDevice.get(device) ?? 0;
    }
  }
  return counts;
}

// ── Options ─────────────────────────────────────────────────────────────────

interface ItemRow {
  device: string;
  id: string;
  label: string;
  parentId: string | null;
  parentLabel: string | null;
  children: number;
}

/** A page of the entries a field offers, with the count of each. */
export function readFilterOptions(
  db: Db,
  request: FilterOptionsRequest,
): FilterEditorResult<FilterOptions> {
  return db.transaction((): FilterEditorResult<FilterOptions> => {
    const fields = sourceFields(db, request.sourceId);
    if (!fields) return { ok: false, error: "source-not-found" };
    let after: Cursor | null;
    const scope = cursorScope(request);
    try {
      after = decodeCursor(request.cursor, scope);
    } catch {
      return { ok: false, error: "invalid-cursor" };
    }
    const page =
      request.field === FILTER_PEOPLE_FIELD
        ? personOptions(db, request, fields, after)
        : fieldOptions(db, request, fields, after);
    if (!page) return { ok: false, error: "unsupported-field" };
    const counts = countFilterEntries(
      db,
      request.sourceId,
      fields,
      page.items.map((item) => item.ref),
    );
    page.items.forEach((item, index) => {
      item.count = counts[index]!;
    });
    return {
      ok: true,
      value: {
        sourceId: request.sourceId,
        field: request.field,
        items: page.items,
        ...(page.next ? { nextCursor: encodeCursor(scope, page.next) } : {}),
      },
    };
  })();
}

interface OptionsPage {
  items: FilterOption[];
  next?: Cursor;
}

function fieldOptions(
  db: Db,
  request: FilterOptionsRequest,
  fields: SourceFilterFields,
  after: Cursor | null,
): OptionsPage | null {
  const probe = compileFieldProbe(request.sourceId, fields, request.field);
  if (probe.unusable !== null) return null;
  const detail = probe.details[0] as FieldDetail;
  const capability = detail.spec.capability;
  const tree = capability === "tree";
  const deviceScoped = detail.spec.scope === "device";
  const query = (request.q ?? "").trim();

  let device = deviceScoped ? request.device : "";
  if (deviceScoped && device === undefined) {
    const listed = db
      .prepare<[string, string], { device_id: string }>(
        `SELECT device_id FROM source_filter_lists
          WHERE source_id = ? AND field = ? AND generation > 0 ORDER BY device_id`,
      )
      .all(request.sourceId, request.field)
      .map((row) => row.device_id);
    if (listed.length === 1) {
      // One device: its level is not shown, and every entry still names it.
      device = listed[0];
    } else if (query === "" && request.parentId === undefined) {
      // The devices are the top level.
      const names = deviceNames(db, listed);
      const rows = listed
        .map((id) => ({ id, label: names.get(id) ?? id }))
        .sort(
          (a, b) =>
            a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || (a.id < b.id ? -1 : 1),
        )
        .filter(
          (row) =>
            !after || row.label > after.label || (row.label === after.label && row.id > after.id),
        );
      const shown = rows.slice(0, FILTER_OPTIONS_PAGE);
      const last = shown[shown.length - 1];
      return {
        items: shown.map((row) => ({
          ref: { capability, field: request.field, id: "", device: row.id },
          label: row.label,
          shortLabel: row.label,
          count: 0,
          ...(tree ? { hasChildren: true, depth: 0 } : {}),
        })),
        ...(rows.length > FILTER_OPTIONS_PAGE && last
          ? { next: { label: last.label, device: "", id: last.id } }
          : {}),
      };
    }
  }

  const params: Record<string, string | number | null> = {
    sourceId: request.sourceId,
    field: request.field,
    device: device ?? null,
    pattern: `%${escapeLike(query.toLowerCase())}%`,
    parentId: request.parentId ?? null,
    afterLabel: after?.label ?? null,
    afterDevice: after?.device ?? "",
    afterId: after?.id ?? "",
    limit: FILTER_OPTIONS_PAGE + 1,
  };
  // Browsing a tree lists one level; a search, and a plain list, read the whole list.
  const level =
    tree && query === ""
      ? request.parentId === undefined
        ? `AND (i.parent_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM source_filter_items p
              WHERE p.source_id = i.source_id AND p.field = i.field AND p.device_id = i.device_id
                AND p.generation = i.generation AND p.item_id = i.parent_id))`
        : "AND i.parent_id = @parentId"
      : "";
  const rows = db
    .prepare<[typeof params], ItemRow>(
      `SELECT i.device_id AS device, i.item_id AS id, i.label AS label, i.parent_id AS parentId,
              (SELECT p.label FROM source_filter_items p
                WHERE p.source_id = i.source_id AND p.field = i.field AND p.device_id = i.device_id
                  AND p.generation = i.generation AND p.item_id = i.parent_id) AS parentLabel,
              EXISTS (SELECT 1 FROM source_filter_items c INDEXED BY idx_source_filter_items_parent
                       WHERE c.source_id = i.source_id AND c.field = i.field AND c.device_id = i.device_id
                         AND c.generation = i.generation AND c.parent_id = i.item_id) AS children
         FROM source_filter_lists l
         JOIN source_filter_items i
           ON i.source_id = l.source_id AND i.field = l.field AND i.device_id = l.device_id
          AND i.generation = l.generation
        WHERE l.source_id = @sourceId AND l.field = @field AND l.generation > 0
          AND (@device IS NULL OR l.device_id = @device)
          AND lower(i.label) LIKE @pattern ESCAPE '\\'
          ${level}
          AND (@afterLabel IS NULL
               OR i.label COLLATE NOCASE > @afterLabel
               OR (i.label COLLATE NOCASE = @afterLabel
                   AND (i.device_id > @afterDevice
                        OR (i.device_id = @afterDevice AND i.item_id > @afterId))))
        ORDER BY i.label COLLATE NOCASE, i.device_id, i.item_id
        LIMIT @limit`,
    )
    .all(params);
  const shown = rows.slice(0, FILTER_OPTIONS_PAGE);
  const last = shown[shown.length - 1];
  const browsing = tree && query === "";
  return {
    items: shown.map((row) => {
      const key = { sourceId: request.sourceId, field: request.field, deviceId: row.device };
      return {
        ref: {
          capability,
          field: request.field,
          id: row.id,
          ...(deviceScoped ? { device: row.device } : {}),
        },
        label: row.label,
        // Under its parent in the picker a row needs only its own name; a
        // search result stands alone and keeps the whole one.
        shortLabel: browsing
          ? shortFilterLabel(row.label, row.parentLabel ?? undefined)
          : row.label,
        count: 0,
        ...(row.parentId !== null && row.parentLabel !== null ? { parentId: row.parentId } : {}),
        ...(tree
          ? {
              hasChildren: row.children === 1,
              depth: getFilterListAncestors(db, key, row.id).ids.length,
            }
          : {}),
      };
    }),
    ...(rows.length > FILTER_OPTIONS_PAGE && last
      ? { next: { label: last.label, device: last.device, id: last.id } }
      : {}),
  };
}

/**
 * The identifiers a filter can name a known person by: every address and
 * number of the person and of the people merged into them, of the kinds the
 * source declares. `null` when there are more than a filter may hold, so a
 * partial identity is never offered as the whole one.
 */
export function filterPersonIdentifiers(
  db: Db,
  personId: string,
  kinds: readonly string[],
): FilterIdentifier[] | null {
  const rows = db
    .prepare<[string, string], { alias_type: string; alias: string }>(
      `WITH RECURSIVE members(id) AS (
         SELECT id FROM people WHERE id = ?
         UNION SELECT p.id FROM people p JOIN members m ON p.merged_into = m.id
       )
       SELECT DISTINCT a.alias_type, a.alias FROM person_aliases a JOIN members m ON m.id = a.person_id
        WHERE a.alias_type IN (SELECT value FROM json_each(?))
        ORDER BY a.alias_type, a.alias LIMIT ${FILTER_MAX_ENTRIES + 1}`,
    )
    .all(personId, JSON.stringify(kinds.filter((kind) => kind === "email" || kind === "phone")));
  if (rows.length > FILTER_MAX_ENTRIES) return null;
  const found = new Map<string, FilterIdentifier>();
  for (const row of rows) {
    const type = row.alias_type === "email" ? "email" : "phone";
    const identifier = canonicalFilterIdentifier(type, row.alias);
    if (identifier) found.set(filterPersonKey(identifier.type, identifier.value), identifier);
  }
  return [...found.values()].sort(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      (left.value < right.value ? -1 : left.value > right.value ? 1 : 0),
  );
}

function personOptions(
  db: Db,
  request: FilterOptionsRequest,
  fields: SourceFilterFields,
  after: Cursor | null,
): OptionsPage | null {
  if (fields.state !== "declared" || fields.person?.state !== "ready") return null;
  const kinds = fields.person.filter.identifiers;
  const query = (request.q ?? "").trim();
  const params = {
    name: `%${escapeLike(query.toLowerCase())}%`,
    alias: `%${escapeLike(normalizeEmail(query))}%`,
    afterLabel: after?.label ?? null,
    afterId: after?.id ?? "",
    limit: FILTER_OPTIONS_PAGE + 1,
  };
  const rows = db
    .prepare<[typeof params], { id: string; label: string }>(
      `SELECT p.id AS id, p.canonical_name AS label FROM people p
        WHERE p.merged_into IS NULL
          AND (lower(p.canonical_name) LIKE @name ESCAPE '\\'
               OR EXISTS (SELECT 1 FROM person_aliases a
                           WHERE a.person_id = p.id AND lower(a.alias) LIKE @alias ESCAPE '\\'))
          AND (@afterLabel IS NULL
               OR p.canonical_name COLLATE NOCASE > @afterLabel
               OR (p.canonical_name COLLATE NOCASE = @afterLabel AND p.id > @afterId))
        ORDER BY p.canonical_name COLLATE NOCASE, p.id
        LIMIT @limit`,
    )
    .all(params);
  const shown = rows.slice(0, FILTER_OPTIONS_PAGE);
  const last = shown[shown.length - 1];
  const items: FilterOption[] = [];
  for (const row of shown) {
    const identifiers = filterPersonIdentifiers(db, row.id, kinds);
    // Someone this source cannot name, or with too many identifiers to hold, is not offered.
    if (!identifiers || identifiers.length === 0) continue;
    items.push({
      ref: { capability: "person", label: row.label, identifiers },
      label: row.label,
      shortLabel: row.label,
      count: 0,
      personId: row.id,
    });
  }
  return {
    items,
    ...(rows.length > FILTER_OPTIONS_PAGE && last
      ? { next: { label: last.label, device: "", id: last.id } }
      : {}),
  };
}

// ── Preview ─────────────────────────────────────────────────────────────────

function entryCount(filter: SourceFilter): number {
  return (filter.rules?.[0]?.match ?? []).reduce(
    (total, ref) => total + (ref.capability === "person" ? ref.identifiers.length : 1),
    0,
  );
}

/**
 * What a draft filter would do to an account: how many records it leaves
 * readable, how many it hides and why, and what each entry matches. Counted
 * by the check itself, in one pass over the account plus one per kind of
 * entry.
 */
export function readFilterPreview(
  db: Db,
  sourceId: string,
  filter: SourceFilter,
): FilterEditorResult<FilterPreview> {
  return db.transaction((): FilterEditorResult<FilterPreview> => {
    const fields = sourceFields(db, sourceId);
    if (!fields) return { ok: false, error: "source-not-found" };
    let compiled: CompiledFilter;
    try {
      if (filter.sourceId !== sourceId || entryCount(filter) > FILTER_MAX_ENTRIES) {
        return { ok: false, error: "invalid-filter" };
      }
      compiled = compileSourceFilter(filter, fields);
    } catch {
      return { ok: false, error: "invalid-filter" };
    }
    if (compiled.unusable !== null) return { ok: false, error: "invalid-filter" };
    registerFilterSqlFunctions(db);
    const verdict = filterVerdictSql(compiled, { row: "d" });
    const totals = db
      .prepare<unknown[], { total: number; visible: number; tooOld: number; unmatched: number }>(
        `SELECT count(*) AS total,
                coalesce(sum(verdict = 'R'), 0) AS visible,
                coalesce(sum(verdict = 'O'), 0) AS tooOld,
                coalesce(sum(verdict = 'U'), 0) AS unmatched
           FROM (SELECT (${verdict.sql}) AS verdict FROM documents d WHERE d.source_id = ?)`,
      )
      .get(...verdict.params, sourceId)!;
    const refs = filter.rules[0].match;
    const counts = countFilterEntries(db, sourceId, fields, refs);
    const items = refs.map((ref, index): FilterPreview["items"][number] => {
      if (ref.capability === "person") return { ref, label: ref.label, count: counts[index]! };
      if (ref.id === "" && ref.device !== undefined) {
        return {
          ref,
          label: deviceNames(db, [ref.device]).get(ref.device) ?? ref.device,
          count: counts[index]!,
        };
      }
      const key = { sourceId, field: ref.field, deviceId: ref.device ?? "" };
      const entry = getFilterListItems(db, key, [ref.id]).get(ref.id);
      return {
        ref,
        label: entry?.label ?? ref.id,
        count: counts[index]!,
        ...(entry ? {} : { missing: true }),
      };
    });
    return {
      ok: true,
      value: {
        sourceId,
        total: totals.total,
        visible: totals.visible,
        hidden: totals.total - totals.visible,
        tooOld: totals.tooOld,
        unmatched: totals.unmatched,
        items,
      },
    };
  })();
}
