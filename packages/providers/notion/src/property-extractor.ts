// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Extracts values from Notion page properties into flat records
 * suitable for DuckDB analytics ingestion.
 */

import { sanitizeColumnName } from "./schema-mapper.js";
import type {
  PageObjectResponse,
  DataSourceObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

// ── Types ──────────────────────────────────────────────────────────────

type PageProperty = PageObjectResponse["properties"][string];

// ── Single Property Extraction ─────────────────────────────────────────

/**
 * Extract a scalar (or array) value from a single Notion page property.
 * Returns the appropriate JS primitive/array for the property type.
 */
export function extractPropertyValue(property: PageProperty): unknown {
  switch (property.type) {
    case "title":
      return property.title.map((t) => t.plain_text).join("") || null;

    case "rich_text":
      return property.rich_text.map((t) => t.plain_text).join("") || null;

    case "number":
      return property.number;

    case "checkbox":
      return property.checkbox;

    case "select":
      return property.select?.name ?? null;

    case "multi_select":
      return property.multi_select.map((s) => s.name);

    case "status":
      return property.status?.name ?? null;

    case "date":
      return property.date
        ? { start: property.date.start ?? null, end: property.date.end ?? null }
        : { start: null, end: null };

    case "people":
      return property.people.map((p) => ("name" in p && p.name) || "Unknown");

    case "relation":
      return property.relation.map((r) => r.id.replace(/-/g, ""));

    case "url":
      return property.url;

    case "email":
      return property.email;

    case "phone_number":
      return property.phone_number;

    case "created_time":
      return property.created_time;

    case "last_edited_time":
      return property.last_edited_time;

    case "created_by": {
      const user = property.created_by;
      return ("name" in user && user.name) || "Unknown";
    }

    case "last_edited_by": {
      const user = property.last_edited_by;
      return ("name" in user && user.name) || "Unknown";
    }

    case "formula":
      return extractFormulaValue(property.formula);

    case "rollup":
      return JSON.stringify(property.rollup);

    case "files":
      return property.files
        .map((f) => {
          if (f.type === "external") return f.external.url;
          if (f.type === "file") return f.file.url;
          // Fallback: try both shapes
          if ("external" in f) return (f as { external: { url: string } }).external.url;
          if ("file" in f) return (f as { file: { url: string } }).file.url;
          return null;
        })
        .filter(Boolean);

    case "unique_id": {
      const uid = property.unique_id;
      if (uid.number == null) return null;
      return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
    }

    default:
      return null;
  }
}

// ── Formula Helper ─────────────────────────────────────────────────────

function extractFormulaValue(formula: {
  type: string;
  string?: string | null;
  number?: number | null;
  boolean?: boolean | null;
  date?: { start: string; end: string | null } | null;
}): string | null {
  switch (formula.type) {
    case "string":
      return formula.string ?? null;
    case "number":
      return formula.number != null ? String(formula.number) : null;
    case "boolean":
      return formula.boolean != null ? String(formula.boolean) : null;
    case "date":
      return formula.date?.start ?? null;
    default:
      return null;
  }
}

// ── Property → Column Name Map ─────────────────────────────────────────

const SYSTEM_COLUMN_NAMES = new Set(["id", "notion_url", "created_time", "last_edited_time"]);
const SKIP_TYPES = new Set(["verification", "button", "created_time", "last_edited_time"]);

/**
 * Build a map from Notion property name to sanitized DuckDB column name.
 * Uses the same sanitization logic as schema-mapper to ensure consistency.
 */
export function buildPropertyColumnMap(database: DataSourceObjectResponse): Map<string, string> {
  const usedNames = new Set(SYSTEM_COLUMN_NAMES);
  const map = new Map<string, string>();

  for (const [propName, propConfig] of Object.entries(database.properties)) {
    if (SKIP_TYPES.has(propConfig.type)) continue;

    const sanitized = sanitizeColumnName(propName, usedNames);
    map.set(propName, sanitized);

    // Reserve the column name (and _start/_end for date properties)
    usedNames.add(sanitized);
    if (propConfig.type === "date") {
      usedNames.add(`${sanitized}_start`);
      usedNames.add(`${sanitized}_end`);
    }
  }

  return map;
}

// ── Row Record Extraction ──────────────────────────────────────────────

/**
 * Extract a flat record from a Notion page, ready for DuckDB upsert.
 * System columns are always included; property columns are mapped via
 * the provided propertyColumnMap.
 */
export function extractRowRecord(
  page: PageObjectResponse,
  _schema: AnalyticsTableSchema,
  propertyColumnMap: Map<string, string>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: page.id.replace(/-/g, ""),
    notion_url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
  };

  for (const [propName, property] of Object.entries(page.properties)) {
    const colName = propertyColumnMap.get(propName);
    if (!colName) continue;

    const value = extractPropertyValue(property);

    // Date properties split into two columns
    if (property.type === "date") {
      const dateVal = value as { start: string | null; end: string | null } | null;
      record[`${colName}_start`] = dateVal?.start ?? null;
      record[`${colName}_end`] = dateVal?.end ?? null;
    } else {
      record[colName] = value;
    }
  }

  return record;
}

// ── Human-Readable Summary ─────────────────────────────────────────────

/**
 * Produce a human-readable map of property name to string value.
 * Useful for building searchable document content from page properties.
 */
export function summarizeProperties(page: PageObjectResponse): Record<string, string> {
  const summary: Record<string, string> = {};

  for (const [propName, property] of Object.entries(page.properties)) {
    const str = stringifyValue(property);
    if (str) summary[propName] = str;
  }

  return summary;
}

// ── Stringify Helper ───────────────────────────────────────────────────

function stringifyValue(property: PageProperty): string {
  const value = extractPropertyValue(property);
  if (value == null) return "";

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "";
  }

  if (property.type === "date") {
    const d = value as { start: string | null; end: string | null };
    if (!d.start) return "";
    return d.end ? `${d.start} - ${d.end}` : d.start;
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value);
}
