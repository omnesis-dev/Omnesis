// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The filter details of every record, one small row per detail, kept beside
 * the corpus so that counting and finding the records a filter matches are
 * index lookups rather than a read of every record's metadata.
 *
 * **What a record's rows say.** A record of an account whose source declares
 * a filterable detail has a row in `document_filter_records`, numbered by the
 * record's rowid in `documents` (`seq`), which says how it is decided:
 * `S` on its own details, `D` as an attachment decided through the record it
 * was attached to, `U` when it cannot be decided (its metadata cannot be
 * read, or it is an attachment whose record is missing, unreadable or itself
 * an attachment). It then has one posting per value it carries:
 *
 * - for `S` and `D`, one per value of each declared field (the field's path),
 *   one per people-key (`[people]`, an address stored under its domain, see
 *   {@link storedPersonValue}), for a field whose ids belong to a device one
 *   with the value `''` saying the field is known there, and for a list field
 *   holding more than one id one `[many]` posting;
 * - for an attachment naming the record it was attached to, one `[parent]`
 *   posting holding that record's external id, by which the attachment is
 *   found when that record changes.
 *
 * A value is stored once, numbered, in `document_filter_terms`, so a posting
 * is a few bytes: term, record number, and the version and bitmask of
 * declared details known of the record it is decided through, so a count
 * asks only the postings it reads.
 *
 * **What a write costs.** Every page a transaction changes is encrypted and
 * written to the WAL, and a page not in cache is read first, so the cost of a
 * sync page is the number of distinct pages it touches. Postings ordered by
 * term put a record's half-dozen postings on as many pages far apart in a
 * large table. They are therefore written at level 0, keyed like the rest
 * but small enough to stay in cache, and moved up a level at a time by
 * {@link mergeFilterPostings}, many to a page, each level about ten times
 * the size of the one below (see "Merging postings a level up"). A record
 * is numbered by its rowid, so its record row lands at the end of the table
 * instead of in an index of random document ids. The record row lists the
 * terms of its postings, which is how a record's postings are found, so no
 * index of postings by record has an entry to move when a posting changes
 * level. The rowid of a record is kept by an upsert and by `VACUUM`; a
 * deleted record's rows go with it, before its rowid can be used again.
 *
 * Records are counted by state, version and known details in
 * `document_filter_record_counts`. An attachment's postings are copies of its
 * record's. Which
 * record an attachment is decided through, when a detail is "known", and how
 * people are read are the rules `filter-sql.ts` applies to the metadata; the
 * equivalence tests hold the two to the same answer. The rows only ever
 * count records or narrow which ones the check reads: whether a record is
 * readable is always the check's answer from the record itself.
 *
 * What depends on the account's published lists (a tree's nodes, a chat's
 * members) is not stored here: it changes without the record changing, and is
 * read from the lists at query time.
 *
 * **How the rows stay current.** Triggers on `documents` put every inserted
 * record, every record whose metadata, version or key changes, and the
 * attachments of a deleted record, in `document_filter_value_queue`, and
 * delete the rows of a deleted record. The write path that stores a page
 * (`upsertDocuments`) writes the rows of what it stored in the same
 * transaction and takes the records off the queue. Anything else that changes
 * a record leaves it queued, and the background drain rewrites it: its rows
 * are cut on a reader and applied by the writer only if the record has not
 * been queued again since.
 *
 * Rows are cut under the source's current declaration. Each account records
 * the declaration its rows were cut under and a pass that queues every record
 * again when it changes, which is also how the rows of the records stored
 * before the rows existed are written after an upgrade. A new account whose
 * first page holds all its records is recorded as done by that page. A reader
 * uses the rows of an account only while that record says they are complete
 * and none of its records is queued ({@link filterValuesReady}); otherwise it
 * decides from the records themselves. The triggers are plain SQL, so a
 * build that does not know the rows still queues every change it makes.
 */

import { createHash } from "node:crypto";
import { filterIdentifierDomain } from "@omnesis/core";
import { sourceTypeOf } from "@omnesis/types";
import { filterFieldsFor, type SourceFilterFields } from "./filter-fields.js";
import { filterPeopleSpec, projectFilterPeople, type FilterPeopleSpec } from "./filter-people.js";
import { filterDeclarationDigest, filterFieldJsonPath } from "./filter-sql.js";
import type { Db } from "../data/types.js";

/** Field name of an attachment's row naming the record it was attached to. */
export const FILTER_VALUE_PARENT = "[parent]";
/** Field name of the rows holding a record's people-keys. */
export const FILTER_VALUE_PEOPLE = "[people]";

/**
 * Field name of the row, value `''`, a record carries when it holds more than
 * one id of the field: what a count over several ids must not count twice.
 * A declared path never contains `[`, so the name is never a path.
 */
export function manyValuesField(path: string): string {
  return `[many]${path}`;
}

/** How a record is decided: the `state` of its row in `document_filter_records`. */
export const RECORD_SELF = "S";
export const RECORD_DERIVED = "D";
export const RECORD_UNKNOWN = "U";

/**
 * How many levels postings are kept at. A posting is written at level 0;
 * level `k` holds about ten times what level `k - 1` may, and the last level
 * holds the rest.
 */
export const POSTING_LEVELS = 6;

const LEVEL_LIST = Array.from({ length: POSTING_LEVELS }, (_unused, level) => level).join(", ");

/**
 * The condition that `alias` is a posting of `term`: one seek of the
 * postings' key per level that holds any, read in the statement's own
 * snapshot (level 0, and every level a merge has given postings).
 */
export function postingOfTerm(alias: string, term: string): string {
  return `${alias}.level IN (SELECT 0 UNION ALL SELECT level FROM document_filter_levels WHERE postings > 0) AND ${alias}.term = ${term}`;
}

/** {@link postingOfTerm} at every level, for a write that must find a posting wherever it is. */
function postingAtAnyLevel(alias: string, term: string): string {
  return `${alias}.level IN (${LEVEL_LIST}) AND ${alias}.term = ${term}`;
}

/** The tables {@link createDocumentFilterValueTables} creates, children first. */
export const FILTER_VALUE_TABLES = [
  "document_filter_postings",
  "document_filter_levels",
  "document_filter_record_counts",
  "document_filter_records",
  "document_filter_terms",
  "document_filter_slots",
  "document_filter_value_sources",
  "document_filter_value_queue",
] as const;

export function createDocumentFilterValueTables(db: Db): void {
  // Every trigger below names `documents.source_version`; on an upgrade that
  // predates it, the migration that adds the column creates them later.
  const hasVersion = (db.pragma("table_info(documents)") as { name: string }[]).some(
    (row) => row.name === "source_version",
  );
  if (!hasVersion) return;
  const queue = (id: string, source: string) =>
    `INSERT INTO document_filter_value_queue (document_id, source_id, revision)
       VALUES (${id}, ${source}, 1)
       ON CONFLICT(document_id) DO UPDATE SET source_id = excluded.source_id, revision = revision + 1;`;
  // The attachments waiting on a record of this key.
  const queueAttachments = (row: "OLD" | "NEW") =>
    `INSERT INTO document_filter_value_queue (document_id, source_id, revision)
       SELECT d.id, ${row}.source_id, 1
         FROM document_filter_slots s
         JOIN document_filter_terms t ON t.slot = s.slot AND t.value = ${row}.external_id
         JOIN document_filter_postings p ON ${postingOfTerm("p", "t.term")}
         JOIN documents d ON d.rowid = p.seq
        WHERE s.source_id = ${row}.source_id AND s.field = '${FILTER_VALUE_PARENT}'
          AND s.device_id = ${row}.stream_id AND d.id <> ${row}.id
       ON CONFLICT(document_id) DO UPDATE SET revision = revision + 1;`;
  const forget = (row: "OLD" | "NEW") => `
    DELETE FROM document_filter_postings
     WHERE level IN (${LEVEL_LIST}) AND term IN (
             SELECT j.value FROM document_filter_records r, json_each(r.terms) j
              WHERE r.seq = ${row}.rowid)
       AND seq = ${row}.rowid;
    DELETE FROM document_filter_records WHERE seq = ${row}.rowid;`;
  const countKey = (row: "OLD" | "NEW") =>
    `source_id = ${row}.source_id AND state = ${row}.state AND source_version = ${row}.source_version AND known = ${row}.known`;
  const countAdd = `
    INSERT INTO document_filter_record_counts (source_id, state, source_version, known, records)
    VALUES (NEW.source_id, NEW.state, NEW.source_version, NEW.known, 1)
    ON CONFLICT(source_id, state, source_version, known) DO UPDATE SET records = records + 1;`;
  const countRemove = `
    UPDATE document_filter_record_counts SET records = records - 1 WHERE ${countKey("OLD")};
    DELETE FROM document_filter_record_counts WHERE ${countKey("OLD")} AND records <= 0;`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_filter_slots (
      slot INTEGER PRIMARY KEY,
      source_id TEXT NOT NULL,
      -- A declared path, '${FILTER_VALUE_PARENT}', '${FILTER_VALUE_PEOPLE}' or a '[many]' name.
      field TEXT NOT NULL,
      -- The record's stream for a field whose ids belong to a device, and for
      -- '${FILTER_VALUE_PARENT}'; '' otherwise.
      device_id TEXT NOT NULL DEFAULT '',
      UNIQUE (source_id, field, device_id)
    );
    -- Every value a slot has held, numbered, so a posting is two small integers.
    CREATE TABLE IF NOT EXISTS document_filter_terms (
      term INTEGER PRIMARY KEY,
      slot INTEGER NOT NULL,
      value TEXT NOT NULL,
      UNIQUE (slot, value)
    );
    -- One row per record with filter rows, numbered by the record's rowid in
    -- documents, with how it is decided (the state is '${RECORD_SELF}', '${RECORD_DERIVED}'
    -- or '${RECORD_UNKNOWN}'), the version and known details of the record it is
    -- decided through, and the terms of its postings as a JSON array.
    CREATE TABLE IF NOT EXISTS document_filter_records (
      seq INTEGER PRIMARY KEY,
      source_id TEXT NOT NULL,
      state TEXT NOT NULL,
      source_version INTEGER NOT NULL,
      known INTEGER NOT NULL,
      terms TEXT NOT NULL
    );
    -- How many records of an account are in each state, version and set of
    -- known details: kept by the triggers below.
    CREATE TABLE IF NOT EXISTS document_filter_record_counts (
      source_id TEXT NOT NULL,
      state TEXT NOT NULL,
      source_version INTEGER NOT NULL,
      known INTEGER NOT NULL,
      records INTEGER NOT NULL,
      PRIMARY KEY (source_id, state, source_version, known)
    ) WITHOUT ROWID;
    -- One posting per value a record carries, with the record's version and
    -- known details copied so a count reads nothing else. Keyed by level,
    -- term, record number: a posting is written at level 0, a run small
    -- enough to stay in cache, and moved a level up in term order by
    -- mergeFilterPostings once its level is full. A reader asks every level.
    CREATE TABLE IF NOT EXISTS document_filter_postings (
      level INTEGER NOT NULL,
      term INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      source_version INTEGER NOT NULL,
      known INTEGER NOT NULL,
      PRIMARY KEY (level, term, seq)
    ) WITHOUT ROWID;
    -- How many postings each level above 0 was given by merges, less what
    -- merges took from it. Postings deleted with their record are not taken
    -- off, so a level holds at most this many.
    CREATE TABLE IF NOT EXISTS document_filter_levels (
      level INTEGER PRIMARY KEY,
      postings INTEGER NOT NULL
    );
    -- The declaration an account's rows were cut under, and the pass that
    -- queues its records again: the rowid it has reached, NULL once done.
    CREATE TABLE IF NOT EXISTS document_filter_value_sources (
      source_id TEXT PRIMARY KEY,
      declaration TEXT NOT NULL,
      pending_after INTEGER
    ) WITHOUT ROWID;
    -- Records whose rows must be cut again. The revision rises each time a
    -- record is queued, so rows cut from an older read are not applied.
    CREATE TABLE IF NOT EXISTS document_filter_value_queue (
      document_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      revision INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_document_filter_value_queue_source
      ON document_filter_value_queue(source_id);

    CREATE TRIGGER IF NOT EXISTS document_filter_record_counts_insert
      AFTER INSERT ON document_filter_records BEGIN${countAdd}
    END;
    CREATE TRIGGER IF NOT EXISTS document_filter_record_counts_delete
      AFTER DELETE ON document_filter_records BEGIN${countRemove}
    END;
    CREATE TRIGGER IF NOT EXISTS document_filter_record_counts_update
      AFTER UPDATE OF source_id, state, source_version, known ON document_filter_records
      WHEN OLD.source_id IS NOT NEW.source_id OR OLD.state IS NOT NEW.state
        OR OLD.source_version IS NOT NEW.source_version OR OLD.known IS NOT NEW.known
    BEGIN${countRemove}${countAdd}
    END;

    CREATE TRIGGER IF NOT EXISTS document_filter_values_document_insert
      AFTER INSERT ON documents BEGIN
      ${queue("NEW.id", "NEW.source_id")}
    END;
    CREATE TRIGGER IF NOT EXISTS document_filter_values_document_update
      AFTER UPDATE OF metadata, source_version, source_id, stream_id, external_id, provider_id ON documents
      WHEN OLD.metadata IS NOT NEW.metadata OR OLD.source_version IS NOT NEW.source_version
        OR OLD.source_id IS NOT NEW.source_id OR OLD.stream_id IS NOT NEW.stream_id
        OR OLD.external_id IS NOT NEW.external_id OR OLD.provider_id IS NOT NEW.provider_id
    BEGIN
      ${queue("NEW.id", "NEW.source_id")}
    END;
    -- A record that changed account or stream leaves its rows behind at once,
    -- and the attachments that named it by its old key are cut again.
    CREATE TRIGGER IF NOT EXISTS document_filter_values_document_rekey
      AFTER UPDATE OF source_id, stream_id, external_id, provider_id ON documents
      WHEN OLD.source_id IS NOT NEW.source_id OR OLD.stream_id IS NOT NEW.stream_id
        OR OLD.external_id IS NOT NEW.external_id OR OLD.provider_id IS NOT NEW.provider_id
    BEGIN${forget("NEW")}
      ${queueAttachments("OLD")}
    END;
    CREATE TRIGGER IF NOT EXISTS document_filter_values_document_delete
      AFTER DELETE ON documents BEGIN${forget("OLD")}
      DELETE FROM document_filter_value_queue WHERE document_id = OLD.id;
      ${queueAttachments("OLD")}
    END;
  `);
}

// ── The declaration ─────────────────────────────────────────────────────────

/** A detail a record of the source can carry, with its bit in `known`. */
export type FilterValueDetail =
  | {
      kind: "field";
      /** The declared path; the field name of its rows. */
      name: string;
      bit: number;
      segments: string[];
      array: boolean;
      /** The field's ids belong to a device: its rows are kept per stream. */
      device: boolean;
      /** A tree, whose counts over several ids need the `[many]` posting. */
      tree: boolean;
    }
  | { kind: "person"; name: typeof FILTER_VALUE_PEOPLE; bit: number; spec: FilterPeopleSpec };

export interface FilterValueDeclaration {
  /**
   * {@link filterDeclarationDigest} of the declaration, with which fields are
   * trees: everything a record's rows depend on.
   */
  digest: string;
  /** Every detail rows are written for. Empty: the source has nothing to filter on, and no rows. */
  details: FilterValueDetail[];
}

/**
 * The details a source's records carry rows for. Bits follow the paths'
 * sorted order, then people, so they depend only on what the digest covers.
 * A path declared twice is read as its first declaration, as a filter reads it.
 */
export function filterValueDeclaration(fields: SourceFilterFields): FilterValueDeclaration {
  const declaration: FilterValueDeclaration = {
    digest: filterDeclarationDigest(fields),
    details: [],
  };
  if (fields.state !== "declared") return declaration;
  const firsts = new Map<string, Extract<(typeof fields.fields)[number], { state: "ready" }>>();
  for (const field of fields.fields) {
    if (firsts.has(field.path)) continue;
    if (field.state === "ready" && filterFieldJsonPath(field.path) !== null) {
      firsts.set(field.path, field);
    } else {
      // A path whose first declaration cannot be applied has no rows.
      firsts.set(field.path, undefined as never);
    }
  }
  const paths = [...firsts.entries()]
    .filter(([, field]) => field !== undefined)
    .map(([path]) => path)
    .sort();
  for (const path of paths) {
    const field = firsts.get(path)!;
    declaration.details.push({
      kind: "field",
      name: path,
      bit: declaration.details.length,
      segments: path.split("."),
      array: field.type === "string-array",
      device: field.filter.scope === "device",
      tree: field.filter.capability === "tree",
    });
  }
  const trees = declaration.details.filter((detail) => detail.kind === "field" && detail.tree);
  if (trees.length > 0) {
    declaration.digest = createHash("sha256")
      .update(JSON.stringify([declaration.digest, trees.map((detail) => detail.name)]))
      .digest("hex")
      .slice(0, 32);
  }
  if (fields.person?.state === "ready") {
    declaration.details.push({
      kind: "person",
      name: FILTER_VALUE_PEOPLE,
      bit: declaration.details.length,
      spec: filterPeopleSpec(fields.person.filter),
    });
  }
  return declaration;
}

/** The declaration of a source type, read once per map. */
export function cachedFilterValueDeclaration(
  db: Db,
  sourceId: string,
  cache: Map<string, FilterValueDeclaration>,
): FilterValueDeclaration {
  const type = sourceTypeOf(sourceId);
  let found = cache.get(type);
  if (!found) {
    found = filterValueDeclaration(filterFieldsFor(db, type));
    cache.set(type, found);
  }
  return found;
}

/** The bit of a detail by its row name: a path or {@link FILTER_VALUE_PEOPLE}. */
export function filterValueBit(declaration: FilterValueDeclaration, name: string): number | null {
  return declaration.details.find((detail) => detail.name === name)?.bit ?? null;
}

// ── People ──────────────────────────────────────────────────────────────────

/**
 * An address is stored with its domain in front, `email:<domain>\u001f<address>`,
 * and a record's domain keys are not stored: the domain an address is under
 * is exactly the domain key the person reader derives from it, so the records
 * of a domain are one range of the address rows rather than a row of their
 * own per record. It roughly halves the rows of a mail source's people.
 */
const DOMAIN_END = "\u001f";

/** The row value of a people-key a record carries, or `null` for a key that is not stored. */
export function storedPersonValue(key: string): string | null {
  if (key.startsWith("domain:")) return null;
  if (!key.startsWith("email:")) return key;
  const address = key.slice("email:".length);
  return `email:${filterIdentifierDomain(address) ?? ""}${DOMAIN_END}${address}`;
}

/**
 * Where the rows of a saved people-key are: one value, or for a domain the
 * range `[from, before)` of the addresses under it.
 */
export function personKeyRows(key: string): { value: string } | { from: string; before: string } {
  if (!key.startsWith("domain:")) return { value: storedPersonValue(key) ?? key };
  const domain = key.slice("domain:".length);
  return { from: `email:${domain}${DOMAIN_END}`, before: `email:${domain} ` };
}

// ── Cutting a record ────────────────────────────────────────────────────────

/** What a record's metadata says, before the record it may be decided through is looked up. */
export type FilterValueCut =
  /** The metadata cannot be read as a JSON object. */
  | { kind: "unreadable" }
  /** An attachment, decided through the record with this external id; `null` when it names none. */
  | { kind: "derived"; parentExternalId: string | null }
  | {
      kind: "self";
      known: number;
      /** `[field, value]`; the device is added when the rows are written. */
      values: Array<[string, string]>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function at(value: unknown, segments: readonly string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/**
 * Cut a record's rows from its stored metadata, by the rules the filter's
 * SQL applies to the same text: a JSON object, an attachment by its document
 * type or by naming the record it was attached to, a field known when it is
 * a non-empty text (or a list of them) and, for a device's field, the record
 * has a stream, people known when the person reader can read them.
 */
export function cutFilterValues(
  metadata: unknown,
  streamId: string,
  declaration: FilterValueDeclaration,
): FilterValueCut {
  let parsed: unknown;
  try {
    parsed = typeof metadata === "string" ? JSON.parse(metadata) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) return { kind: "unreadable" };
  const extra = parsed.extra;
  if (
    parsed.documentType === "attachment" ||
    (isRecord(extra) && Object.prototype.hasOwnProperty.call(extra, "parentExternalId"))
  ) {
    const parent = isRecord(extra) ? extra.parentExternalId : undefined;
    return { kind: "derived", parentExternalId: typeof parent === "string" ? parent : null };
  }
  let known = 0;
  const values: Array<[string, string]> = [];
  for (const detail of declaration.details) {
    if (detail.kind === "person") {
      const keys = Array.isArray(parsed.people)
        ? projectFilterPeople(parsed.people, detail.spec)
        : null;
      if (keys === null) continue;
      known |= 1 << detail.bit;
      for (const key of keys) {
        const stored = storedPersonValue(key);
        if (stored !== null) values.push([detail.name, stored]);
      }
      continue;
    }
    if (detail.device && streamId === "") continue;
    const value = at(parsed, detail.segments);
    let ids: string[] | null;
    if (detail.array) {
      ids =
        Array.isArray(value) && value.every((id) => typeof id === "string" && id !== "")
          ? [...new Set(value as string[])]
          : null;
    } else {
      ids = typeof value === "string" && value !== "" ? [value] : null;
    }
    if (ids === null) continue;
    known |= 1 << detail.bit;
    if (detail.device) values.push([detail.name, ""]);
    if (detail.tree && ids.length > 1) values.push([manyValuesField(detail.name), ""]);
    for (const id of ids) values.push([detail.name, id]);
  }
  return { kind: "self", known, values };
}

// ── Writing rows ────────────────────────────────────────────────────────────

/** A stored record, as the rows are cut from it. */
export interface FilterValueDocument {
  id: string;
  providerId: string;
  sourceId: string;
  externalId: string;
  streamId: string;
  sourceVersion: number;
  metadata: string;
}

/** What a record's rows are: its state, and the slot and value of each posting. */
interface Cut {
  state: string;
  version: number;
  known: number;
  postings: Array<{ slot: number; value: string }>;
}

/** A record's row, found through its document, `null` columns when it has none. */
interface FoundRecord {
  seq: number;
  found: number | null;
  state: string | null;
  source_version: number | null;
  known: number | null;
  terms: string | null;
}

/** Statements and caches for one batch of writes. */
class RowWriter {
  private readonly slots = new Map<string, number>();
  private readonly terms = new Map<string, number>();
  /** Postings to insert, as `[term, seq, version, known]`, and the records they belong to. */
  private readonly pending: Array<[number, number, number, number]> = [];
  private readonly pendingRecords = new Set<number>();
  readonly declarations = new Map<string, FilterValueDeclaration>();
  private readonly findSlot;
  private readonly createSlot;
  private readonly findTerm;
  private readonly createTerm;
  private readonly findRecord;
  private readonly createRecord;
  private readonly updateRecord;
  private readonly deleteRecord;
  private readonly readTerms;
  private readonly insertPosting;
  private readonly deletePosting;
  private readonly updatePostings;
  private readonly dequeue;
  private readonly attachments;
  private readonly parent;
  private readonly queued;
  private readonly light;

  constructor(private readonly db: Db) {
    this.findSlot = db.prepare<[string, string, string], { slot: number }>(
      "SELECT slot FROM document_filter_slots WHERE source_id = ? AND field = ? AND device_id = ?",
    );
    this.createSlot = db.prepare<[string, string, string]>(
      "INSERT INTO document_filter_slots (source_id, field, device_id) VALUES (?, ?, ?)",
    );
    this.findTerm = db.prepare<[number, string], { term: number }>(
      "SELECT term FROM document_filter_terms WHERE slot = ? AND value = ?",
    );
    this.createTerm = db.prepare<[number, string]>(
      "INSERT INTO document_filter_terms (slot, value) VALUES (?, ?)",
    );
    this.findRecord = db.prepare<[string], FoundRecord>(
      `SELECT d.rowid AS seq, r.seq AS found, r.state, r.source_version, r.known, r.terms
         FROM documents d LEFT JOIN document_filter_records r ON r.seq = d.rowid
        WHERE d.id = ?`,
    );
    this.createRecord = db.prepare<[number, string, string, number, number, string]>(
      `INSERT INTO document_filter_records (seq, source_id, state, source_version, known, terms)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.updateRecord = db.prepare<[string, string, number, number, string, number]>(
      `UPDATE document_filter_records
          SET source_id = ?, state = ?, source_version = ?, known = ?, terms = ?
        WHERE seq = ?`,
    );
    this.deleteRecord = db.prepare<[number]>("DELETE FROM document_filter_records WHERE seq = ?");
    this.readTerms = db.prepare<[number], { slot: number; value: string }>(
      `SELECT t.slot, t.value FROM document_filter_records r, json_each(r.terms) j
         JOIN document_filter_terms t ON t.term = j.value WHERE r.seq = ?`,
    );
    this.insertPosting = db.prepare<[number, number, number, number]>(
      `INSERT INTO document_filter_postings (level, term, seq, source_version, known)
       VALUES (0, ?, ?, ?, ?)`,
    );
    this.deletePosting = db.prepare<[number, number]>(
      `DELETE FROM document_filter_postings WHERE ${postingAtAnyLevel("document_filter_postings", "?")} AND seq = ?`,
    );
    this.updatePostings = db.prepare<[number, number, number, number]>(
      `UPDATE document_filter_postings SET source_version = ?, known = ?
        WHERE ${postingAtAnyLevel("document_filter_postings", "?")} AND seq = ?`,
    );
    this.dequeue = db.prepare<[string]>(
      "DELETE FROM document_filter_value_queue WHERE document_id = ?",
    );
    this.attachments = db.prepare<[number, string, string], { document_id: string }>(
      `SELECT d.id AS document_id FROM document_filter_terms t
         JOIN document_filter_postings p ON ${postingOfTerm("p", "t.term")}
         JOIN documents d ON d.rowid = p.seq
        WHERE t.slot = ? AND t.value = ? AND d.id <> ?`,
    );
    this.parent = db.prepare<[string, string, string, string, string], { id: string }>(
      `SELECT id FROM documents
        WHERE provider_id = ? AND source_id = ? AND external_id = ? AND stream_id = ? AND id <> ?`,
    );
    this.queued = db.prepare<[string], { one: number }>(
      "SELECT 1 AS one FROM document_filter_value_queue WHERE document_id = ?",
    );
    this.light = db.prepare<[string], Omit<StoredRecord, "metadata">>(
      `SELECT id, provider_id, source_id, external_id, stream_id, source_version
         FROM documents WHERE id = ?`,
    );
  }

  declaration(sourceId: string): FilterValueDeclaration {
    return cachedFilterValueDeclaration(this.db, sourceId, this.declarations);
  }

  slot(sourceId: string, field: string, deviceId: string): number {
    const key = JSON.stringify([sourceId, field, deviceId]);
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = this.findSlot.get(sourceId, field, deviceId)?.slot;
      if (slot === undefined) {
        slot = Number(this.createSlot.run(sourceId, field, deviceId).lastInsertRowid);
      }
      this.slots.set(key, slot);
    }
    return slot;
  }

  term(slot: number, value: string): number {
    const key = `${slot}\n${value}`;
    let term = this.terms.get(key);
    if (term === undefined) {
      term = this.findTerm.get(slot, value)?.term;
      if (term === undefined) term = Number(this.createTerm.run(slot, value).lastInsertRowid);
      this.terms.set(key, term);
    }
    return term;
  }

  /**
   * Make the record's rows exactly `cut`, touching only what differs: a
   * record whose details did not change writes nothing, and one whose version
   * rose rewrites only the copies of its version.
   */
  replace(document: { id: string; sourceId: string }, cut: Cut): void {
    const record = this.findRecord.get(document.id);
    if (!record) return;
    const seq = record.seq;
    if (this.pendingRecords.has(seq)) this.flush();
    const terms = [
      ...new Set(cut.postings.map((posting) => this.term(posting.slot, posting.value))),
    ].sort((left, right) => left - right);
    const list = JSON.stringify(terms);
    const held = record.found === null ? [] : (JSON.parse(record.terms!) as number[]);
    const added = new Set(terms);
    const changed =
      record.state !== cut.state ||
      record.source_version !== cut.version ||
      record.known !== cut.known;
    for (const term of held) {
      if (added.delete(term)) {
        if (record.source_version !== cut.version || record.known !== cut.known) {
          this.updatePostings.run(cut.version, cut.known, term, seq);
        }
      } else {
        this.deletePosting.run(term, seq);
      }
    }
    if (record.found === null) {
      this.createRecord.run(seq, document.sourceId, cut.state, cut.version, cut.known, list);
    } else if (changed || record.terms !== list) {
      this.updateRecord.run(document.sourceId, cut.state, cut.version, cut.known, list, seq);
    }
    for (const term of added) this.pending.push([term, seq, cut.version, cut.known]);
    if (added.size > 0) this.pendingRecords.add(seq);
  }

  /**
   * Insert the postings held back so far, in key order: the records of one
   * transaction that share a term then add to its run together.
   */
  flush(): void {
    this.pending.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    for (const posting of this.pending) this.insertPosting.run(...posting);
    this.pending.length = 0;
    this.pendingRecords.clear();
  }

  /** Remove the rows of a stored record; a deleted record's went with it. */
  forget(documentId: string): void {
    const record = this.findRecord.get(documentId);
    if (record?.found == null) return;
    if (this.pendingRecords.has(record.seq)) this.flush();
    for (const term of JSON.parse(record.terms!) as number[]) {
      this.deletePosting.run(term, record.seq);
    }
    this.deleteRecord.run(record.seq);
  }

  done(documentId: string): void {
    this.dequeue.run(documentId);
  }

  /**
   * Write the rows of a record from its cut. A derived record copies the rows
   * of the record it is decided through, as they stand.
   */
  write(document: Omit<FilterValueDocument, "metadata">, cut: FilterValueCut): void {
    const declaration = this.declaration(document.sourceId);
    if (declaration.details.length === 0) {
      this.forget(document.id);
      return;
    }
    const unknown: Cut = { state: RECORD_UNKNOWN, version: 0, known: 0, postings: [] };
    if (cut.kind === "unreadable") {
      this.replace(document, unknown);
      return;
    }
    if (cut.kind === "self") {
      // A device's field keeps its rows, and its `[many]` row, per stream.
      const devices = new Map<string, string>();
      for (const detail of declaration.details) {
        if (detail.kind !== "field" || !detail.device) continue;
        devices.set(detail.name, document.streamId);
        devices.set(manyValuesField(detail.name), document.streamId);
      }
      this.replace(document, {
        state: RECORD_SELF,
        version: document.sourceVersion,
        known: cut.known,
        postings: cut.values.map(([field, value]) => ({
          slot: this.slot(document.sourceId, field, devices.get(field) ?? ""),
          value,
        })),
      });
      return;
    }
    const own =
      cut.parentExternalId === null
        ? []
        : [
            {
              slot: this.slot(document.sourceId, FILTER_VALUE_PARENT, document.streamId),
              value: cut.parentExternalId,
            },
          ];
    const parentId =
      cut.parentExternalId === null
        ? undefined
        : this.parent.get(
            document.providerId,
            document.sourceId,
            cut.parentExternalId,
            document.streamId,
            document.id,
          )?.id;
    const found = parentId === undefined ? undefined : this.findRecord.get(parentId);
    const parent = found?.found == null ? undefined : found;
    if (parent?.state !== RECORD_SELF) {
      this.replace(document, { ...unknown, postings: own });
      return;
    }
    // A record decided on its own has no `[parent]` posting, so its postings
    // are exactly the details the attachment is decided by. Its row lists
    // them, postings still held back included.
    const copied = this.readTerms.all(parent.seq);
    this.replace(document, {
      state: RECORD_DERIVED,
      version: parent.source_version!,
      known: parent.known!,
      postings: [...own, ...copied],
    });
  }

  /**
   * Copy a record's rows to the records attached to it, found by the external
   * id their `[parent]` row names. Such a row exists only on a record cut as
   * an attachment of that id, so the copy is all there is to redo; an
   * attachment whose own metadata has changed is queued and cut again, and is
   * skipped here, as is anything in `skip`.
   */
  refreshAttachments(
    document: Omit<FilterValueDocument, "metadata">,
    skip: ReadonlySet<string> = new Set(),
  ): void {
    const slot = this.slot(document.sourceId, FILTER_VALUE_PARENT, document.streamId);
    for (const { document_id: id } of this.attachments.all(
      slot,
      document.externalId,
      document.id,
    )) {
      if (skip.has(id) || this.queued.get(id)) continue;
      const row = this.light.get(id);
      if (!row) continue;
      this.write(
        {
          id: row.id,
          providerId: row.provider_id,
          sourceId: row.source_id,
          externalId: row.external_id,
          streamId: row.stream_id,
          sourceVersion: row.source_version,
        },
        { kind: "derived", parentExternalId: document.externalId },
      );
    }
  }
}

interface StoredRecord {
  id: string;
  provider_id: string;
  source_id: string;
  external_id: string;
  stream_id: string;
  source_version: number;
  metadata: string;
}

function readStored(db: Db, ids: readonly string[]): StoredRecord[] {
  if (ids.length === 0) return [];
  return db
    .prepare<[string], StoredRecord>(
      `SELECT id, provider_id, source_id, external_id, stream_id, source_version, metadata
         FROM documents WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids));
}

function asDocument(row: StoredRecord): FilterValueDocument {
  return {
    id: row.id,
    providerId: row.provider_id,
    sourceId: row.source_id,
    externalId: row.external_id,
    streamId: row.stream_id,
    sourceVersion: row.source_version,
    metadata: row.metadata,
  };
}

/**
 * Write the rows of records just stored, and of the records attached to them,
 * and take them all off the queue. Runs on the writer, inside the transaction
 * that stored the records. `documents` must be the stored state of each
 * record: its stored version and metadata.
 */
export function writeDocumentFilterValues(db: Db, documents: readonly FilterValueDocument[]): void {
  if (documents.length === 0) return;
  db.transaction(() => {
    const writer = new RowWriter(db);
    const cuts = documents.map((document) => ({
      document,
      cut: cutFilterValues(
        document.metadata,
        document.streamId,
        writer.declaration(document.sourceId),
      ),
    }));
    // A record before what is attached to it, so a copy reads fresh rows.
    cuts.sort(
      (left, right) => Number(left.cut.kind === "derived") - Number(right.cut.kind === "derived"),
    );
    const written = new Set(documents.map((document) => document.id));
    for (const { document, cut } of cuts) {
      writer.write(document, cut);
      writer.done(document.id);
    }
    for (const document of documents) writer.refreshAttachments(document, written);
    writer.flush();
    mergeLevelZeroWhenFull(db);
    markNewAccountsCut(db, documents, writer);
  })();
}

/**
 * An account with no recorded declaration whose every record was just cut
 * (its first page) has all its rows cut under the current declaration, so it
 * is recorded as done rather than left for a pass that would cut it again.
 */
function markNewAccountsCut(
  db: Db,
  documents: readonly FilterValueDocument[],
  writer: RowWriter,
): void {
  const bySource = new Map<string, Set<string>>();
  for (const document of documents) {
    const ids = bySource.get(document.sourceId) ?? new Set<string>();
    ids.add(document.id);
    bySource.set(document.sourceId, ids);
  }
  const recorded = db.prepare<[string], { one: number }>(
    "SELECT 1 AS one FROM document_filter_value_sources WHERE source_id = ?",
  );
  const held = db.prepare<[string], { n: number }>(
    "SELECT coalesce(sum(document_count), 0) AS n FROM source_version_counts WHERE source_id = ?",
  );
  const record = db.prepare<[string, string]>(
    `INSERT INTO document_filter_value_sources (source_id, declaration, pending_after)
     VALUES (?, ?, NULL)`,
  );
  for (const [sourceId, ids] of bySource) {
    if (recorded.get(sourceId)) continue;
    if (held.get(sourceId)!.n !== ids.size) continue;
    record.run(sourceId, writer.declaration(sourceId).digest);
  }
}

// ── The background drain ────────────────────────────────────────────────────

/** The rows of one queued record, cut on a reader. */
export interface FilterValueWork {
  documentId: string;
  /** The queue revision the record was read at. */
  revision: number;
  /** `null` when the record is gone. */
  document: Omit<FilterValueDocument, "metadata"> | null;
  /** Digest of the declaration the cut was made under. */
  declaration: string;
  cut: FilterValueCut | null;
}

/**
 * Read and cut the next queued records. Read-only; run it on a reader. The
 * cut of a record is the slow part of the work: its metadata is read and its
 * people projected.
 */
export function readFilterValueWork(db: Db, limit: number): FilterValueWork[] {
  const queued = db
    .prepare<[number], { document_id: string; revision: number }>(
      "SELECT document_id, revision FROM document_filter_value_queue ORDER BY document_id LIMIT ?",
    )
    .all(Math.max(1, Math.floor(limit)));
  if (queued.length === 0) return [];
  const stored = new Map(
    readStored(
      db,
      queued.map((row) => row.document_id),
    ).map((row) => [row.id, row]),
  );
  const declarations = new Map<string, FilterValueDeclaration>();
  return queued.map((entry): FilterValueWork => {
    const row = stored.get(entry.document_id);
    if (!row) {
      return {
        documentId: entry.document_id,
        revision: entry.revision,
        document: null,
        declaration: "",
        cut: null,
      };
    }
    const declaration = cachedFilterValueDeclaration(db, row.source_id, declarations);
    const { metadata, ...document } = asDocument(row);
    return {
      documentId: entry.document_id,
      revision: entry.revision,
      document,
      declaration: declaration.digest,
      cut: cutFilterValues(metadata, row.stream_id, declaration),
    };
  });
}

/** The drain's and the merge's reads, as a read port for the io worker. */
export const FILTER_VALUE_READS = {
  filterValueWork: readFilterValueWork,
  filterPostingLevelToMerge,
};

/**
 * Apply rows cut by {@link readFilterValueWork}. A record queued again since
 * it was read, or cut under a declaration that has changed since, is left
 * queued for the next read. Stops between records once `shouldYield` says so
 * and returns what it did not reach.
 */
export function applyFilterValueWork(
  db: Db,
  work: readonly FilterValueWork[],
  shouldYield: () => boolean = () => false,
): { applied: number; remaining: FilterValueWork[] } {
  const revision = db.prepare<[string], { revision: number }>(
    "SELECT revision FROM document_filter_value_queue WHERE document_id = ?",
  );
  // A record before what is attached to it, so a copy reads fresh rows.
  const ordered = [...work].sort(
    (left, right) => Number(left.cut?.kind === "derived") - Number(right.cut?.kind === "derived"),
  );
  let applied = 0;
  const step = 50;
  for (let offset = 0; offset < ordered.length; offset += step) {
    if (offset > 0 && shouldYield()) return { applied, remaining: ordered.slice(offset) };
    db.transaction(() => {
      const writer = new RowWriter(db);
      for (const item of ordered.slice(offset, offset + step)) {
        if (revision.get(item.documentId)?.revision !== item.revision) continue;
        if (!item.document || !item.cut) {
          writer.forget(item.documentId);
          writer.done(item.documentId);
          applied++;
          continue;
        }
        if (writer.declaration(item.document.sourceId).digest !== item.declaration) continue;
        writer.write(item.document, item.cut);
        writer.done(item.documentId);
        writer.refreshAttachments(item.document);
        applied++;
      }
      writer.flush();
      mergeLevelZeroWhenFull(db);
    })();
  }
  return { applied, remaining: [] };
}

// ── Merging postings a level up ─────────────────────────────────────────────
//
// A merge moves every posting of one level into the next, lowest terms first.
// Moving postings in term order into a level about ten times larger touches
// each page of that level about once, for some tens of postings each; writing
// them one by one where they belong would touch a page per posting. Each
// posting is moved once per level, so its share of the merges is a fraction of
// a page.
//
// Level 0 is kept to a few pages, so a transaction of a handful of records
// touches only those: whoever writes postings merges it into level 1 once it
// is full, a bounded step of a few milliseconds. Larger levels are merged by
// the background task.

/** Postings level 0 holds before it is merged; level `k` holds ten times level `k - 1`. */
export const FILTER_POSTING_LEVEL_BASE = 1_000;
/** About how many postings one transaction of a merge moves. */
export const FILTER_POSTING_MERGE_SLICE = 500;

/** How many postings level `level` holds before it is merged into the next. */
export function filterPostingLevelCapacity(level: number): number {
  return level >= POSTING_LEVELS - 1 ? Infinity : FILTER_POSTING_LEVEL_BASE * 10 ** level;
}

/**
 * The lowest level that is full and must be merged into the next, or `null`.
 * Read-only, and bounded: level 0 is counted up to its capacity, the others
 * are read from `document_filter_levels`.
 */
export function filterPostingLevelToMerge(db: Db): number | null {
  if (levelZeroFull(db)) return 0;
  const full = db
    .prepare<[], { level: number; postings: number }>(
      "SELECT level, postings FROM document_filter_levels ORDER BY level",
    )
    .all()
    .find((row) => row.postings >= filterPostingLevelCapacity(row.level));
  return full?.level ?? null;
}

/** Whether level 0 holds its capacity, counted no further. */
function levelZeroFull(db: Db): boolean {
  const capacity = filterPostingLevelCapacity(0);
  return (
    db
      .prepare<[number], { n: number }>(
        `SELECT count(*) AS n FROM (
           SELECT 1 FROM document_filter_postings WHERE level = 0 LIMIT ?)`,
      )
      .get(capacity)!.n >= capacity
  );
}

/**
 * Merge level 0 into level 1 when it is full. Called by every write of
 * postings, inside its transaction, after the postings are in.
 */
function mergeLevelZeroWhenFull(db: Db): void {
  if (levelZeroFull(db)) mergeFilterPostings(db, 0);
}

/**
 * Move the postings of `level` into the next level, lowest terms first, in
 * transactions of about `slice` postings (every posting of the last term
 * taken), until the level is empty. Stops between transactions once
 * `shouldYield` says so; calling it again goes on where it stopped.
 */
export function mergeFilterPostings(
  db: Db,
  level: number,
  shouldYield: () => boolean = () => false,
  slice: number = FILTER_POSTING_MERGE_SLICE,
): { moved: number; done: boolean } {
  if (!Number.isInteger(level) || level < 0 || level >= POSTING_LEVELS - 1) {
    throw new Error(`No filter posting level ${level} to merge.`);
  }
  const bound = db.prepare<[number, number], { term: number }>(
    "SELECT term FROM document_filter_postings WHERE level = ? ORDER BY term LIMIT 1 OFFSET ?",
  );
  const move = db.prepare<[number, number, number]>(
    `INSERT INTO document_filter_postings (level, term, seq, source_version, known)
     SELECT ?, term, seq, source_version, known FROM document_filter_postings
      WHERE level = ? AND term <= ? ORDER BY term, seq`,
  );
  const clear = db.prepare<[number, number]>(
    "DELETE FROM document_filter_postings WHERE level = ? AND term <= ?",
  );
  const count = db.prepare<[number, number]>(
    `INSERT INTO document_filter_levels (level, postings) VALUES (?, ?)
     ON CONFLICT(level) DO UPDATE SET postings = max(0, postings + excluded.postings)`,
  );
  const empty = db.prepare<[number]>(
    "UPDATE document_filter_levels SET postings = 0 WHERE level = ?",
  );
  const step = Math.max(1, Math.floor(slice));
  let moved = 0;
  for (let first = true; ; first = false) {
    if (!first && shouldYield()) return { moved, done: false };
    const last = db.transaction(() => {
      const term = bound.get(level, step - 1)?.term ?? Number.MAX_SAFE_INTEGER;
      const n = move.run(level + 1, level, term).changes;
      clear.run(level, term);
      moved += n;
      count.run(level + 1, n);
      if (term === Number.MAX_SAFE_INTEGER) {
        empty.run(level);
        return true;
      }
      if (level > 0) count.run(level, -n);
      return false;
    })();
    if (last) return { moved, done: true };
  }
}

/**
 * Merge every full level, on one handle and in one go. For tools, tests and
 * the benchmark; the gateway merges a bounded slice at a time.
 */
export function mergeFullFilterPostingLevels(db: Db): void {
  for (let level = filterPostingLevelToMerge(db); level !== null;) {
    mergeFilterPostings(db, level);
    level = filterPostingLevelToMerge(db);
  }
}

// ── Accounts ────────────────────────────────────────────────────────────────

/**
 * Whether a reader may use an account's rows in place of its records: they
 * were all cut under the source's current declaration, which declares
 * something, and none of the account's records waits to be cut again. Asked
 * inside the transaction that reads the rows.
 */
export function filterValuesReady(
  db: Db,
  sourceId: string,
  declaration: FilterValueDeclaration,
): boolean {
  if (declaration.details.length === 0) return false;
  const state = db
    .prepare<[string], { declaration: string; pending_after: number | null }>(
      "SELECT declaration, pending_after FROM document_filter_value_sources WHERE source_id = ?",
    )
    .get(sourceId);
  if (!state || state.declaration !== declaration.digest || state.pending_after !== null) {
    return false;
  }
  return !db
    .prepare<[string], { one: number }>(
      "SELECT 1 AS one FROM document_filter_value_queue WHERE source_id = ? LIMIT 1",
    )
    .get(sourceId);
}

/** {@link filterValuesReady} as SQL, for a statement that decides it in its own snapshot. */
export function filterValuesReadySql(
  sourceId: string,
  declaration: FilterValueDeclaration,
): { sql: string; params: string[] } {
  if (declaration.details.length === 0) return { sql: "0", params: [] };
  return {
    sql: `(EXISTS (SELECT 1 FROM document_filter_value_sources
                    WHERE source_id = ? AND declaration = ? AND pending_after IS NULL)
           AND NOT EXISTS (SELECT 1 FROM document_filter_value_queue WHERE source_id = ?))`,
    params: [sourceId, declaration.digest, sourceId],
  };
}

/** Records one call of {@link advanceFilterValuePasses} queues. */
export const FILTER_VALUE_PASS_BATCH = 500;

/**
 * Queue the records of an account whose rows were cut under another
 * declaration than its source's current one, or never cut, `limit` at a time
 * in rowid order, resuming where the last call stopped. One account per call.
 * Also forgets the state of accounts that hold no records any more.
 *
 * Returns how many records it queued and whether it changed anything.
 */
export function advanceFilterValuePasses(
  db: Db,
  limit: number = FILTER_VALUE_PASS_BATCH,
): { queued: number; changed: boolean } {
  const batch = Math.max(1, Math.floor(limit));
  return db.transaction(() => {
    const declarations = new Map<string, FilterValueDeclaration>();
    const states = new Map(
      db
        .prepare<[], { source_id: string; declaration: string; pending_after: number | null }>(
          "SELECT source_id, declaration, pending_after FROM document_filter_value_sources",
        )
        .all()
        .map((row) => [row.source_id, row]),
    );
    const sources = db
      .prepare<[], { source_id: string }>(
        "SELECT DISTINCT source_id FROM source_version_counts ORDER BY source_id",
      )
      .all()
      .map((row) => row.source_id);
    const present = new Set(sources);
    let changed = false;
    for (const sourceId of states.keys()) {
      if (present.has(sourceId)) continue;
      db.prepare("DELETE FROM document_filter_value_sources WHERE source_id = ?").run(sourceId);
      // The account's records are gone, and with them every posting: its
      // terms and slots name nothing.
      db.prepare(
        `DELETE FROM document_filter_terms
          WHERE slot IN (SELECT slot FROM document_filter_slots WHERE source_id = ?)
            AND NOT EXISTS (SELECT 1 FROM document_filter_postings p
                             WHERE ${postingOfTerm("p", "document_filter_terms.term")})`,
      ).run(sourceId);
      db.prepare(
        `DELETE FROM document_filter_slots WHERE source_id = ?
           AND NOT EXISTS (SELECT 1 FROM document_filter_terms t WHERE t.slot = document_filter_slots.slot)`,
      ).run(sourceId);
      changed = true;
    }
    const setState = db.prepare<[string, string, number | null]>(
      `INSERT INTO document_filter_value_sources (source_id, declaration, pending_after)
       VALUES (?, ?, ?)
       ON CONFLICT(source_id) DO UPDATE SET
         declaration = excluded.declaration, pending_after = excluded.pending_after`,
    );
    for (const sourceId of sources) {
      const declaration = cachedFilterValueDeclaration(db, sourceId, declarations);
      const state = states.get(sourceId);
      if (state && state.declaration === declaration.digest && state.pending_after === null) {
        continue;
      }
      let after = state?.declaration === declaration.digest ? (state.pending_after ?? 0) : 0;
      if (state?.declaration !== declaration.digest) {
        const hasRows = db
          .prepare<[string], { one: number }>(
            "SELECT 1 AS one FROM document_filter_slots WHERE source_id = ? LIMIT 1",
          )
          .get(sourceId);
        // Nothing to cut and nothing to remove.
        if (declaration.details.length === 0 && !hasRows) {
          setState.run(sourceId, declaration.digest, null);
          return { queued: 0, changed: true };
        }
        after = 0;
      }
      const rows = db
        .prepare<[string, number, number], { rowid: number; id: string; source_id: string }>(
          `SELECT rowid, id, source_id FROM documents INDEXED BY idx_documents_source_id
            WHERE source_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
        )
        .all(sourceId, after, batch);
      // A record already queued is cut as it is when its turn comes, under
      // the declaration current then, so the pass leaves it as it is.
      const enqueue = db.prepare<[string, string]>(
        `INSERT INTO document_filter_value_queue (document_id, source_id, revision) VALUES (?, ?, 1)
         ON CONFLICT(document_id) DO NOTHING`,
      );
      for (const row of rows) enqueue.run(row.id, row.source_id);
      setState.run(
        sourceId,
        declaration.digest,
        rows.length < batch ? null : rows[rows.length - 1]!.rowid,
      );
      return { queued: rows.length, changed: true };
    }
    return { queued: 0, changed };
  })();
}

/**
 * Finish every pass and cut every queued record, on one handle and in one
 * go. For tools, tests and the benchmark; the gateway does the same work a
 * bounded batch per tick, reading on a reader and applying on the writer.
 */
export function settleFilterValues(db: Db, batch = FILTER_VALUE_PASS_BATCH): void {
  for (;;) {
    const work = readFilterValueWork(db, batch);
    if (work.length > 0) {
      if (applyFilterValueWork(db, work).applied === 0) {
        throw new Error("Queued filter rows could not be applied.");
      }
      continue;
    }
    if (!advanceFilterValuePasses(db, batch).changed) return;
  }
}
