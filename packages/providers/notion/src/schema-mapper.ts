// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Maps a Notion database schema to a DuckDB AnalyticsTableSchema.
 *
 * Each Notion database becomes a DuckDB table with system columns (id, url,
 * timestamps) plus one or more columns per user-defined property.
 */

import type { DataSourceObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { AnalyticsTableSchema, ColumnDefinition } from "@omnesis/source-sdk";

// ── Types ──────────────────────────────────────────────────────────────

type DatabaseProperty = DataSourceObjectResponse["properties"][string];

function stableDatabaseId(database: DataSourceObjectResponse): string {
  return (
    (database as unknown as { parent?: { database_id?: string } }).parent?.database_id ??
    database.id
  );
}

// Property types that produce no useful column data
const SKIP_TYPES = new Set(["verification", "button"]);

// Property types handled by system columns
const SYSTEM_TYPES = new Set(["created_time", "last_edited_time"]);

// ── Column Name Sanitization ───────────────────────────────────────────

/**
 * Sanitize a Notion property name into a valid snake_case column name.
 * Handles unicode, special characters, collisions, and edge cases.
 */
export function sanitizeColumnName(name: string, existingNames: Set<string> = new Set()): string {
  let col = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  if (/^\d/.test(col)) col = `_${col}`;
  if (!col) col = "col";

  // Deduplicate WITHIN this schema mapping run. `existingNames` is the
  // set of column names already chosen for OTHER properties in the
  // same Notion database (e.g. two properties named "Status" and
  // "status" both want `status`). Cross-sync stale-column handling is
  // not relevant here — the gateway-side `evolveTableSchema` rename-
  // archives columns that disappear from the new schema, so a Notion
  // property deleted and later re-added with the same name lands
  // cleanly on the original column slot. What survives
  // here is the same-run collision case, which still needs the `_N`
  // suffix because both properties must keep distinct DuckDB columns
  // for the current sync to round-trip.
  let final = col;
  let suffix = 2;
  while (existingNames.has(final)) {
    final = `${col}_${suffix}`;
    suffix++;
  }
  return final;
}

// ── Property → Column Mapping ──────────────────────────────────────────

interface MappedColumns {
  columns: ColumnDefinition[];
  /** The sanitized column name used for this property (first column if multiple) */
  columnName: string;
}

/**
 * Build a stable per-column source id for a Notion property. The
 * Notion property `id` is stable across rename, so the column name
 * can change without losing the link to historical data. Multi-
 * column properties (e.g. `date` produces `<col>_start` + `<col>_end`)
 * disambiguate via a suffix so each derived column has its own
 * stable id.
 *
 * Used by the gateway's `evolveTableSchema` to detect renames: when
 * the new schema's `sourceColumnId` matches an existing column's
 * `sourceColumnId` but the column names differ, the gateway issues
 * `ALTER TABLE RENAME COLUMN <old> TO <new>` instead of archiving
 * the old name and adding a fresh one.
 */
function notionColumnId(notionPropId: string, suffix?: string): string {
  return suffix ? `notion:${notionPropId}:${suffix}` : `notion:${notionPropId}`;
}

function mapPropertyToColumns(prop: DatabaseProperty, sanitizedName: string): MappedColumns | null {
  const desc = ("description" in prop && prop.description) || "";
  const description = typeof desc === "string" ? desc : "";

  switch (prop.type) {
    case "title":
    case "rich_text":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR",
            description: description || `${prop.type} property`,
            nullable: true,
          },
        ],
      };

    case "number":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "DOUBLE",
            description: description || "Number property",
            nullable: true,
          },
        ],
      };

    case "select":
    case "status":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR",
            description: description || `${prop.type} property`,
            nullable: true,
          },
        ],
      };

    case "multi_select":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR[]",
            description: description || "Multi-select values",
            nullable: true,
          },
        ],
      };

    case "date":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: `${sanitizedName}_start`,
            type: "TIMESTAMP",
            description: description || "Date start",
            nullable: true,
          },
          {
            name: `${sanitizedName}_end`,
            type: "TIMESTAMP",
            description: description || "Date end",
            nullable: true,
          },
        ],
      };

    case "people":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR[]",
            description: description || "People names",
            nullable: true,
          },
        ],
      };

    case "files":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR[]",
            description: description || "File URLs",
            nullable: true,
          },
        ],
      };

    case "checkbox":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "BOOLEAN",
            description: description || "Checkbox",
            nullable: true,
          },
        ],
      };

    case "url":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR",
            description: description || "URL",
            nullable: true,
          },
        ],
      };

    case "email":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR",
            description: description || "Email address",
            nullable: true,
          },
        ],
      };

    case "phone_number":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR",
            description: description || "Phone number",
            nullable: true,
          },
        ],
      };

    case "formula":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR",
            description: description || "Formula result (as string)",
            nullable: true,
          },
        ],
      };

    case "relation":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR[]",
            description: description || "Related page IDs",
            nullable: true,
          },
        ],
      };

    case "rollup":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR",
            description: description || "Rollup value (as JSON)",
            nullable: true,
          },
        ],
      };

    case "created_by":
    case "last_edited_by":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR",
            description: description || `${prop.type.replace(/_/g, " ")}`,
            nullable: true,
          },
        ],
      };

    case "unique_id":
      return {
        columnName: sanitizedName,
        columns: [
          {
            name: sanitizedName,
            type: "VARCHAR",
            description: description || "Unique ID",
            nullable: true,
          },
        ],
      };

    default:
      return null;
  }
}

// ── System Columns ─────────────────────────────────────────────────────

const SYSTEM_COLUMNS: ColumnDefinition[] = [
  { name: "id", type: "VARCHAR", description: "Notion page ID (no dashes)" },
  {
    name: "notion_url",
    type: "VARCHAR",
    description: "Notion page URL",
    nullable: true,
    references: "url",
  },
  { name: "created_time", type: "TIMESTAMPTZ", description: "Page creation time", nullable: true },
  {
    name: "last_edited_time",
    type: "TIMESTAMPTZ",
    description: "Page last edited time",
    nullable: true,
  },
];

// ── Main Mapper ────────────────────────────────────────────────────────

/**
 * Map a Notion database schema to a DuckDB AnalyticsTableSchema.
 * System columns come first, then one or more columns per user property.
 *
 * **Schema drift contract.** When the user renames a
 * Notion property the prior column is renamed to `_archived__<col>` on
 * the next sync (gateway-side, in `AnalyticsTableManager.evolveTableSchema`);
 * historical values survive and the new column lands on the original
 * slot. Same shape for delete: the column moves to `_archived__<col>`
 * with NULLs for the new schema. Delete-then-re-add of the same name
 * re-uses the original slot cleanly because the prior column was
 * archived away during the delete cycle. There is at most one
 * archived copy per name — a second archive on the same name drops
 * the older `_archived__<col>` first.
 *
 * Rename detection: each user property column carries its Notion
 * property `id` as `sourceColumnId` (encoded `notion:<propId>` —
 * date properties produce two columns, distinguished by `:start` /
 * `:end` suffixes). The gateway's `evolveTableSchema` matches by
 * `sourceColumnId` first, so a property rename in Notion ("Status"
 * → "State") translates to a single `ALTER TABLE RENAME COLUMN
 * status TO state` rather than archiving the old name and adding a
 * fresh column. Historical data stays under the new name.
 */
export function mapDatabaseToSchema(database: DataSourceObjectResponse): AnalyticsTableSchema {
  const dbId = stableDatabaseId(database).replace(/-/g, "");
  const tableName = `notion_${dbId}`;
  const displayName = extractDatabaseTitle(database);

  // Reserve system column names
  const usedNames = new Set(SYSTEM_COLUMNS.map((c) => c.name));
  const columns: ColumnDefinition[] = [...SYSTEM_COLUMNS];

  // The sanitized column name of the database's title property, captured for
  // the record-display spec (#757). Notion guarantees exactly one `title`
  // property per database; it carries the row's human name.
  let titleColumn: string | undefined;

  for (const [propName, propConfig] of Object.entries(database.properties)) {
    if (SKIP_TYPES.has(propConfig.type)) continue;
    if (SYSTEM_TYPES.has(propConfig.type)) continue;

    const sanitized = sanitizeColumnName(propName, usedNames);
    const mapped = mapPropertyToColumns(propConfig, sanitized);
    if (!mapped) continue;

    if (propConfig.type === "title") titleColumn = mapped.columnName;

    for (const col of mapped.columns) {
      usedNames.add(col.name);
      // Stamp the column with its Notion property id so the gateway-
      // side rename detector can match across renames. Multi-column
      // properties (date → `<col>_start` + `<col>_end`) disambiguate
      // via the column-name suffix relative to the canonical
      // `mapped.columnName`.
      const suffix =
        col.name === mapped.columnName ? undefined : col.name.slice(mapped.columnName.length + 1);
      columns.push({ ...col, sourceColumnId: notionColumnId(propConfig.id, suffix) });
    }
  }

  // A Notion row's real-world event time is the page's last-edited instant —
  // a system column always present (#757). The title comes from the database's
  // title property when it has one; otherwise the page id (always present)
  // titles the record so the spec stays valid for property-less databases.
  const recordTitleColumn = titleColumn ?? "id";

  return {
    tableName,
    displayName,
    description: `Notion database: ${displayName}`,
    columns,
    dynamicColumns: true,
    primaryKey: ["id"],
    semanticTimeColumn: "last_edited_time",
    record: {
      titleColumns: [recordTitleColumn],
      keyColumns: [recordTitleColumn, "last_edited_time"],
    },
    // Each row co-describes the per-row document, whose externalId is the same
    // hyphenless page id under a `row-` prefix (normalizer.ts, property-
    // extractor.ts) — declare the 1:1 doc↔row edge (#450). The per-database
    // summary doc (`db-<id>`) lacks the prefix and is intentionally unbound.
    boundDocument: { externalIdColumns: ["id"], externalIdPrefix: "row-" },
    exampleQueries: [
      `SELECT * FROM ${tableName} ORDER BY last_edited_time DESC LIMIT 20`,
      `SELECT COUNT(*) AS total FROM ${tableName}`,
      `SELECT * FROM ${tableName} WHERE created_time >= CURRENT_DATE - INTERVAL '7 days'`,
    ],
  };
}

// ── Title Extraction ───────────────────────────────────────────────────

/**
 * Extract the plain-text title from a Notion database object.
 */
export function extractDatabaseTitle(database: DataSourceObjectResponse): string {
  if (!database.title || database.title.length === 0) return "Untitled";
  return database.title.map((t) => t.plain_text).join("") || "Untitled";
}
