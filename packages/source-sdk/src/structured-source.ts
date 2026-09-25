// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Structured source types for analytics data — column shapes, sync-result
 * shapes, and the analytics catalog entry.
 *
 * The runtime contract for a structured source is `SourceInstance` (with
 * its `syncStructured` + `analyticsSchemas` fields, both optional) —
 * `defineStructuredSource()` wires it up. The legacy `StructuredSource`
 * interface (which extended the deprecated `Source` shape) and its
 * `isStructuredSource` runtime guard were removed:
 * neither was implemented or invoked anywhere outside this module's
 * own export, so dropping them shrinks the public surface without
 * touching any provider.
 */

import { PERSON_ROLES, type DocumentInput, type PersonRole, type SyncIssue } from "@omnesis/types";
import {
  canonicalTemporalKind,
  TEMPORAL_KINDS,
  TEMPORAL_MODALITIES,
  TEMPORAL_STATUSES,
  type TemporalKind,
  type TemporalModality,
  type TemporalStatus,
} from "@omnesis/types/temporal-vocabulary";
import type { SyncCursor, SyncProgress, SourceWatermark } from "./source.js";
import type { SnapshotClaim } from "./snapshot.js";
import type { PageTableWrites } from "./table-write.js";
import type { EdgeDeclaration } from "@omnesis/core";

/**
 * DuckDB-compatible column types.
 *
 * `DECIMAL(p,s)` (precision, scale — e.g. `"DECIMAL(18,4)"`) is for money
 * and other exact-numeric columns. Records MUST carry values for these
 * columns as validated decimal strings (`"123.45"`, `"-23.40"`), never as
 * JS floats: strings survive the JSON ingest transport losslessly and
 * DuckDB casts the quoted SQL literal exactly into the column, whereas a
 * number would round-trip through IEEE-754. Write the type string with no
 * space after the comma — `"DECIMAL(18,4)"`, not `"DECIMAL(18, 4)"` — to
 * match DuckDB's canonical rendering in `information_schema` (TypeScript's
 * `${number}` placeholder is whitespace-lenient and will not catch a
 * spaced spelling for you).
 */
export type ColumnType =
  | "VARCHAR"
  | "INTEGER"
  | "BIGINT"
  | "DOUBLE"
  | "FLOAT"
  | "BOOLEAN"
  | "DATE"
  | "TIMESTAMP"
  | "TIMESTAMPTZ"
  | "INTERVAL"
  | "JSON"
  | "VARCHAR[]"
  | `DECIMAL(${number},${number})`;

const SIMPLE_COLUMN_TYPES: Record<string, ColumnType> = {
  VARCHAR: "VARCHAR",
  TEXT: "VARCHAR",
  INTEGER: "INTEGER",
  BIGINT: "BIGINT",
  DOUBLE: "DOUBLE",
  FLOAT: "FLOAT",
  BOOLEAN: "BOOLEAN",
  DATE: "DATE",
  TIMESTAMP: "TIMESTAMP",
  TIMESTAMPTZ: "TIMESTAMPTZ",
  "TIMESTAMP WITH TIME ZONE": "TIMESTAMPTZ",
  INTERVAL: "INTERVAL",
  JSON: "JSON",
  "VARCHAR[]": "VARCHAR[]",
};

/**
 * Normalize a runtime-supplied analytics column type to the closed `ColumnType`
 * set. Dynamic schemas arrive over JSON, so the TypeScript union above is not
 * a boundary guard: this parser rejects arbitrary DuckDB type fragments before
 * they can be interpolated into CREATE/ALTER TABLE statements.
 */
export function normalizeAnalyticsColumnType(type: unknown, contextLabel: string): ColumnType {
  if (typeof type !== "string") {
    throw new Error(`${contextLabel}: analytics column type must be a string.`);
  }

  const normalized = type.trim().toUpperCase().replace(/\s+/g, " ");
  const simple = SIMPLE_COLUMN_TYPES[normalized];
  if (simple) return simple;

  const decimal = normalized.match(/^DECIMAL\(\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)$/);
  if (decimal) {
    const precision = Number(decimal[1]);
    const scale = Number(decimal[2]);
    if (precision < 1 || precision > 38) {
      throw new Error(
        `${contextLabel}: DECIMAL precision must be between 1 and 38 (got ${precision}).`,
      );
    }
    if (scale < 0 || scale > precision) {
      throw new Error(
        `${contextLabel}: DECIMAL scale must be between 0 and precision (got ${scale}).`,
      );
    }
    return `DECIMAL(${precision},${scale})` as ColumnType;
  }

  throw new Error(
    `${contextLabel}: unsupported analytics column type '${type}'. ` +
      `Use one of the source-sdk ColumnType values; arbitrary DuckDB type fragments are not accepted.`,
  );
}

/**
 * Semantic reference targets for a column. Drives portal link rendering:
 * the column value is treated as an id (or URL) that resolves to a portal
 * page. Source-of-truth for "is this id clickable" lives on the schema,
 * not on the renderer — so a `health_workouts.id` (UUID-shaped but not a
 * document id) doesn't get an incorrect `/portal/doc/...` link.
 *
 * `"url"` also carries a privacy obligation: the row is *about* the page at
 * that URL, so when the user deletes the source's document for that URL for
 * good, the gateway removes the row with it. Declare it only on a column
 * that names the row's own page — a referrer or parent URL must not.
 */
export type ColumnReference = "document" | "person" | "source" | "url";

/**
 * Definition of a single column in an analytics table.
 */
export interface ColumnDefinition {
  /** Column name (snake_case) */
  name: string;
  /** DuckDB column type */
  type: ColumnType;
  /** Human-readable description */
  description: string;
  /** Whether this column can be NULL (default: false) */
  nullable?: boolean;
  /**
   * Semantic reference: when set, the portal renders this column's value
   * as a link to the corresponding portal page (or external URL).
   */
  references?: ColumnReference;
  /**
   * Credential / secret material. The catalog preview replaces values in
   * this column with a redaction marker so screenshots / screen-shares
   * don't leak session cookies, token hashes, etc. The schema itself
   * (column name + type + description) still renders.
   */
  sensitive?: boolean;
  /**
   * Bookkeeping rather than meaning: the column records something about the
   * fetch, not about the thing the row describes.
   *
   * Rows are PK-upserted, and a source rewrites one whenever its own
   * housekeeping moves — a fetch stamp cleared and repopulated by an
   * enrichment pass, an internal digest recomputed. Those writes are genuine
   * mutations of the row and carry no news at all, so a consumer deciding
   * "did this row change?" by comparing the whole row sees a change every
   * time — and anything standing on that answer speaks every time, with
   * nothing to say.
   *
   * Consumers that ask that question exclude declared-volatile columns from
   * the comparison. Only the source knows which of its columns are which, so
   * only the source can declare it. Set it on stamps, digests and internal
   * ids; never on a value a user would recognise as part of the record.
   */
  volatile?: boolean;
  /**
   * Exhaustive, source-owned values for a categorical VARCHAR column.
   *
   * Subscription compilation may expose this bounded schema vocabulary to the
   * background model and validates the selected value against it. Values must
   * describe the source contract, never values sampled from a user's corpus.
   * Omit this field for open-ended strings.
   */
  allowedValues?: string[];
  /**
   * Known exact values for an open or extensible VARCHAR vocabulary.
   *
   * Unlike `allowedValues`, this list is deliberately non-exhaustive: sources
   * may still emit other values. Subscription compilation may use these
   * source-owned canonical spellings as hints, but cannot reject other values
   * solely because they are absent. Never populate this from user rows.
   */
  canonicalValues?: string[];
  /**
   * Source-owned human phrases for canonical categorical values.
   *
   * Keys must be present in `allowedValues` or `canonicalValues`. The compiler
   * uses these phrases to map natural language to exact wire values without
   * hardcoding source vocabulary in shared code.
   */
  valueAliases?: Record<string, string[]>;
  /**
   * Declares how a categorical column participates in subscription intent.
   *
   * `series` selects a measurement series in a tall table. `selector` chooses
   * a row subtype such as an activity or state. When a user explicitly names
   * one of its values, compilation must positively select the intended value.
   * Auxiliary categorical metadata should omit this field.
   */
  categoricalRole?: "series" | "selector";
  /**
   * Stable source-side identifier for the upstream "thing" this column
   * represents. Set by sources whose underlying schema can rename
   * columns without changing identity (Notion property `id` is the
   * canonical case — the user can rename a property "Status" to
   * "State" and the property `id` stays the same). The gateway's
   * `evolveTableSchema` matches columns by `sourceColumnId` first
   * and only falls back to name-based matching when it's absent —
   * a name-only diff against a renamed property would archive the
   * old name and add a new one, severing the historical column from
   * its post-rename data (#318).
   *
   * Sources that don't have a stable column identifier (every
   * static-schema source) leave this unset; the diff falls back to
   * name-based add/archive semantics.
   */
  sourceColumnId?: string;
}

/**
 * Declares that each row of an analytics table co-describes one unstructured
 * `document` — the "physical" doc↔row edge of the cross-store graph (#450).
 *
 * When a structured source emits BOTH a document and a row for the same
 * logical entity (Strava activity → `strava_activities` row + an activity
 * doc; a Notion page → a `notion_<db>` row + a row doc), this spec lets the
 * graph walker SYNTHESIZE a `same-entity` edge between them at walk time —
 * no edge rows are ever persisted. The edge is recomputed (and self-heals on
 * row deletion) on every walk; there is no FK, no migration, no lifecycle.
 *
 * The binding is expressed in terms the source controls at emit time: the
 * row's own column values and the document's `externalId` (the gateway
 * resolves `externalId → documentId` internally). The walker inverts it —
 * given a document's `externalId`, it reconstructs the row's primary key and
 * looks the row up by `(tableName, primaryKey)`.
 *
 * Invariant (validated): `externalIdColumns ∪ sourceKeyColumns` must equal the
 * table's `primaryKey` as a set, so the reconstructed key identifies exactly
 * one row (a true 1:1 binding). The 1-doc-to-many-rows case (browser-history
 * per-day digest, screen-time daily) is a separate future declaration, not
 * this one.
 */
export interface BoundDocumentSpec {
  /**
   * Row column(s) whose value(s) reconstruct the bound document's
   * `externalId`. With a single entry the column value IS the externalId
   * (Strava `id`, Notion page `id`); with several, the externalId is their
   * values joined by `externalIdSeparator` in this order (the finance
   * sources' `${account_key}:${transaction_key}`).
   */
  externalIdColumns: string[];
  /**
   * Stripped from `document.externalId` before matching; a document whose
   * externalId lacks it is treated as unbound. Notion's row docs carry a
   * `"row-"` prefix the row's `id` column does not.
   */
  externalIdPrefix?: string;
  /**
   * Join/split character used when `externalIdColumns` has more than one entry.
   * The source MUST construct `externalId` with a separator that never appears
   * inside a component value. Default `":"`.
   */
  externalIdSeparator?: string;
  /**
   * Additional primary-key column(s) filled from the *document's source
   * identity* (the accountId portion of its `<type>:<accountId>` source-id),
   * NOT from its externalId. For tables shared across sibling source instances
   * via `sharedDiscriminatorColumn` — e.g. one `calendar_events` table written
   * by several calendar accounts, discriminated by a `source` column.
   */
  sourceKeyColumns?: string[];
}

/**
 * How to present a single analytics row as a self-contained record (#757).
 *
 * A record citation surfaces one DuckDB row as a point-in-time artifact in a
 * client timeline. The gateway derives the row's human title and key-field
 * list from this spec and ships the *derived strings* to clients — clients
 * never learn the column names or the source identity, so the
 * source-encapsulation rule holds: the nouns, the title shape, and the
 * surfaced columns all live in the provider's descriptor, not in shared
 * gateway/portal/iOS/Android code.
 *
 * Generic by construction: a future source needs no core change to title a
 * row — it picks `titleColumns` (and optionally a `titleTemplate`) plus the
 * `keyColumns` to surface. All values are column names that MUST exist on the
 * same table's `columns`.
 */
export interface RecordDisplaySpec {
  /**
   * Columns whose values compose the row's human title, in order. When
   * `titleTemplate` is absent the gateway joins the non-empty values of these
   * columns (typically a single title column). MUST be non-empty.
   */
  titleColumns: string[];
  /**
   * Optional template over `titleColumns`, with `{column}` placeholders —
   * e.g. `"{merchant} — {amount}"`. Every `{column}` referenced MUST appear
   * in `titleColumns`. When set, the gateway substitutes each placeholder
   * with the row's value (empty for null); when absent, it joins the
   * `titleColumns` values. Generic — carries no source-specific noun.
   */
  titleTemplate?: string;
  /**
   * Columns surfaced as the record's key fields in the client drawer, in
   * order. Sensitive columns are redacted by the gateway before they reach a
   * client. MUST be non-empty; every entry MUST exist on `columns`.
   */
  keyColumns: string[];
}

/**
 * A projection field that is either the same for every row, or read from a
 * column and mapped onto the vocabulary.
 *
 * Provider data rarely lines up with a closed vocabulary one-to-one: a calendar
 * distinguishes a timed booking from an all-day observance, a task list marks
 * some rows cancelled. Rather than let each such field grow its own bespoke
 * shape, every mapped field on a projection spec has this one.
 *
 * `map` misses (and null values) fall back to `default`, which is required —
 * a provider that adds a new enum value must not silently drop the row's fact.
 */
export type MappedProjectionField<T extends string, Ref extends string = string> =
  | T
  | { from: Ref; map: Record<string, T>; default: T };

/**
 * Deterministic temporal fact projected from one record.
 *
 * A record is an analytics row or a document; the two differ only in how a
 * field names where its value comes from. `Ref` captures that difference — a
 * column name on the analytics plane, a typed metadata field on the document
 * plane — so both planes share one declaration shape, one validator, and one
 * derivation. Adding a capability to one plane can no longer quietly leave the
 * other behind.
 *
 * A projection is always an explicit product opt-in, never a consequence of a
 * record simply having a time.
 */
export interface TemporalProjectionSpec<Ref extends string> {
  /** Stable fact slot within one record (for example `visit` or `calendar`). */
  slot: string;
  /**
   * Where the fact begins. `$semanticTime` resolves to the record's own
   * declared event time — the table's `semanticTimeColumn`, or the document's
   * `timestamp`. Pinning an analytics start to that sentinel is what stops a
   * table declaring two competing answers to when the same row begins.
   */
  start: Ref;
  /** Optional exclusive/closed end; the projector normalizes to exclusive. */
  end?: Ref;
  /** Human label carried by the record. Documents fall back to their title. */
  label?: Ref;
  kind: MappedProjectionField<TemporalKind, Ref>;
  modality: MappedProjectionField<TemporalModality, Ref>;
  /** Defaults to `active` when the record asserts no lifecycle state. */
  status?: MappedProjectionField<TemporalStatus, Ref>;
  /** Boolean ref distinguishing all-day/floating dates from instants. */
  allDay?: Ref;
  /**
   * Optional boolean gate. Records whose value is not exactly true own no
   * projection. Calendar sources use this to suppress recurrence masters when
   * the provider cannot safely materialize their occurrences.
   */
  eligibility?: Ref;
  /** Optional IANA/floating-time basis carried by the record. */
  timeZone?: Ref;
  /** Optional source revision clock. */
  sourceUpdatedAt?: Ref;
  /** Stable source correlation keys such as RFC 5545 iCalUID. */
  correlationKeys?: Ref[];
}

/** Analytics refs are column names on the projecting table. */
export interface AnalyticsTemporalProjectionSpec extends TemporalProjectionSpec<string> {
  start: "$semanticTime";
}

/**
 * Typed generic metadata a document projection may read. Deliberately closed:
 * arbitrary prose and `metadata.extra` paths stay off-limits, because a
 * projection is a deterministic fact and must not depend on a free-text field
 * whose shape no schema guarantees.
 */
export const DOCUMENT_PROJECTION_FIELDS = [
  "$semanticTime",
  "scheduledAt",
  "dueAt",
  "endsAt",
  "timeZone",
  "status",
] as const;
export type DocumentProjectionField = (typeof DOCUMENT_PROJECTION_FIELDS)[number];

/**
 * The declaration belongs to the provider descriptor; the gateway receives it
 * with the page and applies it inside the same SQLite write as the document,
 * so retracting a date deletes its projection atomically.
 */
export type DocumentTemporalProjectionSpec = TemporalProjectionSpec<DocumentProjectionField>;

/**
 * A metadata field a source emits that is worth asking questions about.
 *
 * The analytics half of this contract is {@link ColumnDefinition}: a source
 * declares its columns and their categorical vocabularies, and subscription
 * compilation builds an opaque, bounded projection of them for the model. The
 * document half had no equivalent, so a condition like "emails from a
 * particular address, tagged receipts" could be evaluated by the trigger
 * engine but never composed by the compiler — it had no way to learn that a
 * source emits `metadata.tags`, let alone which values are meaningful.
 *
 * Declared paths are relative to the document's `metadata` object, so `tags`
 * addresses `metadata.tags`. The vocabulary fields carry exactly the meaning
 * they do on a column: `allowedValues` closes the domain, `canonicalValues`
 * offers known spellings for an open one, and `valueAliases` maps human
 * phrasing onto exact wire values. They describe the SOURCE CONTRACT and must
 * never be populated from a user's rows.
 */
export interface DocumentMetadataFieldSpec {
  /** Dotted path under `metadata`, e.g. `tags` or `extra.threadId`. */
  path: string;
  /** What the field holds. `string-array` matches if any element matches. */
  type: "string" | "number" | "boolean" | "string-array";
  /** Human-readable description — the model reads this to choose a field. */
  description: string;
  /** Exhaustive source-owned values. Omit for open-ended fields. */
  allowedValues?: string[];
  /** Known values for an open vocabulary; other values remain valid. */
  canonicalValues?: string[];
  /** Human phrases mapping onto exact wire values. */
  valueAliases?: Record<string, string[]>;
  /**
   * Whether the field's values identify people — a display name, an address,
   * a phone number, a handle, or an opaque account identifier derived from
   * one.
   *
   * A filter on such a field singles out a human just as a person role does,
   * whatever grammar spells it. The compiler prompt marks such a field, so a
   * filter on one is written as the identity condition it is rather than as an
   * ordinary attribute. Only the source knows which of its
   * fields carry identity, so only the source can declare it. Set it whenever
   * ANY value the field can take names a person: a field holding a group name
   * for group chats and a contact's name for one-to-one chats still does.
   */
  identifiesPeople?: boolean;
}

/**
 * What a source's documents can be asked about: which kinds of thing it
 * emits, which person relationships it populates, and which metadata fields
 * carry meaning.
 *
 * Subscription compilation projects this — bounded and behind opaque handles,
 * exactly as it does the analytics catalog — so a natural-language condition
 * can compile to a deterministic document predicate without any source name
 * appearing in shared code. A source that declares nothing keeps working; its
 * documents simply cannot be addressed by anything more specific than the
 * generic fields every document has.
 */
export interface DocumentEventProfile {
  /**
   * Document types this source emits, most characteristic first. Values are
   * the source's own `metadata.documentType`; `KNOWN_DOCUMENT_TYPES` covers
   * the common ones but a source may emit its own.
   */
  documentTypes?: string[];
  /**
   * Person roles this source actually populates. Declaring a role the source
   * never emits compiles conditions that can never match, so the list should
   * be what the normalizer really writes — not what the domain could support.
   */
  personRoles?: PersonRole[];
  /** Queryable metadata fields, each with its own vocabulary. */
  metadataFields?: DocumentMetadataFieldSpec[];
}

/**
 * Schema for an analytics table managed by a structured source.
 */
export interface AnalyticsTableSchema {
  /** Table name in DuckDB (snake_case, e.g. "health_metrics") */
  tableName: string;
  /** Human-readable name (e.g. "Health Metrics") */
  displayName: string;
  /** Description of what this table contains */
  description: string;
  /** Column definitions */
  columns: ColumnDefinition[];
  /**
   * The upstream user can add, rename, or remove columns at runtime.
   * Dynamic schemas archive omitted columns; fixed schemas evolve additively so
   * an older client cannot remove columns introduced by a newer release.
   */
  dynamicColumns?: true;
  /** Primary key column(s) — used for upsert ON CONFLICT */
  primaryKey: string[];
  /**
   * The columns a delete or a snapshot addresses a row by. Defaults to
   * {@link primaryKey}.
   *
   * Declared on the table rather than chosen per page, because it is also the
   * key every ledger built on this table records: pending absences, replica
   * deletion claims, the arrival that clears one. A page free to pick its own
   * column can address one table in two key spaces, and the ledgers then hold
   * keys from both with nothing to tell them apart.
   *
   * A key that does not identify a single row addresses a GROUP of them, and
   * every row in the group goes together. That is how a table whose upstream
   * addresses groups is spelled — a source re-reading an activity names the
   * activity, not each of its comments — and declaring it here puts the blast
   * radius where the table is defined instead of at each call site. Every
   * column must exist on the table; nothing more can be checked mechanically,
   * because whether a group is the right unit is a fact about the upstream.
   */
  deleteKey?: string[];
  /**
   * The real-world, semantic-time column for a row in this table — the
   * single instant a record citation is placed at on a timeline (#757).
   * The source DECLARES this; it is never guessed. Set it to the name of a
   * DATE or TIMESTAMPTZ column on this table, or to explicit `null` for a
   * genuinely timeless table (a profile snapshot, a per-entity blob, a
   * positional bucket). A `null` table simply cannot produce a timeline record
   * citation, and that is correct.
   *
   * A zone-less TIMESTAMP is rejected: it has no stable UTC instant, so the
   * host reading it would decide where the row lands in time. In-tree sources
   * fail to define; a schema arriving over the wire from a device instead has
   * just this anchor dropped (see `downgradeAmbiguousAnchor`), because failing
   * the whole ingest over a detail an older client cannot express would cost it
   * every row.
   *
   * This is distinct from the heuristic in the query-runner's
   * `pickTimeColumn` (which still serves the developer-facing preview
   * endpoints): a record citation's semantic time comes ONLY from this
   * declared value, so it is right even when the heuristic would pick a
   * sync/ingest timestamp over the true event time.
   *
   * When set, the named column MUST exist on `columns`.
   */
  semanticTimeColumn: string | null;
  /**
   * How to title a single row and which columns to surface as its key
   * fields when it is cited as a record (#757). See `RecordDisplaySpec`.
   * Required so clients can render a record without any column-name or
   * source knowledge. A timeless table (`semanticTimeColumn: null`) still
   * declares this — a `null`-time row is not timeline-eligible, but the
   * spec keeps the contract uniform and lets non-timeline surfaces (e.g. a
   * trail entry reached from a bound document) render the row.
   */
  record: RecordDisplaySpec;
  /** Example queries to show in CLI help */
  exampleQueries?: string[];
  /**
   * For analytics tables shared across sibling source instances (e.g.
   * `browser_visits` written by browser-history:chrome AND :safari), the
   * name of the column that discriminates instances. On source removal
   * the gateway runs `DELETE FROM <tableName> WHERE <column> = ?` —
   * with the accountId portion of the source-id as the value — instead
   * of `DROP TABLE`, so a sibling source's data stays intact.
   *
   * Leave undefined when the source owns the table outright (case A:
   * `notion_<id>` per-database tables). The gateway
   * `DROP TABLE`s on removal in that case.
   *
   * Convention: the discriminator column carries the accountId portion
   * of `<type>:<accountId>` — for browser-history that's the browser
   * slug ("chrome", "safari"); for future multi-instance sources that
   * keys off the natural account identifier. JSON-serializable so the
   * collector can ship it to the gateway alongside the schema on every
   * structured-sync page.
   */
  sharedDiscriminatorColumn?: string;
  /**
   * One-hop ownership proof for legacy rows missing the discriminator.
   * `column` on this table joins the declared parent's unique `parentColumn`;
   * that parent's discriminator supplies the account, within the same stream.
   * Both tables must belong to the same source type. This is not arbitrary SQL
   * or permission to read another provider's table. Rows without a known parent
   * remain unattributed and must not participate in destructive reconciliation.
   */
  sharedDiscriminatorParent?: {
    table: string;
    column: string;
    parentColumn: string;
  };
  /**
   * Declares the 1:1 doc↔row physical edge for this table (#450). When set,
   * the gateway records the binding in the analytics catalog and the graph
   * walker synthesizes a `same-entity` edge from each row's co-described
   * document at walk time — no edge rows persisted. See `BoundDocumentSpec`.
   * JSON-serializable; rides the per-page schema channel to the gateway like
   * the rest of this schema.
   */
  boundDocument?: BoundDocumentSpec;
  /**
   * Explicit opt-in to the concise shared temporal substrate. A semantic time
   * alone never opts a table in: high-volume/specialist tables keep their
   * citation anchor without producing a projection.
   */
  temporalProjection?: AnalyticsTemporalProjectionSpec;
}

/**
 * Whether omission may mean an upstream user deleted a column.
 *
 * `dynamicColumns: true` is authoritative. Stable upstream column ids preserve
 * compatibility with older dynamic-schema clients; `omnesis:` ids are reserved
 * for fixed source-owned columns and do not opt a schema into deletion.
 */
export function analyticsSchemaUsesDynamicColumns(
  schema: Pick<AnalyticsTableSchema, "columns" | "dynamicColumns">,
  previous?: Pick<AnalyticsTableSchema, "columns" | "dynamicColumns"> | null,
): boolean {
  if (schema.dynamicColumns === true || previous?.dynamicColumns === true) return true;
  return [...schema.columns, ...(previous?.columns ?? [])].some(
    (column) =>
      column.sourceColumnId !== undefined && !column.sourceColumnId.startsWith("omnesis:"),
  );
}

function analyticsSchemaLabel(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "<unknown>";
  const tableName = (schema as { tableName?: unknown }).tableName;
  return typeof tableName === "string" && tableName.length > 0 ? tableName : "<unknown>";
}

/**
 * Validate and normalize the column types on one runtime-supplied analytics
 * schema. The returned schema preserves all caller-supplied metadata and only
 * rewrites `columns[*].type` to a safe canonical spelling.
 */
export function normalizeAnalyticsSchemaColumnTypes(
  schema: unknown,
  contextLabel: string,
): AnalyticsTableSchema {
  if (!schema || typeof schema !== "object") {
    throw new Error(`${contextLabel}: analytics schema must be an object.`);
  }
  const candidate = schema as AnalyticsTableSchema;
  const where = `${contextLabel}: analytics schema '${analyticsSchemaLabel(schema)}'`;
  if (!Array.isArray(candidate.columns)) {
    throw new Error(`${where} must declare a columns array.`);
  }
  if (candidate.dynamicColumns !== undefined && candidate.dynamicColumns !== true) {
    throw new Error(`${where} dynamicColumns must be true when present.`);
  }
  const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  if (
    candidate.sharedDiscriminatorColumn !== undefined &&
    !identifier(candidate.sharedDiscriminatorColumn)
  )
    throw new Error(`${where} sharedDiscriminatorColumn must be a SQL identifier.`);
  const relation = candidate.sharedDiscriminatorParent;
  if (relation !== undefined) {
    if (
      !relation ||
      typeof relation !== "object" ||
      Array.isArray(relation) ||
      !identifier(relation.table) ||
      !identifier(relation.column) ||
      !identifier(relation.parentColumn) ||
      Object.keys(relation).some((key) => !["table", "column", "parentColumn"].includes(key))
    )
      throw new Error(
        `${where} sharedDiscriminatorParent must declare table, column, and parentColumn identifiers.`,
      );
    if (
      !candidate.sharedDiscriminatorColumn ||
      relation.table === candidate.tableName ||
      !candidate.columns.some((column) => column?.name === relation.column)
    )
      throw new Error(
        `${where} ownership relation requires its owner and join columns and a different parent table.`,
      );
  }

  const columns = candidate.columns.map((col, index) => {
    if (!col || typeof col !== "object") {
      throw new Error(`${where} column #${index + 1} must be an object.`);
    }
    const name = typeof col.name === "string" && col.name.length > 0 ? col.name : `#${index + 1}`;
    const type = normalizeAnalyticsColumnType(col.type, `${where} column '${name}'`);
    if (col.allowedValues !== undefined && col.canonicalValues !== undefined) {
      throw new Error(
        `${where} column '${name}': allowedValues and canonicalValues are mutually exclusive.`,
      );
    }
    validateColumnVocabulary(col.allowedValues, type, `${where} column '${name}' allowedValues`);
    validateColumnVocabulary(
      col.canonicalValues,
      type,
      `${where} column '${name}' canonicalValues`,
    );
    const vocabulary = [...(col.allowedValues ?? []), ...(col.canonicalValues ?? [])];
    validateColumnValueAliases(
      col.valueAliases,
      type,
      vocabulary,
      `${where} column '${name}' valueAliases`,
    );
    validateCategoricalPhraseSpace(
      vocabulary,
      col.valueAliases,
      `${where} column '${name}' categorical vocabulary`,
    );
    if (col.categoricalRole !== undefined) {
      if (
        (col.categoricalRole !== "series" && col.categoricalRole !== "selector") ||
        type !== "VARCHAR"
      ) {
        throw new Error(
          `${where} column '${name}': categoricalRole must be 'series' or 'selector' on a VARCHAR column.`,
        );
      }
      if (vocabulary.length === 0) {
        throw new Error(
          `${where} column '${name}': categoricalRole requires allowedValues or canonicalValues.`,
        );
      }
    }
    return {
      ...col,
      type,
    };
  });
  if (columns.filter(({ categoricalRole }) => categoricalRole === "series").length > 1) {
    throw new Error(`${where} may declare at most one categorical series column.`);
  }
  if (
    candidate.sharedDiscriminatorColumn !== undefined &&
    !columns.some((column) => column.name === candidate.sharedDiscriminatorColumn)
  )
    throw new Error(`${where} must declare its sharedDiscriminatorColumn in columns.`);

  return {
    ...candidate,
    columns,
  };
}

function validateColumnValueAliases(
  rawAliases: unknown,
  type: ColumnType,
  vocabulary: readonly string[],
  contextLabel: string,
): void {
  if (rawAliases === undefined) return;
  if (
    type !== "VARCHAR" ||
    !rawAliases ||
    typeof rawAliases !== "object" ||
    Array.isArray(rawAliases)
  ) {
    throw new Error(`${contextLabel} must be an object on a VARCHAR column.`);
  }
  const entries = Object.entries(rawAliases);
  if (entries.length === 0 || entries.length > 128) {
    throw new Error(`${contextLabel} must contain between 1 and 128 entries.`);
  }
  const allowedKeys = new Set(vocabulary);
  for (const [value, aliases] of entries) {
    if (!allowedKeys.has(value)) {
      throw new Error(`${contextLabel} key '${value}' is not in the source-owned vocabulary.`);
    }
    if (!Array.isArray(aliases) || aliases.length === 0 || aliases.length > 8) {
      throw new Error(`${contextLabel}.${value} must contain between 1 and 8 aliases.`);
    }
    const seen = new Set<string>();
    for (const alias of aliases) {
      if (
        typeof alias !== "string" ||
        alias.length === 0 ||
        alias.length > 120 ||
        alias.trim() !== alias
      ) {
        throw new Error(`${contextLabel}.${value} aliases must be 1 to 120 characters.`);
      }
      if (seen.has(alias)) {
        throw new Error(`${contextLabel}.${value} aliases must be unique.`);
      }
      seen.add(alias);
    }
  }
}

function validateCategoricalPhraseSpace(
  vocabulary: readonly string[],
  rawAliases: unknown,
  contextLabel: string,
): void {
  const owners = new Map<string, string>();
  const aliases =
    rawAliases && typeof rawAliases === "object" && !Array.isArray(rawAliases)
      ? (rawAliases as Record<string, readonly string[]>)
      : {};
  for (const value of vocabulary) {
    for (const phrase of [value, ...(aliases[value] ?? [])]) {
      const normalized = normalizeCategoricalPhrase(phrase);
      const owner = owners.get(normalized);
      if (owner !== undefined && owner !== value) {
        throw new Error(
          `${contextLabel}: '${phrase}' is ambiguous between '${owner}' and '${value}' after normalization.`,
        );
      }
      owners.set(normalized, value);
    }
  }
}

function normalizeCategoricalPhrase(value: string): string {
  return value
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function validateColumnVocabulary(
  rawValues: unknown,
  type: ColumnType,
  contextLabel: string,
): void {
  if (rawValues === undefined) return;
  if (type !== "VARCHAR") {
    throw new Error(`${contextLabel} is only valid for VARCHAR columns.`);
  }
  if (!Array.isArray(rawValues) || rawValues.length === 0 || rawValues.length > 128) {
    throw new Error(`${contextLabel} must contain between 1 and 128 values.`);
  }
  const seen = new Set<string>();
  for (const value of rawValues) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 120 ||
      value.trim() !== value
    ) {
      throw new Error(
        `${contextLabel}: every entry must be a string between 1 and 120 characters.`,
      );
    }
    if (seen.has(value)) {
      throw new Error(`${contextLabel} entries must be unique.`);
    }
    seen.add(value);
  }
}

/**
 * Throw if any schema contains a column type outside the closed runtime
 * allowlist. This is intentionally separate from normalization so descriptor
 * validation can fail fast without changing the object a provider supplied.
 */
export function validateAnalyticsSchemaColumnTypes(
  schemas: readonly unknown[],
  contextLabel: string,
): void {
  for (const schema of schemas) {
    normalizeAnalyticsSchemaColumnTypes(schema, contextLabel);
  }
}

/**
 * The column the gateway appends to an analytics table whose rows come from
 * several devices of one source. It names the device stream a row belongs to
 * (the empty string for a source with one stream) and joins the declared
 * primary key, so two devices' rows with the same declared key coexist.
 * Reserved: a schema may not declare it.
 */
export const ANALYTICS_STREAM_COLUMN = "_stream_id";

/**
 * Throw if any schema in `schemas` declares the reserved stream column. The
 * gateway adds that column to a table's columns and primary key the first
 * time a device stream writes to the table; a declared column of the same
 * name would make the catalog claim a key the table does not have.
 */
export function validateAnalyticsSchemasReserveStreamColumn(
  schemas: readonly AnalyticsTableSchema[],
  contextLabel: string,
): void {
  for (const schema of schemas) {
    if (schema.columns.some((column) => column.name === ANALYTICS_STREAM_COLUMN)) {
      throw new Error(
        `${contextLabel}: analytics schema '${schema.tableName}' declares column '${ANALYTICS_STREAM_COLUMN}', which is reserved for the gateway's device-stream key.`,
      );
    }
  }
}

/**
 * Throw if any schema in `schemas` names a table with a leading
 * underscore. The gateway reserves that namespace for its own
 * bookkeeping tables (`_analytics_catalog`, `_temporal_projections`, …)
 * and the stream key. A source table there would be refused as an
 * unknown name by the source-scoped `run_sql` gate — and worse, could
 * fold-collide with a bookkeeping table that gate must always deny.
 */
export function validateAnalyticsSchemasReserveLeadingUnderscore(
  schemas: readonly AnalyticsTableSchema[],
  contextLabel: string,
): void {
  for (const schema of schemas) {
    if (schema.tableName.startsWith("_")) {
      throw new Error(
        `${contextLabel}: analytics schema '${schema.tableName}' uses the reserved leading-underscore namespace for gateway bookkeeping tables.`,
      );
    }
  }
}

/**
 * Throw if any schema in `schemas` lacks a non-empty `primaryKey`.
 *
 * Per-page ingest writes follow `upsertDocuments` →
 * `setSyncState`. If the cursor write fails after the upsert succeeded,
 * the source flips to `error` and the next cycle re-fetches and
 * re-upserts the same page. Document upserts absorb the retry via the
 * `(provider_id, source_id, external_id)` UNIQUE constraint;
 * analytics-row upserts only absorb the retry when the schema declared
 * a primary key (the gateway's `INSERT ... ON CONFLICT (...) DO UPDATE`
 * path requires one). Without a primary key, the cursor-retry races
 * accumulate duplicate rows forever.
 *
 * The validator runs at source-definition time (statically declared
 * schemas) and again at the gateway's `ensureTable` boundary (so
 * dynamically-emitted schemas like Notion's per-database tables don't
 * sneak through). `contextLabel` is interpolated into the error so
 * the caller knows where the bad schema came from.
 */
export function validateAnalyticsSchemasHavePrimaryKey(
  schemas: readonly AnalyticsTableSchema[],
  contextLabel: string,
): void {
  for (const schema of schemas) {
    if (!schema.primaryKey || schema.primaryKey.length === 0) {
      throw new Error(
        `${contextLabel}: analytics schema '${schema.tableName}' must declare a non-empty primaryKey — ingest is at-least-once, so duplicate rows accumulate on cursor-retry without one.`,
      );
    }
  }
}

/**
 * The columns a delete or a snapshot addresses this table by.
 *
 * One function so the page contract, the gateway's apply path and every ledger
 * built on them read the same answer. A table that declares nothing is
 * addressed by its primary key, which is the only key that certainly names one
 * row.
 */
export function analyticsDeleteKey(schema: {
  primaryKey: string[];
  deleteKey?: string[];
}): string[] {
  return schema.deleteKey && schema.deleteKey.length > 0 ? schema.deleteKey : schema.primaryKey;
}

/**
 * Validate account ownership declarations against one source's complete schema set.
 * The gateway separately verifies catalog ownership and stream isolation.
 */
export function validateAnalyticsOwnership(
  schemas: readonly AnalyticsTableSchema[],
  contextLabel: string,
): void {
  for (const schema of schemas) {
    const where = `${contextLabel}: analytics schema '${schema.tableName}'`;
    const owner = schema.columns.find((c) => c.name === schema.sharedDiscriminatorColumn);
    if (schema.sharedDiscriminatorColumn !== undefined && !owner) {
      throw new Error(`${where} declares a missing sharedDiscriminatorColumn`);
    }
    const relation = schema.sharedDiscriminatorParent;
    if (!relation) continue;
    const parent = schemas.find((s) => s.tableName === relation.table);
    const childKey = schema.columns.find((c) => c.name === relation.column);
    const parentKey = parent?.columns.find((c) => c.name === relation.parentColumn);
    const parentOwner = parent?.columns.find((c) => c.name === parent.sharedDiscriminatorColumn);
    if (
      !owner ||
      !parentOwner ||
      !childKey ||
      !parentKey ||
      parent === schema ||
      parent?.sharedDiscriminatorParent !== undefined ||
      parent?.primaryKey.length !== 1 ||
      parent.primaryKey[0] !== relation.parentColumn ||
      childKey.type !== parentKey.type ||
      owner.type !== parentOwner.type
    ) {
      throw new Error(
        `${where} requires a one-hop sharedDiscriminatorParent in the same source, with matching column types and a unique parent key`,
      );
    }
  }
}

/**
 * Throw if a schema's `deleteKey` is empty or names a column the table lacks.
 *
 * A key coarser than the primary key is legitimate — it addresses a group —
 * so the only mechanical check is that its columns exist. Runs beside the
 * primary-key check, at source-definition time and again at the gateway's
 * `ensureTable` boundary, so a schema arriving over the wire is held to it too.
 */
export function validateAnalyticsDeleteKeys(
  schemas: readonly AnalyticsTableSchema[],
  contextLabel: string,
): void {
  for (const schema of schemas) {
    const declared = schema.deleteKey;
    if (declared === undefined) continue;
    const where = `${contextLabel}: analytics schema '${schema.tableName}'`;
    if (declared.length === 0) {
      throw new Error(
        `${where} declares an empty deleteKey — omit it to address rows by the primary key.`,
      );
    }
    for (const column of declared) {
      if (!schema.columns.some((c) => c.name === column)) {
        throw new Error(
          `${where} declares deleteKey column '${column}', which the table does not have.`,
        );
      }
    }
  }
}

/**
 * Validate every `boundDocument` declaration against its table schema (#450).
 *
 * Enforces the 1:1 invariant that makes walk-time edge synthesis correct:
 * `externalIdColumns ∪ sourceKeyColumns` must equal `primaryKey` as a set, so
 * the key the walker reconstructs from a document's `externalId` (plus its
 * source identity) addresses exactly one row. Also checks that every named
 * column exists and that a multi-column `externalIdColumns` carries a
 * separator. Runs at source-definition time and again at the gateway's
 * `ensureTable` boundary (dynamic Notion schemas only reach the gateway).
 */
export function validateBoundDocuments(
  schemas: readonly AnalyticsTableSchema[],
  contextLabel: string,
): void {
  for (const schema of schemas) {
    const bound = schema.boundDocument;
    if (!bound) continue;
    const where = `${contextLabel}: analytics schema '${schema.tableName}' boundDocument`;
    const columnNames = new Set(schema.columns.map((c) => c.name));

    if (!bound.externalIdColumns || bound.externalIdColumns.length === 0) {
      throw new Error(`${where} must declare a non-empty externalIdColumns.`);
    }
    if (bound.externalIdColumns.length > 1 && bound.externalIdSeparator === "") {
      throw new Error(
        `${where} joins ${bound.externalIdColumns.length} columns into externalId but externalIdSeparator is empty — the split would be ambiguous.`,
      );
    }

    const keyColumns = [...bound.externalIdColumns, ...(bound.sourceKeyColumns ?? [])];
    for (const col of keyColumns) {
      if (!columnNames.has(col)) {
        throw new Error(`${where} references column '${col}' which is not declared on the table.`);
      }
    }

    // The reconstructed key must BE the primary key (as a set) — otherwise it
    // matches zero or many rows and the synthesized same-entity edge isn't 1:1.
    const keySet = new Set(keyColumns);
    const pkSet = new Set(schema.primaryKey);
    const sameSize = keySet.size === pkSet.size && keyColumns.length === keySet.size;
    const sameMembers = [...pkSet].every((c) => keySet.has(c));
    if (!sameSize || !sameMembers) {
      throw new Error(
        `${where} must reconstruct the full primaryKey: externalIdColumns ∪ sourceKeyColumns = {${keyColumns.join(", ")}} must equal primaryKey = {${schema.primaryKey.join(", ")}} (as a set, no duplicates) for a 1:1 binding.`,
      );
    }
  }
}

/** The closed person-role vocabulary, for validating declared roles. */
const PERSON_ROLE_SET: ReadonlySet<string> = new Set(PERSON_ROLES);

/**
 * A timezone-less TIMESTAMP cannot be converted to a stable UTC instant without
 * interpreting its wall clock in an IANA zone. Rejecting it is what keeps the
 * gateway's host timezone from silently moving a stored fact — the same reason
 * `semanticTimeColumn` accepts only these two types.
 */
export const TEMPORAL_COLUMN_TYPES = new Set<ColumnType>(["DATE", "TIMESTAMPTZ"]);

/** The slot name shared by both planes: lower-snake, bounded length. */
const PROJECTION_SLOT = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Per-plane knowledge of what a `Ref` may name and what shape it carries.
 * Everything else about validating a projection is plane-independent, which is
 * what lets both planes share `validateProjectionSpec` below.
 */
interface ProjectionRefChecker {
  /** Reject a ref this plane does not know. */
  require(ref: string, purpose: string): void;
  /** Reject a ref that cannot yield an unambiguous instant or calendar day. */
  requireTemporal(ref: string, purpose: string): void;
  /** Reject a ref that does not carry a boolean. */
  requireBoolean(ref: string, purpose: string): void;
}

function validateMappedField<T extends string>(
  field: MappedProjectionField<T, string> | undefined,
  allowed: readonly T[],
  where: string,
  label: string,
  refs: ProjectionRefChecker,
): void {
  if (field === undefined) return;
  if (typeof field === "string") {
    if (!(allowed as readonly string[]).includes(field)) {
      throw new Error(`${where} has unsupported ${label} '${field}'.`);
    }
    return;
  }
  refs.require(field.from, `${label}.from`);
  if (!(allowed as readonly string[]).includes(field.default)) {
    throw new Error(`${where} has unsupported ${label} default '${String(field.default)}'.`);
  }
  const entries = Object.entries(field.map);
  if (entries.length === 0) {
    throw new Error(`${where} ${label} map must not be empty; declare a constant instead.`);
  }
  for (const [raw, mapped] of entries) {
    if (raw.length === 0 || !(allowed as readonly string[]).includes(mapped)) {
      throw new Error(`${where} has invalid ${label} map entry '${raw}' → '${String(mapped)}'.`);
    }
  }
}

/**
 * The plane-independent half of a projection contract. Both public validators
 * below delegate here, so a rule added for analytics rows cannot silently skip
 * documents.
 */
function validateProjectionSpec(
  spec: TemporalProjectionSpec<string>,
  where: string,
  refs: ProjectionRefChecker,
): void {
  if (!PROJECTION_SLOT.test(spec.slot)) {
    throw new Error(`${where} slot must match ${PROJECTION_SLOT}.`);
  }
  refs.requireTemporal(spec.start, "start");
  if (spec.end) refs.requireTemporal(spec.end, "end");
  if (spec.label) refs.require(spec.label, "label");
  validateMappedField(spec.kind, TEMPORAL_KINDS, where, "kind", refs);
  validateMappedField(spec.modality, TEMPORAL_MODALITIES, where, "modality", refs);
  validateMappedField(spec.status, TEMPORAL_STATUSES, where, "status", refs);
  if (spec.allDay) refs.requireBoolean(spec.allDay, "allDay");
  if (spec.eligibility) refs.requireBoolean(spec.eligibility, "eligibility");
  if (spec.timeZone) refs.require(spec.timeZone, "timeZone");
  if (spec.sourceUpdatedAt) refs.requireTemporal(spec.sourceUpdatedAt, "sourceUpdatedAt");
  for (const ref of spec.correlationKeys ?? []) refs.require(ref, "correlationKeys");
}

/**
 * Validate analytics-row projection declarations at source-definition time
 * and again at the gateway boundary for native/dynamic schemas.
 */
export function validateTemporalProjectionContracts(
  schemas: readonly AnalyticsTableSchema[],
  contextLabel: string,
): void {
  for (const schema of schemas) {
    const spec = schema.temporalProjection;
    if (!spec) continue;
    const where = `${contextLabel}: analytics schema '${schema.tableName}' temporalProjection`;
    const columns = new Map(schema.columns.map((column) => [column.name, column]));

    if (spec.start !== "$semanticTime") {
      throw new Error(`${where} start must be '$semanticTime'.`);
    }
    if (schema.semanticTimeColumn === null || schema.semanticTimeColumn === undefined) {
      throw new Error(`${where} requires a non-null semanticTimeColumn.`);
    }

    // `$semanticTime` is the one ref that does not name a column directly; it
    // stands for whichever column the table declared as its semantic time.
    const resolve = (ref: string): string =>
      ref === "$semanticTime" ? schema.semanticTimeColumn! : ref;
    const requireColumn = (ref: string, purpose: string): ColumnDefinition => {
      const name = resolve(ref);
      const column = columns.get(name);
      if (!column) throw new Error(`${where} ${purpose} references unknown column '${name}'.`);
      return column;
    };

    validateProjectionSpec(spec, where, {
      require: (ref, purpose) => void requireColumn(ref, purpose),
      requireTemporal: (ref, purpose) => {
        const column = requireColumn(ref, purpose);
        if (!TEMPORAL_COLUMN_TYPES.has(column.type)) {
          throw new Error(
            `${where} ${purpose} column '${column.name}' must be DATE or TIMESTAMPTZ; ` +
              "timezone-less TIMESTAMP projection columns are not supported.",
          );
        }
      },
      requireBoolean: (ref, purpose) => {
        const column = requireColumn(ref, purpose);
        if (column.type !== "BOOLEAN") {
          throw new Error(`${where} ${purpose} column '${column.name}' must be BOOLEAN.`);
        }
      },
    });
  }
}

/** Fields that can yield an instant or a calendar day on the document plane. */
const DOCUMENT_TEMPORAL_FIELDS = new Set<DocumentProjectionField>([
  "$semanticTime",
  "scheduledAt",
  "dueAt",
  "endsAt",
]);

/** Validate a provider's document-backed temporal projection declarations. */
export function validateDocumentTemporalProjectionContracts(
  specs: readonly DocumentTemporalProjectionSpec[] | undefined,
  contextLabel: string,
): void {
  if (!specs) return;
  const seen = new Set<string>();
  for (const spec of specs) {
    const where = `${contextLabel}: documentTemporalProjections`;
    if (seen.has(spec.slot)) throw new Error(`${where} contains duplicate slot '${spec.slot}'.`);
    seen.add(spec.slot);

    const requireField = (ref: string, purpose: string): void => {
      if (!(DOCUMENT_PROJECTION_FIELDS as readonly string[]).includes(ref)) {
        throw new Error(
          `${where} ${purpose} references '${ref}', which is not a projectable document field ` +
            `(one of ${DOCUMENT_PROJECTION_FIELDS.join(", ")}).`,
        );
      }
    };

    validateProjectionSpec(spec, where, {
      require: requireField,
      requireTemporal: (ref, purpose) => {
        requireField(ref, purpose);
        if (!DOCUMENT_TEMPORAL_FIELDS.has(ref as DocumentProjectionField)) {
          throw new Error(`${where} ${purpose} field '${ref}' does not carry a date.`);
        }
      },
      // Documents carry no typed boolean a projection may read: all-day is
      // inferred from whether the date value is a calendar day or an instant,
      // and there is no document-level eligibility gate.
      requireBoolean: (ref, purpose) => {
        throw new Error(`${where} ${purpose} is not supported on documents (got '${ref}').`);
      },
    });
  }
}

/**
 * Field spellings an installed client may still send for a projection spec.
 *
 * A phone ships its own copy of this contract and upgrades on its own
 * schedule, so the gateway cannot assume a device speaks the current field
 * names. These aliases are permanent for the same reason `RETIRED_TEMPORAL_KINDS`
 * is: rejecting a page over a renamed key would cost an already-installed build
 * every row it syncs, which is a far worse outcome than carrying a mapping.
 */
const LEGACY_PROJECTION_FIELDS: Readonly<Record<string, string>> = {
  startColumn: "start",
  endColumn: "end",
  labelColumn: "label",
  allDayColumn: "allDay",
  eligibilityColumn: "eligibility",
  timeZoneColumn: "timeZone",
  sourceUpdatedAtColumn: "sourceUpdatedAt",
  correlationKeyColumns: "correlationKeys",
};

/**
 * Rewrite a projection spec that uses the legacy field spellings onto the
 * current shape. A spec already using the current names passes through
 * untouched, so this is safe to run on every inbound schema.
 */
export function normalizeProjectionSpecFields(spec: unknown): unknown {
  if (!spec || typeof spec !== "object") return spec;
  const source = spec as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === "statusColumn" || key === "statusMap" || key === "defaultStatus") continue;
    result[LEGACY_PROJECTION_FIELDS[key] ?? key] = value;
  }

  // The old status triple is exactly the mapped-field shape. `default` is
  // required now, and `active` is what an absent `defaultStatus` always meant.
  if (typeof source.statusColumn === "string" && result.status === undefined) {
    result.status = {
      from: source.statusColumn,
      map: (source.statusMap as Record<string, string> | undefined) ?? {},
      default: (source.defaultStatus as string | undefined) ?? "active",
    };
  }

  // A client may still name a kind by a spelling that has since been retired.
  const kind = canonicalTemporalKind(result.kind);
  if (kind) result.kind = kind;

  return result;
}

/**
 * Strip an anchor whose column cannot yield an unambiguous instant.
 *
 * In-tree sources are held to the anchor type rule outright — a provider that
 * declares a timezone-less `TIMESTAMP` anchor is a bug to fix at the source.
 * A schema arriving over the wire from a device is different: rejecting it
 * would fail the whole ingest over a metadata detail the client may be too old
 * to express. Dropping just the anchor says precisely what is true — the table
 * cannot place a record on a timeline — while its rows still land, stay
 * queryable, and remain citable from a bound document.
 *
 * Returns the schema unchanged when the anchor is absent or already sound.
 */
/**
 * Bring a runtime-supplied schema's projection spec onto the current field
 * names. Applied at the wire boundary, where the sender's version is unknown.
 */
export function normalizeSchemaProjectionFields(
  schema: AnalyticsTableSchema,
): AnalyticsTableSchema {
  if (!schema.temporalProjection) return schema;
  return {
    ...schema,
    temporalProjection: normalizeProjectionSpecFields(
      schema.temporalProjection,
    ) as AnalyticsTableSchema["temporalProjection"],
  };
}

export function downgradeAmbiguousAnchor(
  schema: AnalyticsTableSchema,
  onDowngrade?: (message: string) => void,
): AnalyticsTableSchema {
  const anchor = schema.semanticTimeColumn;
  if (anchor == null) return schema;
  const column = schema.columns.find((c) => c.name === anchor);
  if (!column || TEMPORAL_COLUMN_TYPES.has(column.type)) return schema;
  onDowngrade?.(
    `analytics schema '${schema.tableName}': semanticTimeColumn '${anchor}' is ${column.type}, ` +
      "which has no stable UTC instant; the table is treated as timeless and its rows " +
      "will not appear on a timeline",
  );
  return { ...schema, semanticTimeColumn: null, temporalProjection: undefined };
}

/** Caps keeping one source's projected document vocabulary bounded. */
const DOCUMENT_PROFILE_MAX_TYPES = 24;
const DOCUMENT_PROFILE_MAX_FIELDS = 24;
const DOCUMENT_PROFILE_MAX_VALUES = 64;
/**
 * Longest declared path. Subscription compilation both shows a path to the
 * model and parses it back inside a compiled plan under this same bound, so a
 * longer declaration would compile a plan that no longer validates.
 */
const DOCUMENT_PROFILE_MAX_PATH_LENGTH = 120;

/** Alias caps, matching a categorical column's. Both reach a compiler prompt. */
const DOCUMENT_PROFILE_MAX_ALIASES_PER_VALUE = 8;
const DOCUMENT_PROFILE_MAX_ALIAS_LENGTH = 120;

/** Dotted path under `metadata`: `tags`, `extra.threadId`. */
const METADATA_PATH = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)*$/;

const DOCUMENT_FIELD_TYPES = new Set(["string", "number", "boolean", "string-array"]);

/**
 * Validate a provider's document-event profile.
 *
 * The declaration reaches the subscription compiler's prompt, so it is
 * checked at the source boundary rather than trusted downstream: an alias
 * pointing at a value the source does not list would let a natural-language
 * phrase compile into a predicate that can never match, and the operator
 * would approve prose describing a watch that is silently dead.
 */
export function validateDocumentEventProfile(
  profile: DocumentEventProfile | undefined,
  contextLabel: string,
): void {
  if (!profile) return;
  const where = `${contextLabel}: documentEventProfile`;

  const types = profile.documentTypes ?? [];
  if (types.length > DOCUMENT_PROFILE_MAX_TYPES) {
    throw new Error(`${where} declares more than ${DOCUMENT_PROFILE_MAX_TYPES} document types.`);
  }
  const seenTypes = new Set<string>();
  for (const t of types) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(t)) {
      throw new Error(`${where} documentType '${t}' must match /^[a-z][a-z0-9-]{0,63}$/.`);
    }
    if (seenTypes.has(t)) throw new Error(`${where} lists documentType '${t}' twice.`);
    seenTypes.add(t);
  }

  const seenRoles = new Set<string>();
  for (const role of profile.personRoles ?? []) {
    if (!PERSON_ROLE_SET.has(role)) {
      throw new Error(`${where} has unsupported personRole '${String(role)}'.`);
    }
    if (seenRoles.has(role)) throw new Error(`${where} lists personRole '${role}' twice.`);
    seenRoles.add(role);
  }

  const fields = profile.metadataFields ?? [];
  if (fields.length > DOCUMENT_PROFILE_MAX_FIELDS) {
    throw new Error(`${where} declares more than ${DOCUMENT_PROFILE_MAX_FIELDS} metadata fields.`);
  }
  const seenPaths = new Set<string>();
  for (const field of fields) {
    const at = `${where} field '${field.path}'`;
    if (!METADATA_PATH.test(field.path)) {
      throw new Error(`${at} must be a dotted path under metadata.`);
    }
    if (field.path.length > DOCUMENT_PROFILE_MAX_PATH_LENGTH) {
      throw new Error(`${at} is longer than ${DOCUMENT_PROFILE_MAX_PATH_LENGTH} characters.`);
    }
    if (seenPaths.has(field.path)) throw new Error(`${where} declares '${field.path}' twice.`);
    seenPaths.add(field.path);
    if (!DOCUMENT_FIELD_TYPES.has(field.type)) {
      throw new Error(`${at} has unsupported type '${String(field.type)}'.`);
    }
    if (field.description.trim().length === 0) {
      throw new Error(`${at} needs a description — the model reads it to choose the field.`);
    }
    if (field.allowedValues && field.canonicalValues) {
      throw new Error(`${at} sets both allowedValues and canonicalValues; pick one.`);
    }
    const values = field.allowedValues ?? field.canonicalValues ?? [];
    if (values.length > DOCUMENT_PROFILE_MAX_VALUES) {
      throw new Error(`${at} declares more than ${DOCUMENT_PROFILE_MAX_VALUES} values.`);
    }
    if (
      (field.allowedValues && field.allowedValues.length === 0) ||
      new Set(values).size !== values.length
    ) {
      throw new Error(`${at} has an empty or duplicated value list.`);
    }
    const known = new Set(values);
    for (const [value, aliases] of Object.entries(field.valueAliases ?? {})) {
      if (!known.has(value)) {
        throw new Error(`${at} aliases '${value}', which it does not declare as a value.`);
      }
      if (aliases.length === 0 || aliases.some((a) => a.trim().length === 0)) {
        throw new Error(`${at} has an empty alias for '${value}'.`);
      }
      // The same caps a categorical column's aliases carry. These reach a
      // compiler prompt, so an unbounded list is an unbounded prefix.
      if (aliases.length > DOCUMENT_PROFILE_MAX_ALIASES_PER_VALUE) {
        throw new Error(
          `${at} declares more than ${DOCUMENT_PROFILE_MAX_ALIASES_PER_VALUE} aliases for '${value}'.`,
        );
      }
      if (aliases.some((a) => a.length > DOCUMENT_PROFILE_MAX_ALIAS_LENGTH)) {
        throw new Error(
          `${at} has an alias for '${value}' longer than ${DOCUMENT_PROFILE_MAX_ALIAS_LENGTH} characters.`,
        );
      }
      if (new Set(aliases).size !== aliases.length) {
        throw new Error(`${at} repeats an alias for '${value}'.`);
      }
    }
    // A phrase two values both claim resolves to whichever the reader reaches
    // first, which is a coin toss dressed as a mapping.
    if (field.valueAliases) validateCategoricalPhraseSpace(values, field.valueAliases, at);
  }
}

/** Match `{column}` placeholders in a `RecordDisplaySpec.titleTemplate`. */
const RECORD_TEMPLATE_PLACEHOLDER = /\{([^}]+)\}/g;

/** Column names referenced by a record `titleTemplate`'s `{column}` tokens. */
function recordTemplatePlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(RECORD_TEMPLATE_PLACEHOLDER)) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Validate the record-citation contract (#757): every table must declare a
 * `semanticTimeColumn` (a real DATE/TIMESTAMP column or explicit `null`) and a
 * `record` display spec whose columns all exist on the table.
 *
 * A `null` semantic time is a first-class, accepted value (a genuinely
 * timeless table); the validator only rejects a semantic-time column that
 * names a column the table doesn't have, or a record spec with empty/unknown
 * columns. Runs at source-definition time and again at the gateway's
 * `ensureTable` boundary (so dynamic Notion schemas are checked too).
 *
 * `requireRecord` (default `true`) governs how a schema that omits the contract
 * fields is treated. In-tree sources are validated at definition time with the
 * default, so they must declare the contract in full. The gateway `ensureTable`
 * boundary passes `false`: a device client built before #757 omits these fields
 * entirely, and the gateway must keep ingesting its rows — a missing `record`
 * just makes the table non-citation-eligible, and a missing `semanticTimeColumn`
 * is treated as the timeless `null`. A field that IS present is still shape-
 * checked in both modes, so a malformed declaration never slips through.
 */
export function validateRecordCitationContract(
  schemas: readonly AnalyticsTableSchema[],
  contextLabel: string,
  opts: { requireRecord?: boolean } = {},
): void {
  const requireRecord = opts.requireRecord ?? true;
  for (const schema of schemas) {
    const where = `${contextLabel}: analytics schema '${schema.tableName}'`;
    const columnNames = new Set(schema.columns.map((c) => c.name));

    // semanticTimeColumn: explicit null (or an omitted field, from a pre-#757
    // client) means timeless; a string must name a column.
    if (schema.semanticTimeColumn != null) {
      if (typeof schema.semanticTimeColumn !== "string" || schema.semanticTimeColumn.length === 0) {
        throw new Error(
          `${where} must declare semanticTimeColumn as a column name or explicit null (got ${JSON.stringify(schema.semanticTimeColumn)}).`,
        );
      }
      if (!columnNames.has(schema.semanticTimeColumn)) {
        throw new Error(
          `${where} semanticTimeColumn '${schema.semanticTimeColumn}' is not a declared column.`,
        );
      }
      // The anchor answers the same question a projection's start does — when
      // did this happen — so it is held to the same standard. A timezone-less
      // TIMESTAMP would let the reading host's zone decide where a record
      // citation lands on a timeline.
      const anchor = schema.columns.find((c) => c.name === schema.semanticTimeColumn);
      if (anchor && !TEMPORAL_COLUMN_TYPES.has(anchor.type)) {
        throw new Error(
          `${where} semanticTimeColumn '${anchor.name}' must be DATE or TIMESTAMPTZ ` +
            `(got ${anchor.type}); a timezone-less TIMESTAMP cannot anchor a record in time.`,
        );
      }
    }

    const record = schema.record;
    if (!record) {
      if (!requireRecord) continue;
      throw new Error(
        `${where} must declare a record display spec (titleColumns + keyColumns) for record citations.`,
      );
    }
    if (!record.titleColumns || record.titleColumns.length === 0) {
      throw new Error(`${where} record.titleColumns must be non-empty.`);
    }
    if (!record.keyColumns || record.keyColumns.length === 0) {
      throw new Error(`${where} record.keyColumns must be non-empty.`);
    }
    for (const col of [...record.titleColumns, ...record.keyColumns]) {
      if (!columnNames.has(col)) {
        throw new Error(`${where} record spec references column '${col}' which is not declared.`);
      }
    }
    if (record.titleTemplate !== undefined) {
      const titleSet = new Set(record.titleColumns);
      for (const placeholder of recordTemplatePlaceholders(record.titleTemplate)) {
        if (!titleSet.has(placeholder)) {
          throw new Error(
            `${where} record.titleTemplate references '{${placeholder}}' which is not listed in titleColumns.`,
          );
        }
      }
    }
  }
}

/**
 * Derive a single row's human title from its `RecordDisplaySpec` (#757). With
 * a `titleTemplate`, substitute each `{column}` placeholder with the row's
 * value (empty string for null/missing); otherwise join the non-empty
 * `titleColumns` values with a separator. Pure, client-agnostic: the gateway
 * runs this and ships only the resulting string, so clients never see column
 * names. Returns an empty string when nothing resolves (the caller decides a
 * fallback, e.g. the table's displayName).
 */
export function deriveRecordTitle(
  spec: RecordDisplaySpec,
  row: Record<string, string | number | boolean | null | undefined>,
  separator = " · ",
): string {
  const render = (value: string | number | boolean | null | undefined): string =>
    value === null || value === undefined ? "" : String(value);

  if (spec.titleTemplate !== undefined) {
    return spec.titleTemplate
      .replace(RECORD_TEMPLATE_PLACEHOLDER, (_, name: string) => render(row[name]))
      .trim();
  }
  return spec.titleColumns
    .map((col) => render(row[col]))
    .filter((v) => v.length > 0)
    .join(separator);
}

/**
 * Marker substituted for a `sensitive: true` column's value before a row
 * snapshot leaves the gateway (#757). Identical to the catalog preview's
 * redaction so a record citation never leaks credential material into a
 * persisted `metadata_json` snapshot or onto a client. The column still
 * appears (so the reader sees it exists), only the value is masked.
 */
export const REDACTED_VALUE = "<redacted>";

/** One key field surfaced on a record citation: a derived label + value. */
export interface RecordKeyField {
  /** Human label — the column's `description` when present, else its name. */
  label: string;
  /** The column value, redacted to `REDACTED_VALUE` for sensitive columns. */
  value: string | number | boolean | null;
}

/**
 * A fully derived, client-ready projection of a single analytics row as a
 * point-in-time record (#757). The gateway computes this from the table's
 * `AnalyticsTableSchema` + the immutable row snapshot the agent saw and ships
 * only these derived strings; clients never learn the column names or the
 * source identity, so the source-encapsulation rule holds.
 */
export interface RecordCitationFields {
  /** Title derived via {@link deriveRecordTitle}; never empty (falls back). */
  title: string;
  /** Key fields surfaced in the drawer, in `record.keyColumns` order. */
  keyFields: RecordKeyField[];
  /**
   * The row's semantic time — the value of the declared `semanticTimeColumn`
   * on this row, as a string. `null` when the table is timeless
   * (`semanticTimeColumn === null`) or the declared column is empty on this
   * row. A timeless record is NOT a timeline citation; the caller rejects it.
   */
  semanticTime: string | null;
  /**
   * The immutable row snapshot exactly as the agent saw it, with every
   * `sensitive: true` column's value masked to {@link REDACTED_VALUE}. Stored
   * verbatim in the citation's `metadata_json`.
   */
  redactedSnapshot: Record<string, string | number | boolean | null>;
}

type RecordCell = string | number | boolean | null | undefined;

/** Render a snapshot cell to its stored/display form (null for null/undefined). */
function renderCell(value: RecordCell): string | number | boolean | null {
  return value === undefined ? null : value;
}

/**
 * Derive the client-ready record-citation fields for one analytics row (#757).
 *
 * Pure and contract-driven: given the table's schema and the immutable row
 * snapshot the agent cited, it derives the title (via {@link deriveRecordTitle},
 * falling back to the table `displayName`), the key fields (labelled by each
 * column's `description`, value-redacted when `sensitive`), the semantic time
 * (the declared `semanticTimeColumn`'s value on this row, or `null`), and the
 * fully redacted snapshot. The gateway runs this and persists/ships only the
 * result — no column names or source identity reach a client.
 */
/**
 * Concise label for a record key field (#757). A column's `description` is
 * authored for the SQL/agent reader and often ends in a parenthetical example
 * or clarification ("Strava sport type (Run, Ride, Swim, …)") — fine in schema
 * docs, far too long for a compact key-field label. Drop a single trailing
 * parenthetical so the label reads as the bare noun ("Strava sport type");
 * everything else (and the column name fallback) passes through unchanged.
 */
function recordFieldLabel(description: string | undefined, col: string): string {
  const base = (description ?? col).trim();
  const stripped = base.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return stripped || base;
}

/**
 * Render a row's semantic time as one canonical ISO-8601 instant (#757).
 *
 * Two things have to happen to the value the database hands back. DuckDB
 * renders a TIMESTAMPTZ as `"2026-06-03 15:59:37+01"` — space separator,
 * hour-only offset. V8 parses that leniently, but strict clients (iOS
 * `ISO8601DateFormatter`, Android `OffsetDateTime`) do not, and the date
 * silently drops off those timelines; hence the space becomes a `T` and a bare
 * `±HH` offset is padded to `±HH:MM`.
 *
 * The offset is then collapsed to UTC. Which zone it arrives in is a property
 * of the reading session, not of the fact: the same instant a document
 * timestamp spells `2026-05-01T08:30:00.000Z` would render
 * `2026-05-01T09:30:00+01:00` here. Consumers place the two side by side and
 * some order them as strings, so two spellings of one instant would sort by
 * their offset rather than by when they happened. Grouping a value into a
 * calendar day is the reader's job, in the reader's zone — this function's job
 * is to name the instant once.
 *
 * A plain DATE (`"2026-06-03"`) is returned unchanged: it names a calendar day
 * rather than an instant, and which instants that day covers is, again, the
 * reader's question.
 */
function normalizeSemanticTime(raw: string): string {
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(.*)$/);
  if (!m) return raw.trim();
  const [, date, time, rawTz] = m;
  let tz = rawTz.trim();
  const tzm = tz.match(/^([+-]\d{2})(\d{2})?$/);
  if (tzm) tz = tzm[2] ? `${tzm[1]}:${tzm[2]}` : `${tzm[1]}:00`;
  const withZone = `${date}T${time}${tz}`;
  // Nothing to collapse without a zone, and none may be invented — an
  // ambiguous anchor is rejected at definition time and dropped at the wire.
  if (tz === "") return withZone;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : withZone;
}

export function deriveRecordCitationFields(
  schema: Pick<AnalyticsTableSchema, "displayName" | "columns" | "record" | "semanticTimeColumn">,
  snapshot: Record<string, RecordCell>,
): RecordCitationFields {
  const sensitiveCols = new Set(schema.columns.filter((c) => c.sensitive).map((c) => c.name));
  const descriptionByCol = new Map(schema.columns.map((c) => [c.name, c.description]));

  // Redact the full snapshot first; title + key fields read from the redacted
  // form so a sensitive value never leaks through either path.
  const redactedSnapshot: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(snapshot)) {
    const rendered = renderCell(value);
    redactedSnapshot[name] =
      sensitiveCols.has(name) && rendered !== null ? REDACTED_VALUE : rendered;
  }

  const title = deriveRecordTitle(schema.record, redactedSnapshot) || schema.displayName;

  const keyFields: RecordKeyField[] = schema.record.keyColumns.map((col) => ({
    label: recordFieldLabel(descriptionByCol.get(col), col),
    value: col in redactedSnapshot ? redactedSnapshot[col] : null,
  }));

  let semanticTime: string | null = null;
  if (schema.semanticTimeColumn !== null) {
    const raw = redactedSnapshot[schema.semanticTimeColumn];
    semanticTime =
      raw === null || raw === undefined || raw === "" ? null : normalizeSemanticTime(String(raw));
  }

  return { title, keyFields, semanticTime, redactedSnapshot };
}

/**
 * Result from a structured sync page.
 *
 * A page is a checkpointable unit of upstream progress: the rows it writes,
 * the documents it emits and the cursor that covers both, committed together.
 * Its analytics side is a list, because an upstream record does not always
 * correspond to one table — see `TableWrite`.
 */
export interface StructuredSyncResult<TCursor extends SyncCursor = SyncCursor> {
  /**
   * The analytics tables this page writes: one, several, or none.
   *
   * A page that emits only documents omits it. A page with one table names it
   * directly; a page whose upstream record fans out names each table it fills,
   * in the order the host should write them.
   */
  analytics?: PageTableWrites;
  /**
   * External IDs of *documents* to tombstone this page — the structured
   * counterpart of `SyncResult.deletedExternalIds`. Lets a hybrid source that
   * syncs incrementally (e.g. Google Calendar dropping a cancelled event)
   * delete its co-emitted documents without a full snapshot re-walk. Forwarded
   * to `upsertWithCursor` alongside `documents`, in the same atomic write.
   */
  deletedExternalIds?: string[];
  /** Updated cursor for checkpoint */
  cursor: TCursor;
  /** Whether more pages are available */
  hasMore: boolean;
  /** Optional progress info */
  progress?: SyncProgress;

  /**
   * Problems this page survived. See `SyncResult.issues` — same contract, and
   * the host sums them the same way.
   */
  issues?: SyncIssue[];
  /**
   * Optional documents to upsert alongside the structured records.
   * Enables hybrid sources that produce both DuckDB records and searchable documents.
   */
  documents?: DocumentInput[];

  /**
   * Structural edges declared between the co-emitted documents (#430), matching
   * the shape on `SyncResult.edges`. Forwarded to the gateway writer alongside
   * `documents` in the same atomic write.
   */
  edges?: EdgeDeclaration[];

  /**
   * Snapshot of external IDs currently present in the source-of-truth,
   * matching the shape on `SyncResult.presentExternalIds`. Set on the
   * final page of a full re-walk so the gateway can prune docs whose
   * external_id isn't in the snapshot. Hybrid sources (e.g. Strava
   * with a periodic snapshot-rewalk phase) use this to detect
   * deletions on the doc side; the structured-record side has its own
   * delete primitive (`deletedIds` per table write) and isn't affected.
   * Partial pages MUST leave this `undefined` — see SyncResult docs.
   */
  presentExternalIds?: string[];

  /**
   * The same assertion narrowed to named partitions, matching the shape on
   * `SyncResult.presentClaims` — the form a structured source reaches for when
   * part of its read failed.
   *
   * A hybrid source whose upstream is several stores (one Notion database, one
   * repository, one notebook per partition) can have one of them refuse a page
   * while the rest enumerate cleanly. `presentExternalIds` is all-or-nothing,
   * so that one refusal withholds deletion detection for every store, for as
   * long as it lasts. A claim vouches only for the partitions actually read,
   * and the gateway sweeps only the documents whose `partitionKey` names one.
   *
   * Same rules as its whole-source sibling: omitted on partial pages, refused
   * when set together with `presentExternalIds`, and worthless unless the
   * source stamps `DocumentInput.partitionKey` with the same partition names.
   */
  presentClaims?: SnapshotClaim[];

  /**
   * Forward-looking consent / authorization deadline (ISO 8601), matching the
   * shape on `SyncResult.consentExpiresAt`. The source reports its current
   * deadline on each successful page; the gateway persists it and derives a
   * non-terminal `auth-expiring` display state inside the lead window. Omitted /
   * `null` means no known deadline. See #927.
   */
  consentExpiresAt?: string | null;

  /** Coverage claim for this completed sync round. Must be omitted on partial pages. */
  watermark?: SourceWatermark;
}

/**
 * Catalog entry describing an available analytics table.
 */
export interface AnalyticsCatalogEntry {
  tableName: string;
  displayName: string;
  description: string;
  sourceId: string;
  columns: ColumnDefinition[];
  primaryKey: string[];
  recordCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  exampleQueries?: string[];
  /**
   * The table keys its rows by device stream: `columns` then ends with the
   * reserved `_stream_id` column and `primaryKey` ends with it, so the entry
   * describes the table as it is. Absent for a table one stream writes.
   */
  streamKeyed?: boolean;
}
