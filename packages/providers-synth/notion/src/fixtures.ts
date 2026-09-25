// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  sha256Hex,
  personMention,
  getPerson,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import type { AnalyticsTableSchema, ColumnDefinition, ColumnType } from "@omnesis/source-sdk";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

// ── Pages ─────────────────────────────────────────────────────────

interface PageEntry {
  externalId: string;
  title: string;
  body: string;
  createdAt: string;
  modifiedAt: string;
  author: string;
  tags: string[];
}

let pageCache: PageEntry[] | null = null;

export function loadPages(): PageEntry[] {
  if (pageCache) return pageCache;
  pageCache = loadSourceFixtureJson<PageEntry[]>(
    loadActiveUniverse(),
    "notion-pages",
    "pages.json",
  );
  return pageCache;
}

export function mapPage(
  e: PageEntry,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const authorPerson = getPerson(e.author);
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: e.externalId,
    title: e.title,
    content: e.body,
    contentHash: sha256Hex(`${e.externalId}:${e.body}:${e.modifiedAt}`),
    metadata: {
      documentType: "document",
      tags: e.tags,
      people: [personMention(e.author, "author")],
      extra: {
        author: authorPerson.name,
      },
    },
    sourceCreatedAt: e.createdAt,
    sourceUpdatedAt: e.modifiedAt,
  };
}

// ── Databases ─────────────────────────────────────────────────────

interface SchemaProperty {
  name: string;
  type: ColumnType;
  description: string;
  nullable?: boolean;
}

interface DatabaseRow {
  id: string;
  createdAt: string;
  modifiedAt: string;
  [key: string]: unknown;
}

interface DatabaseFixture {
  dbId: string;
  name: string;
  description: string;
  schemaProperties: SchemaProperty[];
  rows: DatabaseRow[];
}

let dbCache: DatabaseFixture[] | null = null;

export function loadDatabases(): DatabaseFixture[] {
  if (dbCache) return dbCache;
  dbCache = loadSourceFixtureJson<DatabaseFixture[]>(
    loadActiveUniverse(),
    "notion-databases",
    "databases.json",
  );
  return dbCache;
}

/** DuckDB table name follows the same `notion_<id>` convention the real source uses. */
export function tableNameFor(dbId: string): string {
  return `notion_${dbId.replace(/[^a-z0-9_]/gi, "_")}`;
}

/**
 * Build an AnalyticsTableSchema for one synthetic database. Mirrors the
 * real `mapDatabaseToSchema()` shape: every row carries `id`, `notion_url`,
 * `created_time`, `last_edited_time`, then one column per property.
 */
export function schemaForDatabase(db: DatabaseFixture): AnalyticsTableSchema {
  const baseColumns: ColumnDefinition[] = [
    { name: "id", type: "VARCHAR", description: "Notion page UUID (row id)" },
    { name: "notion_url", type: "VARCHAR", description: "Deep link to the row", references: "url" },
    { name: "created_time", type: "TIMESTAMPTZ", description: "Row creation time" },
    { name: "last_edited_time", type: "TIMESTAMPTZ", description: "Row last edit time" },
  ];
  const propColumns: ColumnDefinition[] = db.schemaProperties.map((p) => ({
    name: p.name,
    type: p.type,
    description: p.description,
    nullable: p.nullable,
    // Real Notion ships `sourceColumnId` so column renames in Notion don't
    // dissociate historical data; synth doesn't model renames, so we still
    // ship the property name as a stable id for symmetry.
    sourceColumnId: p.name,
  }));
  // Mirror the real mapper's record-citation declarations (#757): the page's
  // last-edited instant is the semantic time, and the first property column is
  // the de-facto title (the synth fixtures lead with the Name property), with a
  // fallback to the always-present `id`.
  const titleColumn = propColumns[0]?.name ?? "id";
  return {
    tableName: tableNameFor(db.dbId),
    displayName: db.name,
    description: db.description,
    columns: [...baseColumns, ...propColumns],
    primaryKey: ["id"],
    semanticTimeColumn: "last_edited_time",
    record: { titleColumns: [titleColumn], keyColumns: [titleColumn, "last_edited_time"] },
  };
}

export function rowsAsRecords(db: DatabaseFixture): Record<string, unknown>[] {
  return db.rows.map((r) => {
    const out: Record<string, unknown> = {
      id: r.id,
      notion_url: `https://notion.example/${db.dbId}/${r.id}`,
      created_time: r.createdAt,
      last_edited_time: r.modifiedAt,
    };
    for (const p of db.schemaProperties) {
      out[p.name] = (r as Record<string, unknown>)[p.name] ?? null;
    }
    return out;
  });
}

/** One Document per database — the discoverable "[Db] ProjectsName" page. */
export function databaseSummaryDocument(
  db: DatabaseFixture,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const tableName = tableNameFor(db.dbId);
  const propTable = [
    "| Property | Type | Description |",
    "|---|---|---|",
    ...db.schemaProperties.map((p) => `| ${p.name} | ${p.type} | ${p.description} |`),
  ].join("\n");
  const content = [
    `# [Db] ${db.name}`,
    "",
    db.description,
    "",
    "## Schema",
    "",
    propTable,
    "",
    `**DuckDB table:** \`${tableName}\``,
    "",
    `**Rows:** ${db.rows.length}`,
  ].join("\n");
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: `db-${db.dbId}`,
    title: `[Db] ${db.name}`,
    content,
    contentHash: sha256Hex(`db-${db.dbId}:${db.rows.length}:${db.schemaProperties.length}`),
    metadata: {
      documentType: "document",
      people: [personMention("self", "owner")],
      extra: {
        notionId: db.dbId,
        duckdbTable: tableName,
        rowCount: db.rows.length,
      },
    },
    sourceCreatedAt: db.rows[0]?.createdAt ?? "2025-08-01T00:00:00Z",
    sourceUpdatedAt:
      db.rows.reduce<string>((latest, r) => (r.modifiedAt > latest ? r.modifiedAt : latest), "") ||
      "2025-09-13T00:00:00Z",
  };
}

/** One Document per row — searchable, links back to the parent database. */
export function databaseRowDocument(
  db: DatabaseFixture,
  row: DatabaseRow,
  ctx: { sourceId: SourceId; providerId: ProviderId },
): DocumentInput {
  const propsTable = [
    "| Property | Value |",
    "|---|---|",
    ...db.schemaProperties.map(
      (p) => `| ${p.name} | ${String((row as Record<string, unknown>)[p.name] ?? "—")} |`,
    ),
  ].join("\n");
  const title = String(row.title ?? row.id);
  const content = `# ${db.name} > ${title}\n\n${propsTable}`;
  return {
    sourceId: ctx.sourceId,
    providerId: ctx.providerId,
    externalId: `row-${row.id}`,
    title: `${db.name} > ${title}`,
    content,
    contentHash: sha256Hex(`row-${row.id}:${row.modifiedAt}`),
    metadata: {
      documentType: "document",
      people: [personMention("self", "owner")],
      extra: {
        notionId: row.id,
        notionDatabaseId: db.dbId,
        databaseName: db.name,
        duckdbTable: tableNameFor(db.dbId),
      },
    },
    sourceCreatedAt: row.createdAt,
    sourceUpdatedAt: row.modifiedAt,
  };
}
