// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash } from "@omnesis/core";
import { type AnalyticsTableSchema } from "@omnesis/source-sdk";
import {
  type ProviderId,
  type SourceId,
  type DocumentInput,
  type PersonMention,
} from "@omnesis/types";
import type {
  PageObjectResponse,
  DataSourceObjectResponse,
  PartialUserObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { UserMap } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Extract the title from a Notion page by finding the first property
 * with type "title" and concatenating its plain_text runs.
 */
function extractPageTitle(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") {
      const text = prop.title.map((t) => t.plain_text).join("");
      if (text) return text;
    }
  }
  return "Untitled";
}

/**
 * Extract the title from a Notion database object.
 */
function extractDatabaseTitle(database: DataSourceObjectResponse): string {
  const text = database.title.map((t) => t.plain_text).join("");
  return text || "Untitled";
}

function stableDatabaseId(database: DataSourceObjectResponse): string {
  return (
    (database as unknown as { parent?: { database_id?: string } }).parent?.database_id ??
    database.id
  );
}

function parentPageId(database: DataSourceObjectResponse): string | undefined {
  const parent =
    (database as unknown as { database_parent?: { type: string; page_id?: string } })
      .database_parent ??
    (database as unknown as { parent?: { type: string; page_id?: string } }).parent;
  return parent?.type === "page_id" ? parent.page_id : undefined;
}

/**
 * Extract a display name from a partial user object.
 * Notion API returns `{ id, object: "user" }` for page-level created_by /
 * last_edited_by — no name. We fall back to the user ID.
 */
function userName(user: PartialUserObjectResponse, userMap?: UserMap): string {
  // Try the user map first (resolved from /users API)
  if (userMap) {
    const resolved = userMap.get(user.id);
    if (resolved?.name) return resolved.name;
  }
  // Fall back to inline name if the API returned a full user object
  if ("name" in user && typeof user.name === "string" && user.name) {
    return user.name;
  }
  return user.id;
}

function userEmail(user: PartialUserObjectResponse, userMap?: UserMap): string | undefined {
  return userMap?.get(user.id)?.email;
}

/**
 * Build PersonMention array from the `created_by` / `last_edited_by` partial
 * user objects on a Notion page or database. Both response shapes carry the
 * same `PartialUserObjectResponse` for these fields, so one extractor handles
 * both.
 */
function extractPeople(
  source: Pick<PageObjectResponse, "created_by" | "last_edited_by">,
  userMap?: UserMap,
): PersonMention[] {
  const people: PersonMention[] = [];

  const createdBy = source.created_by;
  const createdByEmail = userEmail(createdBy, userMap);
  people.push({
    role: "author",
    name: userName(createdBy, userMap),
    emails: createdByEmail ? [createdByEmail] : [],
    phones: [],
  });

  const editedBy = source.last_edited_by;
  if (editedBy.id !== createdBy.id) {
    const editedByEmail = userEmail(editedBy, userMap);
    people.push({
      role: "mentioned",
      name: userName(editedBy, userMap),
      emails: editedByEmail ? [editedByEmail] : [],
      phones: [],
    });
  }

  return people;
}

/**
 * Extract the parent database ID from a page, if it lives inside a database.
 */
function extractParentDatabaseId(page: PageObjectResponse): string | undefined {
  if (page.parent.type === "database_id") {
    return page.parent.database_id;
  }
  return undefined;
}

/**
 * Render a property value to a human-readable string for display in
 * database row document content.
 */
function renderPropertyValue(value: string | undefined): string {
  return value ?? "";
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Convert a standalone Notion page into a DocumentInput.
 */
export function pageToDocument(
  page: PageObjectResponse,
  markdown: string,
  sourceId: SourceId,
  providerId: ProviderId,
  userMap?: UserMap,
  linkedPageIds?: string[],
): DocumentInput {
  const title = extractPageTitle(page);

  const extra: Record<string, unknown> = {
    notionId: page.id,
    parentType: page.parent.type,
  };
  if (linkedPageIds && linkedPageIds.length > 0) {
    extra.links = linkedPageIds;
  }

  return {
    externalId: `page-${page.id.replace(/-/g, "")}`,
    title,
    content: markdown,
    contentHash: computeContentHash(markdown),
    providerId,
    sourceId,
    metadata: {
      documentType: "document",
      sourceUrl: page.url,
      people: extractPeople(page, userMap),
      extra,
    },
    sourceCreatedAt: page.created_time,
    sourceUpdatedAt: page.last_edited_time,
  };
}

/**
 * Convert a Notion database into a summary DocumentInput that makes
 * the database discoverable via search.
 */
export function databaseSummaryToDocument(
  database: DataSourceObjectResponse,
  schema: AnalyticsTableSchema,
  sourceId: SourceId,
  providerId: ProviderId,
  userMap?: UserMap,
): DocumentInput {
  const title = extractDatabaseTitle(database);
  const databaseId = stableDatabaseId(database);

  // Build property table rows from the database schema definition
  const propertyRows = Object.entries(database.properties)
    .map(([name, prop]) => `| ${name} | ${prop.type} |`)
    .join("\n");

  const columnCount = Object.keys(database.properties).length;

  const content = [
    `# ${title}`,
    "",
    `Notion database with ${columnCount} properties.`,
    "",
    "| Property | Type |",
    "|---|---|",
    propertyRows,
    "",
    `**DuckDB table:** \`${schema.tableName}\``,
    "",
    `Query with: \`npm run query -- sql "SELECT * FROM ${schema.tableName} LIMIT 10"\``,
  ].join("\n");

  const extra: Record<string, unknown> = {
    notionId: databaseId,
    duckdbTable: schema.tableName,
  };

  // When the database lives under a Notion page, emit a reference-graph link
  // to that parent page so the link extractor wires the two together.
  // Mirror the `page-{notionIdNoDashes}` shape used by `pageToDocument`.
  const pageId = parentPageId(database);
  if (pageId) {
    extra.links = [`page-${pageId.replace(/-/g, "")}`];
  }

  return {
    externalId: `db-${databaseId.replace(/-/g, "")}`,
    title: `[Db] ${title}`,
    content,
    contentHash: computeContentHash(content),
    providerId,
    sourceId,
    metadata: {
      documentType: "document",
      sourceUrl: database.url,
      tags: ["notion-database"],
      people: extractPeople(database, userMap),
      extra,
    },
    sourceCreatedAt: database.created_time,
    sourceUpdatedAt: database.last_edited_time,
  };
}

/**
 * Convert a Notion database row (page inside a database) into a DocumentInput.
 *
 * @param page - The page object from the Notion API
 * @param propertySummary - Pre-extracted property name→value pairs for display
 * @param dbTitle - Title of the parent database, used as a prefix
 */
/**
 * The external id of a database row's document.
 *
 * Named here, beside the document that carries it, because the snapshot has to
 * name rows the walk saw but did not ingest — a reference object with no
 * properties, a row aged out of the retention window — and a second spelling of
 * this rule would be one the snapshot and the document could disagree on.
 */
export function rowExternalId(pageId: string): string {
  return `row-${pageId.replace(/-/g, "")}`;
}

export function databaseRowToDocument(
  page: PageObjectResponse,
  propertySummary: Array<{ name: string; value: string }>,
  dbTitle: string,
  sourceId: SourceId,
  providerId: ProviderId,
  userMap?: UserMap,
): DocumentInput {
  const rowTitle = extractPageTitle(page);
  const title = `${dbTitle} > ${rowTitle}`;

  const propertyRows = propertySummary
    .map((p) => `| ${p.name} | ${renderPropertyValue(p.value)} |`)
    .join("\n");

  const content = ["| Property | Value |", "|---|---|", propertyRows].join("\n");

  return {
    externalId: rowExternalId(page.id),
    title,
    content,
    contentHash: computeContentHash(content),
    providerId,
    sourceId,
    metadata: {
      documentType: "document",
      sourceUrl: page.url,
      people: extractPeople(page, userMap),
      extra: {
        notionId: page.id,
        notionDatabaseId: extractParentDatabaseId(page),
      },
    },
    sourceCreatedAt: page.created_time,
    sourceUpdatedAt: page.last_edited_time,
  };
}
