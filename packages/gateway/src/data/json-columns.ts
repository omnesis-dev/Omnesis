// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Typed codecs for every JSON-as-TEXT column in the gateway's SQLite
 * databases. Each codec pairs a zod schema with a write-path serialiser and
 * two read-path parsers — `parse()` throws on corrupt rows (use it where a
 * silent corruption is unsafe), `parseWithFallback()` logs + returns a typed
 * default (use it where a corrupt row should not cascade).
 *
 * Defining the codec once means the writer and the reader can never drift —
 * the in-memory shape is the schema, period. It also gives us one place to
 * tighten validation when a column's contract evolves.
 *
 * The bundle that introduced this replaces
 * scattered `JSON.parse(row.x) as Y` casts with `codec.parse(row.x)` calls
 * across the gateway. New code MUST go through a codec; bare JSON.parse
 * against a row column is a regression.
 */

import { createLogger, syncRemediationSchema, syncIssueStatusSchema } from "@omnesis/core";
import { isValidScope, type Scope } from "@omnesis/types";
import { z, type ZodTypeAny } from "zod";

const log = createLogger("gateway:db:json-columns");

/**
 * Generic codec for a TEXT column that stores JSON.
 *
 * - `serialize` enforces the in-memory shape so a write that violates the
 *   schema never reaches the row. (Cheap insurance — JSON.stringify on
 *   `{x:"a", weird: BigInt(1)}` already throws; this catches the rest.)
 * - `parse` runs `JSON.parse` then `schema.parse` and throws on either
 *   failure. The caller catches the throw and decides what to do.
 * - `parseWithFallback` is the lenient sibling for callers who would
 *   rather log + carry on with a typed default than crash an entire
 *   read.
 *
 * Both parsers accept an optional context (`table`, `column`, `rowId`)
 * so the warning log carries enough breadcrumbs to find the bad row.
 */
export interface JsonColumnCodec<T> {
  readonly table: string;
  readonly column: string;
  serialize(value: T): string;
  parse(raw: string, ctx?: ParseContext): T;
  parseWithFallback(raw: string, ctx?: ParseContext): T;
}

export interface ParseContext {
  /** Optional row identifier — surfaces in the warn log on parse failure. */
  rowId?: string;
}

interface CodecOptions<S extends ZodTypeAny> {
  table: string;
  column: string;
  schema: S;
  /** Returned by `parseWithFallback()` on corrupt JSON or schema mismatch. */
  fallback: () => z.infer<S>;
}

function makeCodec<S extends ZodTypeAny>(opts: CodecOptions<S>): JsonColumnCodec<z.infer<S>> {
  const { table, column, schema, fallback } = opts;

  function reportFailure(reason: string, raw: string, ctx?: ParseContext): void {
    const where = `${table}.${column}${ctx?.rowId ? ` (row=${ctx.rowId})` : ""}`;
    // First 80 chars is enough to spot the shape; longer would just bloat
    // the log on a malformed multi-MB row.
    const sample = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    log.warn(`Corrupt JSON column ${where}: ${reason} (raw=${JSON.stringify(sample)})`);
  }

  return {
    table,
    column,
    serialize(value) {
      // Throws on shape violation — the caller is asking us to write a row
      // that we know we won't be able to read back coherently.
      const parsed = schema.parse(value);
      return JSON.stringify(parsed);
    },
    parse(raw, _ctx) {
      let asAny: unknown;
      try {
        asAny = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${table}.${column} contains invalid JSON: ${msg}`, { cause: err });
      }
      return schema.parse(asAny);
    },
    parseWithFallback(raw, ctx) {
      let asAny: unknown;
      try {
        asAny = JSON.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reportFailure(`invalid JSON: ${msg}`, raw, ctx);
        return fallback();
      }
      const result = schema.safeParse(asAny);
      if (!result.success) {
        reportFailure(
          `shape mismatch: ${result.error.issues.map((i) => i.message).join("; ")}`,
          raw,
          ctx,
        );
        return fallback();
      }
      return result.data;
    },
  };
}

// ── Per-column schemas + codecs ─────────────────────────────────────────────
//
// Schemas are intentionally permissive at the structural level for columns
// whose contents are an opaque caller-supplied shape (documents.metadata,
// trigger payloads, sources.config). Tightening those would either require
// per-source-type schemas (a separate sweep) or break the long tail of
// providers. The codec earns its keep here by catching *invalid JSON* uniformly
// even when the in-memory shape is `Record<string, unknown>`.

/** documents.metadata — opaque per-source metadata object. */
const metadataSchema = z.record(z.string(), z.unknown());
export const documentsMetadataCodec = makeCodec({
  table: "documents",
  column: "metadata",
  schema: metadataSchema,
  fallback: () => ({}),
});
export type DocumentsMetadata = z.infer<typeof metadataSchema>;

/**
 * Typed projection of documents.metadata's known-field set. Mirrors
 * `DocumentMetadata` from `@omnesis/core/document.ts` but with every
 * field optional (the on-disk JSON is producer-controlled and may
 * omit any field). Each caller plucks the subset it needs.
 *
 * Pre-fix the same parse-and-cast block was inlined in
 * `gateway/src/indexer/direct-document-source.ts:toIndexable`,
 * `gateway/src/http/dto/document-dto.ts:toListedDocumentDto`, and
 * `gateway/src/http/dto/document-dto.ts:toRecentDocumentDto`. Now
 * they all go through `parseDocumentMetadata`.
 */
export interface ParsedDocumentMetadata {
  documentType?: string;
  sourceUrl?: string;
  appUrl?: string;
  /** Source-computed relevance score (0.0–1.0). */
  relevanceScore?: number;
  /** Tags / labels from the source system. */
  tags?: unknown;
  /** Structured people mentions. The opaque `unknown` shape mirrors
   *  the existing call-sites' cast — `PersonMention[]` from core is
   *  the canonical type once the consumer is ready to validate. */
  people?: unknown;
  /** Source-specific extra. */
  extra?: Record<string, unknown>;
}

/**
 * Parse `documents.metadata` (raw JSON string OR pre-parsed object)
 * into the typed projection. Single source of truth for the
 * codec-and-cast dance. Returns `{}` when parsing fails — the
 * underlying `parseWithFallback` already handles that case + logs.
 */
export function parseDocumentMetadata(
  raw: string | Record<string, unknown> | null | undefined,
  rowId: string,
): ParsedDocumentMetadata {
  if (raw === null || raw === undefined) return {};
  // The codec accepts a raw JSON string; if a caller already has the
  // pre-parsed object (DirectDocumentSource passes the row's
  // `metadata` field which is already an object on the way out of
  // better-sqlite3 + JSON-typed columns), short-circuit.
  const parsed: Record<string, unknown> =
    typeof raw === "string"
      ? (documentsMetadataCodec.parseWithFallback(raw, { rowId }) as Record<string, unknown>)
      : raw;
  return parsed as ParsedDocumentMetadata;
}

/**
 * Fast-path metadata parser for trusted internal consumers (the
 * indexer). Skips Zod validation entirely — uses raw `JSON.parse`
 * with a try/catch fallback to `{}`. The `z.record(z.unknown())`
 * schema accepts any object, so the Zod pass is a pure overhead
 * tax (SafeParseResult allocation, issue-array construction) with
 * no filtering benefit.
 */
export function parseDocumentMetadataFast(
  raw: string | Record<string, unknown> | null | undefined,
  _rowId: string,
): ParsedDocumentMetadata {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "string") return raw as ParsedDocumentMetadata;
  try {
    return JSON.parse(raw) as ParsedDocumentMetadata;
  } catch {
    return {};
  }
}

/** sync_state.cursor — opaque per-source sync cursor. */
const cursorSchema = z.record(z.string(), z.unknown());
export const syncStateCursorCodec = makeCodec({
  table: "sync_state",
  column: "cursor",
  schema: cursorSchema,
  fallback: () => ({}),
});
export type SyncStateCursor = z.infer<typeof cursorSchema>;

/**
 * sync_state.last_error_remediation — the structured remedy reported beside a
 * sync error. A row whose JSON no longer parses reads as no remedy: the
 * message beside it still reaches the operator, and the next report rewrites
 * the column.
 */
export const syncErrorRemediationCodec = makeCodec({
  table: "sync_state",
  column: "last_error_remediation",
  schema: syncRemediationSchema.nullable(),
  fallback: () => null,
});

/** devices.capabilities — opaque caller-supplied capability bag. */
const capabilitiesSchema = z.record(z.string(), z.unknown());
export const devicesCapabilitiesCodec = makeCodec({
  table: "devices",
  column: "capabilities",
  schema: capabilitiesSchema,
  fallback: () => ({}),
});

/**
 * `tokens.scopes` / `sessions.scopes` / `device_pairings.scopes` — each row
 * is a JSON array of well-formed scope strings. Filter-rather-than-fail on
 * the read path so a single malformed entry doesn't lose every scope on the
 * row; the boundary that originally minted the scope is the right place to
 * fail loud.
 */
const scopesSchema = z.array(z.string()).transform((arr) => arr.filter(isValidScope) as Scope[]);
function makeScopesCodec(table: string): JsonColumnCodec<Scope[]> {
  return makeCodec({ table, column: "scopes", schema: scopesSchema, fallback: () => [] });
}
export const tokensScopesCodec = makeScopesCodec("tokens");
export const sessionsScopesCodec = makeScopesCodec("sessions");
export const devicePairingsScopesCodec = makeScopesCodec("device_pairings");

/** merge_candidates.matched_tokens — array of opaque match-token strings. */
const matchedTokensSchema = z.array(z.string());
export const mergeCandidatesMatchedTokensCodec = makeCodec({
  table: "merge_candidates",
  column: "matched_tokens",
  schema: matchedTokensSchema,
  fallback: () => [] as string[],
});

/** link_stats.by_type_json — per-link-type counters. */
const linkStatsByTypeSchema = z.record(
  z.string(),
  z.object({ total: z.number(), resolved: z.number() }),
);
export const linkStatsByTypeCodec = makeCodec({
  table: "link_stats",
  column: "by_type_json",
  schema: linkStatsByTypeSchema,
  fallback: () => ({}),
});
export type LinkStatsByType = z.infer<typeof linkStatsByTypeSchema>;

/**
 * `_analytics_catalog.schema_json` — the AnalyticsTableSchema shape from
 * `@omnesis/core`. We don't redeclare every field here because the source-
 * supplied schemas pre-date this codec; instead we enforce the coarse shape
 * (object, has columns array) and let the caller cast. The previous
 * `parseSchemaJson` helper at `analytics-db.ts:45-58` returned `null` on
 * shape mismatch, which the codec preserves via `parseWithFallback(...) →
 * fallback() === null`. Use `parseWithFallback` everywhere on read for the
 * analytics catalog — corruption there must not block the read of healthy
 * rows.
 */
const analyticsSchemaSchema = z
  .object({
    columns: z.array(z.unknown()),
  })
  .passthrough();
export const analyticsCatalogSchemaCodec = makeCodec({
  table: "_analytics_catalog",
  column: "schema_json",
  schema: analyticsSchemaSchema,
  // The analytics catalog reader treats null as "schema unavailable" and
  // falls back to inspect-the-table; mirror that here.
  fallback: () => null as unknown as z.infer<typeof analyticsSchemaSchema>,
});

/** sources.config — opaque source-type-specific config bag. */
const sourceConfigSchema = z.record(z.string(), z.unknown());
export const sourcesConfigCodec = makeCodec({
  table: "sources",
  column: "config",
  schema: sourceConfigSchema,
  fallback: () => ({}),
});

/** source_devices.config_override — member-local overlay on sources.config. */
export const sourceDeviceConfigOverrideCodec = makeCodec({
  table: "source_devices",
  column: "config_override",
  schema: sourceConfigSchema,
  fallback: () => ({}),
});

/** Opaque source output; HTTP validates its executable fields before preparation. */
export const pendingSourcePageCodec = makeCodec({
  table: "pending_source_pages",
  column: "payload_json",
  schema: z.record(z.string(), z.unknown()),
  fallback: () => ({}),
});
export const pendingPageOmissionsCodec = makeCodec({
  table: "pending_source_page_observations",
  column: "matured_keys",
  schema: z.array(z.string()),
  fallback: () => [],
});
export const sourceSyncIssuesCodec = makeCodec({
  table: "source_sync_issues",
  column: "issues_json",
  schema: z.array(syncIssueStatusSchema).max(50),
  fallback: () => [],
});
