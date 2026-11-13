// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether one access level may read one document, and why.
 *
 * The answer is computed with the SQL `filter-sql.ts` compiles for every
 * other read: `readable` is the verdict being `R`, and the reason is read
 * from the same conditions. It serves the real read of a single document and
 * the owner's page that lists who can read a document, so the two cannot
 * disagree.
 *
 * What a level grants is passed in as a {@link DocumentAccessGrant}: whether
 * the permission asked about is granted, which accounts are shared, and the
 * filters. The module does not know where levels are stored.
 */

import { storedSpellings } from "@omnesis/core";
import { sourceTypeOf, type FilterNoun, type FilterRef, type SourceFilter } from "@omnesis/types";
import { filterFieldsFor } from "./filter-fields.js";
import { getFilterListAncestors, getFilterListItems } from "./filter-lists.js";
import { filterPersonKey, registerFilterSqlFunctions } from "./filter-people.js";
import {
  FILTER_PEOPLE_FIELD,
  compileSourceFilter,
  filterDetailSql,
  forFewRecords,
  filterMatchSql,
  filterSubjectVersionSql,
  parseFilterDetail,
  parseFilterMatch,
  sourceFilterInclusionSql,
  type CompiledFilter,
  type FilterDetail,
  type FilterSql,
  type FilterUnknownCause,
} from "./filter-sql.js";
import { PERSON_NOUN } from "./filter-wording.js";
import type { Db } from "../data/types.js";

/** What one access level grants for one permission (Answer or Direct). */
export interface DocumentAccessGrant {
  /** Whether the level grants the permission at all. */
  capabilityGranted: boolean;
  /**
   * The source accounts the level shares, or `null` when it shares every
   * configured account. A document of an account outside the set is not
   * readable.
   */
  permittedSourceIds: ReadonlySet<string> | null;
  /** The level's filters, at most one per account in practice. */
  filters: readonly SourceFilter[];
  /**
   * Sources the gateway writes itself. They cannot be named in a filter and
   * may quote what one withholds, so a grant that has any filter reads none
   * of them.
   */
  internalSourceIds?: readonly string[];
}

/** A saved filter entry, as an explanation names it: "label Finance". */
export interface FilterItemLabel {
  noun: string;
  label: string;
}

export type AccessReason =
  | { code: "document-not-found" }
  /** The permission is off on the level. */
  | { code: "permission-not-granted" }
  /** The document's account is not among those the level shares. */
  | { code: "account-not-shared" }
  /** `via` names the entry of a share-only filter that lets the document through. */
  | { code: "readable"; via?: FilterItemLabel }
  /** `item` is `null` when the entry that matched can no longer be named. */
  | { code: "hidden-by-item"; item: FilterItemLabel | null }
  | { code: "not-included" }
  | {
      code: "record-too-old";
      /** Path of the field, or `$people`. */
      field: string;
      noun: FilterNoun;
      recordVersion: number;
      minVersion: number;
    }
  | {
      code: "detail-unknown";
      /** Path of the field, `$people`, or `null` when no single detail is concerned. */
      field: string | null;
      noun: FilterNoun | null;
      person: boolean;
      cause: FilterUnknownCause;
    };

export interface DocumentAccessDecision {
  readable: boolean;
  reason: AccessReason;
}

const hidden = (reason: AccessReason): DocumentAccessDecision => ({ readable: false, reason });

function compiledFilters(db: Db, filters: readonly SourceFilter[]): CompiledFilter[] {
  return filters.map((filter) =>
    compileSourceFilter(filter, filterFieldsFor(db, sourceTypeOf(filter.sourceId))),
  );
}

/**
 * The same decision as a predicate over many documents: true for exactly the
 * documents {@link decideDocumentAccess} calls readable. `documentColumn` and
 * `sourceColumn` name the document id and source id in the caller's
 * statement; `row` is the alias of the documents row when the statement
 * already reads it.
 */
export function documentAccessInclusionSql(
  db: Db,
  grant: DocumentAccessGrant,
  documentColumn: string,
  sourceColumn: string,
  options: {
    row?: string;
    /** The statement checks a few records; see `forFewRecords`. */
    fewRecords?: boolean;
  } = {},
): FilterSql {
  if (!grant.capabilityGranted) return { sql: "0", params: [] };
  registerFilterSqlFunctions(db);
  const compiled = compiledFilters(db, grant.filters);
  const filter = sourceFilterInclusionSql(
    options.fewRecords ? compiled.map(forFewRecords) : compiled,
    documentColumn,
    sourceColumn,
    options,
  );
  const parts: string[] = [];
  const params: Array<string | number> = [];
  if (grant.permittedSourceIds !== null) {
    parts.push(`${sourceColumn} IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify([...grant.permittedSourceIds]));
  }
  if (grant.filters.length > 0 && grant.internalSourceIds?.length) {
    parts.push(`${sourceColumn} NOT IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(grant.internalSourceIds));
  }
  parts.push(`(${filter.sql})`);
  params.push(...filter.params);
  return { sql: `(${parts.join(" AND ")})`, params };
}

/**
 * Decide whether a level may read a document.
 *
 * Checked in order: the permission is granted; the document exists; its
 * account is shared; then each filter of that account. Anything unexpected on
 * the way (a verdict that cannot be read, a filter that cannot be applied)
 * ends as not readable.
 */
export function decideDocumentAccess(
  db: Db,
  grant: DocumentAccessGrant,
  documentId: string,
): DocumentAccessDecision {
  if (!grant.capabilityGranted) return hidden({ code: "permission-not-granted" });
  registerFilterSqlFunctions(db);
  return db.transaction((): DocumentAccessDecision => {
    const row = db
      .prepare<[string], { source_id: string; stream_id: string }>(
        "SELECT source_id, stream_id FROM documents WHERE id = ?",
      )
      .get(documentId);
    if (!row) return hidden({ code: "document-not-found" });
    if (grant.permittedSourceIds !== null && !grant.permittedSourceIds.has(row.source_id)) {
      return hidden({ code: "account-not-shared" });
    }
    if (grant.filters.length > 0 && grant.internalSourceIds?.includes(row.source_id)) {
      return hidden({ code: "account-not-shared" });
    }
    let via: FilterItemLabel | undefined;
    for (const filter of grant.filters) {
      if (filter.sourceId !== row.source_id) continue;
      const compiled = forFewRecords(
        compileSourceFilter(filter, filterFieldsFor(db, sourceTypeOf(filter.sourceId))),
      );
      const decision = decideUnderFilter(db, filter, compiled, documentId, row.stream_id);
      if (!decision.readable) return decision;
      if (decision.reason.code === "readable" && decision.reason.via) via ??= decision.reason.via;
    }
    return { readable: true, reason: { code: "readable", ...(via ? { via } : {}) } };
  })();
}

function decideUnderFilter(
  db: Db,
  filter: SourceFilter,
  compiled: CompiledFilter,
  documentId: string,
  streamId: string,
): DocumentAccessDecision {
  const target = { row: "d" };
  const detail = filterDetailSql(compiled, target);
  const match = filterMatchSql(compiled, target);
  const version = filterSubjectVersionSql(target);
  const found = db
    .prepare<unknown[], { code: unknown; matched: unknown; version: unknown }>(
      `SELECT (${detail.sql}) AS code, (${match.sql}) AS matched, (${version.sql}) AS version
         FROM documents d WHERE d.id = ?`,
    )
    .get(...detail.params, ...match.params, ...version.params, documentId);
  if (!found) return hidden({ code: "document-not-found" });
  const parsed = parseFilterDetail(found.code);
  const concerned = parsed.detail === null ? undefined : compiled.details[parsed.detail];
  const field = concerned
    ? concerned.kind === "person"
      ? FILTER_PEOPLE_FIELD
      : concerned.path
    : null;
  const noun = concerned ? nounOf(concerned) : null;

  switch (parsed.verdict) {
    case "R": {
      const via =
        compiled.whenMatched === "R"
          ? matchedItem(db, filter, compiled, found.matched, streamId)
          : null;
      return { readable: true, reason: { code: "readable", ...(via ? { via } : {}) } };
    }
    case "H":
      return hidden({
        code: "hidden-by-item",
        item: matchedItem(db, filter, compiled, found.matched, streamId),
      });
    case "N":
      return hidden({ code: "not-included" });
    case "O":
      if (!concerned || field === null || noun === null) break;
      return hidden({
        code: "record-too-old",
        field,
        noun,
        recordVersion: typeof found.version === "number" ? found.version : 0,
        minVersion: concerned.spec.minVersion,
      });
    case "U":
      break;
  }
  return hidden({
    code: "detail-unknown",
    field,
    noun,
    person: concerned?.kind === "person",
    cause: parsed.cause ?? "absent",
  });
}

function nounOf(detail: FilterDetail): FilterNoun {
  return detail.kind === "person" ? PERSON_NOUN : detail.spec.noun;
}

/** The saved entry a match names, with the name the account's list gives it. */
function matchedItem(
  db: Db,
  filter: SourceFilter,
  compiled: CompiledFilter,
  matched: unknown,
  streamId: string,
): FilterItemLabel | null {
  const match = parseFilterMatch(matched);
  const detail = match ? compiled.details[match.detail] : undefined;
  if (!match || !detail) return null;
  const refs: readonly FilterRef[] = filter.rules[0]?.match ?? [];

  if (match.kind === "person") {
    if (detail.kind !== "person") return null;
    for (const ref of refs) {
      if (ref.capability !== "person") continue;
      const named = ref.identifiers.some((identifier) =>
        storedSpellings(identifier).some(
          (spelling) => filterPersonKey(identifier.type, spelling) === match.key,
        ),
      );
      if (named) return { noun: PERSON_NOUN.one, label: ref.label };
    }
    return null;
  }
  if (detail.kind !== "field") return null;
  if (match.kind === "device") {
    // The device is the top level of a tree whose ids belong to a device.
    return { noun: detail.spec.levels?.[0]?.one ?? "device", label: match.device };
  }
  const deviceId = detail.spec.scope === "device" ? streamId : "";
  const key = { sourceId: filter.sourceId, field: detail.path, deviceId };
  const saved = new Set(detail.pairs.filter(([device]) => device === deviceId).map(([, id]) => id));
  // The record's own container, or for a tree the nearest saved node above it.
  let id: string | undefined = saved.has(match.value) ? match.value : undefined;
  if (id === undefined && detail.spec.capability === "tree") {
    id = getFilterListAncestors(db, key, match.value).ids.find((ancestor) => saved.has(ancestor));
  }
  if (id === undefined) return null;
  const label = getFilterListItems(db, key, [id]).get(id)?.label;
  return { noun: detail.spec.noun.one, label: label && label.trim() !== "" ? label : id };
}

/** Ids one statement of {@link filterReadableDocumentIds} checks. */
const RECHECK_BATCH = 500;

/**
 * Of `documentIds`, the ones the level may read, decided against the corpus
 * in one statement per {@link RECHECK_BATCH} ids.
 *
 * This is the last step of a filtered search: the index offers candidates
 * from its own copy of the details, which may be a moment behind, and
 * whatever the corpus refuses here is dropped before anything is returned or
 * counted. An id that names no document is not readable.
 */
export function filterReadableDocumentIds(
  db: Db,
  grant: DocumentAccessGrant,
  documentIds: readonly string[],
): Set<string> {
  const readable = new Set<string>();
  if (documentIds.length === 0 || !grant.capabilityGranted) return readable;
  const inclusion = documentAccessInclusionSql(db, grant, "d.id", "d.source_id", {
    row: "d",
    fewRecords: true,
  });
  const statement = db.prepare<unknown[], { id: string }>(
    `SELECT d.id FROM documents d
      WHERE d.id IN (SELECT value FROM json_each(?)) AND ${inclusion.sql}`,
  );
  db.transaction(() => {
    for (let offset = 0; offset < documentIds.length; offset += RECHECK_BATCH) {
      const ids = documentIds.slice(offset, offset + RECHECK_BATCH);
      for (const row of statement.all(JSON.stringify(ids), ...inclusion.params)) {
        readable.add(row.id);
      }
    }
  })();
  return readable;
}
