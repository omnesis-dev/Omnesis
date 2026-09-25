// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Hand-authored catalog for the gateway's SQLite document store.
 *
 * The SQLite schema is small and stable (documents, sync_state, people,
 * links, tokens, …), so instead of dynamically introspecting it on every
 * portal load we keep descriptions + example queries here. Row counts,
 * date ranges, and DB size still come from live `PRAGMA`/`COUNT(*)`
 * queries so the catalog reflects current state.
 *
 * Shape mirrors `AnalyticsCatalogEntry` from `@omnesis/core` so the
 * portal can render DuckDB and SQLite tables with the same components.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;
import type { AnalyticsCatalogEntry, ColumnDefinition } from "@omnesis/source-sdk";

/**
 * Static metadata for one SQLite table. Live stats are layered on top.
 */
interface SqliteTableDef {
  tableName: string;
  displayName: string;
  description: string;
  columns: ColumnDefinition[];
  primaryKey: string[];
  /** Column name used for row-activity sparklines + date-range stats. */
  timestampColumn?: string;
  /** Columns to show in the preview (defaults to all, minus big text blobs). */
  previewColumns?: string[];
  exampleQueries: string[];
}

const TABLE_DEFS: SqliteTableDef[] = [
  {
    tableName: "documents",
    displayName: "Documents",
    description:
      "All indexed documents across sources — emails, events, pages, conversations, activities. One row per (provider, source, externalId).",
    columns: [
      {
        name: "id",
        type: "VARCHAR",
        description: "UUID primary key (internal)",
        references: "document",
      },
      {
        name: "provider_id",
        type: "VARCHAR",
        description: "Provider instance id, e.g. google:user@gmail.com",
      },
      {
        name: "source_id",
        type: "VARCHAR",
        description: "Source id, e.g. gmail:user@gmail.com",
        references: "source",
      },
      {
        name: "external_id",
        type: "VARCHAR",
        description: "Upstream id unique within (provider, source)",
      },
      { name: "title", type: "VARCHAR", description: "Human-readable title" },
      { name: "content", type: "VARCHAR", description: "Full markdown/plain content body (large)" },
      {
        name: "content_hash",
        type: "VARCHAR",
        description: "SHA of content — drives dedup/re-index",
      },
      { name: "metadata", type: "JSON", description: "Free-form JSON (people, tags, extra)" },
      {
        name: "source_url",
        type: "VARCHAR",
        description: "Canonical upstream URL",
        nullable: true,
        references: "url",
      },
      {
        name: "source_created_at",
        type: "TIMESTAMP",
        description: "When the upstream thing was created",
      },
      {
        name: "source_updated_at",
        type: "TIMESTAMP",
        description: "When it was last updated upstream",
      },
      { name: "ingested_at", type: "TIMESTAMP", description: "First time we ingested this doc" },
      { name: "updated_at", type: "TIMESTAMP", description: "Last local upsert time" },
      {
        name: "people_resolved_at",
        type: "TIMESTAMP",
        description: "When people were extracted (NULL = pending)",
        nullable: true,
      },
      {
        name: "links_extracted_at",
        type: "TIMESTAMP",
        description: "When links were extracted (NULL = pending)",
        nullable: true,
      },
    ],
    primaryKey: ["id"],
    timestampColumn: "source_updated_at",
    previewColumns: ["id", "source_id", "title", "source_created_at", "updated_at"],
    exampleQueries: [
      "SELECT source_id, COUNT(*) AS n FROM documents GROUP BY source_id ORDER BY n DESC",
      "SELECT id, source_id, title, source_created_at FROM documents ORDER BY source_created_at DESC LIMIT 20",
      "SELECT source_id, DATE(source_updated_at) AS day, COUNT(*) AS n FROM documents WHERE source_updated_at > datetime('now', '-14 days') GROUP BY source_id, day ORDER BY day DESC, n DESC",
      "SELECT COUNT(*) AS unresolved_people FROM documents WHERE people_resolved_at IS NULL",
    ],
  },
  {
    tableName: "sync_state",
    displayName: "Sync state",
    description:
      "Per-source sync cursor, icon, label and URL patterns. Keyed by (source_id, device_id); device_id '' is the source's shared row.",
    columns: [
      { name: "source_id", type: "VARCHAR", description: "Source id", references: "source" },
      {
        name: "device_id",
        type: "VARCHAR",
        description: "'' for the shared row; a device id for a per-device cursor",
      },
      { name: "cursor", type: "JSON", description: "Opaque cursor (shape is source-specific)" },
      {
        name: "last_synced_at",
        type: "TIMESTAMP",
        description: "Last time the collector reported progress",
      },
      {
        name: "icon",
        type: "VARCHAR",
        description: "Icon (base64 PNG or SF symbol)",
        nullable: true,
      },
      { name: "label", type: "VARCHAR", description: "Friendly display name", nullable: true },
      {
        name: "url_patterns",
        type: "JSON",
        description: "URL regexes for intra-source link resolution",
        nullable: true,
      },
    ],
    primaryKey: ["source_id", "device_id"],
    timestampColumn: "last_synced_at",
    exampleQueries: [
      "SELECT source_id, label, last_synced_at FROM sync_state ORDER BY last_synced_at DESC",
      "SELECT source_id, last_synced_at FROM sync_state WHERE last_synced_at < datetime('now', '-1 day') ORDER BY last_synced_at",
      // A source that declares versioned state nests its bookmark under
      // `state`; one that does not stores it at the top level. coalesce reads
      // both, so the query works whatever a given source declares.
      "SELECT source_id, coalesce(json_extract(cursor, '$.state.phase'), json_extract(cursor, '$.phase')) AS phase FROM sync_state",
    ],
  },
  {
    tableName: "document_links",
    displayName: "Document links",
    description:
      "Reference graph edges extracted from document content/metadata. URLs, intra-source wikilinks, email threads, attachment parents. Unresolved links (target_doc_id IS NULL) are retried every 5 min.",
    columns: [
      { name: "id", type: "INTEGER", description: "Auto-increment id" },
      {
        name: "source_doc_id",
        type: "VARCHAR",
        description: "Document containing the link",
        references: "document",
      },
      {
        name: "link_type",
        type: "VARCHAR",
        description: "url | intra-source | email-thread | attachment",
      },
      { name: "raw_target", type: "VARCHAR", description: "As it appears in content" },
      {
        name: "normalized_target",
        type: "VARCHAR",
        description: "Resolution key (normalized URL, thread id, …)",
      },
      {
        name: "target_doc_id",
        type: "VARCHAR",
        description: "Resolved target (NULL = dangling)",
        nullable: true,
        references: "document",
      },
      {
        name: "resolved_at",
        type: "TIMESTAMP",
        description: "When the target was first resolved",
        nullable: true,
      },
      { name: "created_at", type: "TIMESTAMP", description: "When the link was extracted" },
    ],
    primaryKey: ["id"],
    timestampColumn: "created_at",
    exampleQueries: [
      "SELECT link_type, COUNT(*) AS n FROM document_links GROUP BY link_type ORDER BY n DESC",
      "SELECT COUNT(*) AS resolved, SUM(CASE WHEN target_doc_id IS NULL THEN 1 ELSE 0 END) AS unresolved FROM document_links",
      "SELECT normalized_target, COUNT(*) AS inbound FROM document_links WHERE target_doc_id IS NOT NULL GROUP BY normalized_target ORDER BY inbound DESC LIMIT 20",
    ],
  },
  {
    tableName: "people",
    displayName: "People",
    description:
      "Canonical person entities. Rows with merged_into set were collapsed into another person and should be excluded from queries unless you want merge history.",
    columns: [
      { name: "id", type: "VARCHAR", description: "Person id", references: "person" },
      { name: "canonical_name", type: "VARCHAR", description: "Display name" },
      {
        name: "merged_into",
        type: "VARCHAR",
        description: "Set when this row was merged into another",
        nullable: true,
        references: "person",
      },
      {
        name: "source",
        type: "VARCHAR",
        description: "First-seen source id",
        references: "source",
      },
      { name: "is_self", type: "BOOLEAN", description: "TRUE for the user themselves" },
      {
        name: "first_seen",
        type: "TIMESTAMP",
        description: "Earliest document referencing this person",
      },
      {
        name: "last_seen",
        type: "TIMESTAMP",
        description: "Latest document referencing this person",
      },
      { name: "created_at", type: "TIMESTAMP", description: "Row creation time" },
      { name: "updated_at", type: "TIMESTAMP", description: "Last mutation" },
    ],
    primaryKey: ["id"],
    timestampColumn: "first_seen",
    previewColumns: ["id", "canonical_name", "is_self", "first_seen", "last_seen"],
    exampleQueries: [
      "SELECT id, canonical_name, is_self, last_seen FROM people WHERE merged_into IS NULL ORDER BY last_seen DESC LIMIT 20",
      "SELECT COUNT(*) FROM people WHERE merged_into IS NOT NULL",
      "SELECT p.canonical_name, COUNT(dp.document_id) AS mentions FROM people p JOIN document_people dp ON dp.person_id = p.id WHERE p.merged_into IS NULL GROUP BY p.id ORDER BY mentions DESC LIMIT 20",
    ],
  },
  {
    tableName: "person_aliases",
    displayName: "Person aliases",
    description:
      "Identifiers (email, phone, handle) that map to a person. A person can have many aliases; aliases are the join key for merging across sources.",
    columns: [
      { name: "id", type: "VARCHAR", description: "Alias row id" },
      {
        name: "person_id",
        type: "VARCHAR",
        description: "Person this alias belongs to",
        references: "person",
      },
      {
        name: "alias",
        type: "VARCHAR",
        description: "The alias value (email address, E.164 phone, lid)",
      },
      { name: "alias_type", type: "VARCHAR", description: "email | phone | lid | name" },
      {
        name: "source_id",
        type: "VARCHAR",
        description: "Where we first saw this alias",
        nullable: true,
        references: "source",
      },
      { name: "created_at", type: "TIMESTAMP", description: "When the alias was recorded" },
    ],
    primaryKey: ["id"],
    timestampColumn: "created_at",
    exampleQueries: [
      "SELECT alias_type, COUNT(*) FROM person_aliases GROUP BY alias_type",
      "SELECT p.canonical_name, a.alias_type, a.alias FROM person_aliases a JOIN people p ON p.id = a.person_id WHERE p.is_self = TRUE",
    ],
  },
  {
    tableName: "document_people",
    displayName: "Document ⇄ people",
    description:
      "Join table linking documents to people mentioned in them, with a role (sender/recipient/participant/attendee/mentioned/owner/author/contact).",
    columns: [
      { name: "document_id", type: "VARCHAR", description: "Document id", references: "document" },
      { name: "person_id", type: "VARCHAR", description: "Person id", references: "person" },
      { name: "role", type: "VARCHAR", description: "How the person relates to the document" },
      {
        name: "source_id",
        type: "VARCHAR",
        description: "Source that emitted this mention",
        nullable: true,
        references: "source",
      },
    ],
    primaryKey: ["document_id", "person_id", "role"],
    exampleQueries: [
      "SELECT role, COUNT(*) FROM document_people GROUP BY role ORDER BY 2 DESC",
      "SELECT p.canonical_name, dp.role, COUNT(*) AS n FROM document_people dp JOIN people p ON p.id = dp.person_id WHERE p.merged_into IS NULL GROUP BY p.id, dp.role ORDER BY n DESC LIMIT 20",
    ],
  },
  {
    tableName: "tokens",
    displayName: "API tokens",
    description:
      "Hashed API tokens used by collectors, CLIs, and the portal. Store only the SHA-256 hash — the raw token is shown once at creation. Each token belongs to a device and carries a JSON list of scopes.",
    columns: [
      { name: "id", type: "VARCHAR", description: "Token id" },
      {
        name: "device_id",
        type: "VARCHAR",
        description: "Device this token was issued to (FK → devices.id)",
      },
      {
        name: "token_hash",
        type: "VARCHAR",
        description: "SHA-256 of the raw token (never the raw token)",
        sensitive: true,
      },
      {
        name: "scopes",
        type: "JSON",
        description: 'JSON array of scope strings (e.g. ["read","admin","write:*"])',
      },
      { name: "name", type: "VARCHAR", description: "User-supplied label, unique", nullable: true },
      { name: "created_at", type: "INTEGER", description: "When issued (epoch ms)" },
      {
        name: "last_used_at",
        type: "INTEGER",
        description: "Last request that authenticated with this token (epoch ms)",
        nullable: true,
      },
    ],
    primaryKey: ["id"],
    // created_at / last_used_at are epoch-ms ints, not ISO timestamps —
    // skip the timestamp-driven sparkline + earliest/latest stats rather
    // than fudge the formatter.
    // token_hash stays in the preview so redaction is visibly shown
    // (consistent with sessions.id), not silently absent.
    previewColumns: [
      "id",
      "device_id",
      "token_hash",
      "name",
      "scopes",
      "created_at",
      "last_used_at",
    ],
    exampleQueries: [
      "SELECT name, scopes, last_used_at FROM tokens ORDER BY COALESCE(last_used_at, created_at) DESC",
      "SELECT name, created_at, last_used_at FROM tokens WHERE last_used_at IS NULL",
      "SELECT device_id, COUNT(*) AS n FROM tokens GROUP BY device_id ORDER BY n DESC",
    ],
  },
  {
    tableName: "sessions",
    displayName: "Portal sessions",
    description:
      "Cookie-based sessions for the web portal. One row per browser login. Created via POST /portal/api/login (token or pairing code) and expires after the cookie TTL.",
    columns: [
      {
        name: "id",
        type: "VARCHAR",
        description: "Internal non-secret row id for this portal session",
      },
      {
        name: "session_hash",
        type: "VARCHAR",
        description: "SHA-256 hash of the portal session cookie value",
        sensitive: true,
      },
      {
        name: "token_id",
        type: "VARCHAR",
        description: "Token that created the session (FK → tokens.id)",
      },
      {
        name: "scopes",
        type: "JSON",
        description: "JSON array of scopes, cloned from the token at login",
      },
      { name: "created_at", type: "INTEGER", description: "Login time (epoch ms)" },
      {
        name: "expires_at",
        type: "INTEGER",
        description: "When the session cookie expires (epoch ms)",
      },
    ],
    primaryKey: ["id"],
    previewColumns: ["id", "session_hash", "token_id", "scopes", "created_at", "expires_at"],
    exampleQueries: [
      "SELECT COUNT(*) AS active FROM sessions WHERE expires_at > unixepoch() * 1000",
      "SELECT s.id, t.name AS token, s.created_at, s.expires_at FROM sessions s JOIN tokens t ON t.id = s.token_id ORDER BY s.created_at DESC LIMIT 20",
    ],
  },
];

/** Lookup helper exposed for other modules (activity endpoint, etc). */
export function getSqliteTableDef(tableName: string): SqliteTableDef | undefined {
  return TABLE_DEFS.find((t) => t.tableName === tableName);
}

/**
 * All hand-authored tables with a live row count + (optional) date range
 * layered on top. Skips tables that don't exist in the current DB so the
 * catalog matches reality if migrations haven't run yet.
 *
 * Served from the materialized `catalog_table_stats` table — the scan-heavy
 * row-count + MIN/MAX queries run in the backfill worker (see
 * `refreshSqliteTableStats`). If a table isn't in the stats cache yet
 * (e.g. first boot before the worker's first pass), its numbers come back
 * as zero/null; the worker fills it in within seconds.
 */
export function getSqliteCatalog(db: Db): AnalyticsCatalogEntry[] {
  const existing = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name),
  );

  const statsRows = db
    .prepare("SELECT table_name, row_count, earliest_date, latest_date FROM catalog_table_stats")
    .all() as {
    table_name: string;
    row_count: number;
    earliest_date: string | null;
    latest_date: string | null;
  }[];
  const statsByName = new Map(statsRows.map((r) => [r.table_name, r]));

  return TABLE_DEFS.filter((t) => existing.has(t.tableName)).map((def) => {
    const cached = statsByName.get(def.tableName);
    if (cached) {
      return {
        tableName: def.tableName,
        displayName: def.displayName,
        description: def.description,
        sourceId: "gateway-sqlite",
        columns: def.columns,
        primaryKey: def.primaryKey,
        recordCount: cached.row_count,
        earliestDate: cached.earliest_date,
        latestDate: cached.latest_date,
        exampleQueries: def.exampleQueries,
      };
    }

    // Fallback for fresh DBs / tests where the backfill worker hasn't
    // filled the materialized row yet. Runs a live scan — cheap on an
    // empty/small table, and this path is only hit for at most a few
    // seconds after gateway boot in production before the worker seeds.
    const { recordCount, earliestDate, latestDate } = liveStats(db, def);
    return {
      tableName: def.tableName,
      displayName: def.displayName,
      description: def.description,
      sourceId: "gateway-sqlite",
      columns: def.columns,
      primaryKey: def.primaryKey,
      recordCount,
      earliestDate,
      latestDate,
      exampleQueries: def.exampleQueries,
    };
  });
}

/**
 * Recompute row counts + MIN/MAX timestamps for every known catalog table
 * and upsert them into catalog_table_stats. Call from the backfill worker —
 * some of these scans take 10s+.
 */
export function refreshSqliteTableStats(db: Db): void {
  const existing = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name),
  );

  const now = new Date().toISOString();
  for (const def of TABLE_DEFS) {
    if (!existing.has(def.tableName)) continue;
    const { recordCount, earliestDate, latestDate } = liveStats(db, def);
    db.prepare(
      `INSERT INTO catalog_table_stats (table_name, row_count, earliest_date, latest_date, last_computed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(table_name) DO UPDATE SET
         row_count = excluded.row_count,
         earliest_date = excluded.earliest_date,
         latest_date = excluded.latest_date,
         last_computed_at = excluded.last_computed_at`,
    ).run(def.tableName, recordCount, earliestDate, latestDate, now);
  }
}

/**
 * Detail view for one SQLite table — returns the catalog entry plus a
 * small preview of recent rows (using the hand-picked previewColumns +
 * timestampColumn where available).
 */
export function getSqliteTableInfo(
  db: Db,
  tableName: string,
): {
  catalog: AnalyticsCatalogEntry;
  sampleRows: unknown[][];
  sampleColumns: string[];
} | null {
  const def = getSqliteTableDef(tableName);
  if (!def) return null;

  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  if (!exists) return null;

  const catalog = getSqliteCatalog(db).find((e) => e.tableName === tableName);
  if (!catalog) return null;

  const previewCols = def.previewColumns ?? def.columns.map((c) => c.name);
  const orderBy = def.timestampColumn ? ` ORDER BY ${def.timestampColumn} DESC` : "";
  const rows = db
    .prepare(`SELECT ${previewCols.join(", ")} FROM ${tableName}${orderBy} LIMIT 20`)
    .all() as Record<string, unknown>[];

  // Mask credential material (session cookie values, token hashes) in the
  // preview rows so screenshots / screen-shares can't leak them. The
  // schema still lists the column with its description so users see it
  // exists and why it's hidden.
  const sensitiveCols = new Set(def.columns.filter((c) => c.sensitive).map((c) => c.name));
  const sampleRows = rows.map((row) =>
    previewCols.map((col) => (sensitiveCols.has(col) && row[col] != null ? REDACTED : row[col])),
  );

  return {
    catalog,
    sampleRows,
    sampleColumns: previewCols,
  };
}

const REDACTED = "<redacted>";

/**
 * Per-day row counts for the table's timestamp column, for the last
 * `days` days. Used by the Data view sparkline.
 */
export function getSqliteTableActivity(
  db: Db,
  tableName: string,
  days: number,
): { day: string; count: number }[] {
  const def = getSqliteTableDef(tableName);
  if (!def?.timestampColumn) return [];

  const col = def.timestampColumn;
  const rows = db
    .prepare(
      `SELECT DATE(${col}) AS day, COUNT(*) AS count
       FROM ${tableName}
       WHERE ${col} > datetime('now', ?)
       GROUP BY day
       ORDER BY day`,
    )
    .all(`-${days} days`) as { day: string; count: number }[];

  return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}

/**
 * Hard ceiling on rows returned by the user-SQL endpoint. Keeps an
 * unbounded `SELECT * FROM documents` from streaming hundreds of MB
 * of JSON to a portal/CLI client (and from blocking the writer
 * worker for the duration of the encode). The portal's "Run" button
 * defaults to `limit=1000` and the user can override up to this
 * ceiling — anything above it returns `truncated: true` plus the
 * first SQL_ROW_CAP rows so the user knows their query had more.
 */
export const SQL_ROW_CAP = 10_000;

export interface SqliteQueryResult {
  columns: string[];
  /** SQLite's declared column type — null for expressions / aliases. */
  columnTypes: (string | null)[];
  rows: unknown[][];
  rowCount: number;
  /** Wall-clock ms from prepare → fully materialised result. */
  timing: number;
  /** Set when the result was clipped at `SQL_ROW_CAP`. Undefined otherwise. */
  truncated?: boolean;
  /** Echo of `SQL_ROW_CAP` when `truncated`, for the portal "N+ rows" label. */
  rowCap?: number;
}

/**
 * Execute one read-only user SQL against the gateway's main SQLite
 * store and shape the result for a portal / CLI table view.
 *
 * Pre-fix this lived inline in `http/routes/analytics.ts:/sql`. The
 * route handler is a thin transport layer; the prepare / columns /
 * all / row-array reshape is the read-side equivalent of
 * `getSqliteCatalog` and belongs in the same place. The route now does only HTTP-shaped concerns
 * (authentication, the validation envelope, the BadRequest mapping
 * on a SQL parse / runtime error).
 *
 * `db` MUST be a read-only handle. better-sqlite3 enforces no
 * writes at the engine level when `readonly: true`, so any
 * INSERT / UPDATE / DELETE / DROP / ALTER / CREATE / TRUNCATE
 * (including ones smuggled through CTEs, leading comments,
 * multi-statement scripts, or PRAGMA writes) fails with
 * "attempt to write a readonly database". The mount point in
 * `routes/analytics.ts` opens the handle with `readonly: true` so
 * a test harness's writable test DB can't accidentally accept a
 * write through `/sql`.
 */
export function runSqliteQuery(db: Db, opts: { sql: string; limit?: number }): SqliteQueryResult {
  // Cap the per-query limit so a runaway SELECT can't exhaust the
  // gateway's heap. 100k is far above any interactive use; CLI
  // pipelines that need everything iterate in pages.
  const limit = Math.max(1, Math.min(opts.limit ?? 1000, 100_000));

  const start = Date.now();

  // Always wrap as a sub-query so a `LIMIT` literal embedded in a
  // string column or a WHERE clause can't fool a "does the query
  // already have a LIMIT" detector. SQLite tolerates
  // `SELECT * FROM (<original>) LIMIT N` for any SELECT.
  const trimmed = opts.sql.trim();
  const querySql = /\bLIMIT\b/i.test(trimmed)
    ? trimmed
    : `SELECT * FROM (${trimmed}) AS __q LIMIT ${limit}`;

  const stmt = db.prepare(querySql);
  const allRows = stmt.all() as Record<string, unknown>[];
  // Defense in depth: when the user wrote their own `LIMIT` we
  // didn't get a chance to clamp it before execution, so a query
  // like `SELECT * FROM huge LIMIT 5000000` would return 5M rows
  // through this endpoint. Cap the response at SQL_ROW_CAP and
  // surface `truncated` so the portal can render "N+ rows
  // (truncated)". The auto-LIMIT branch above keeps this a no-op
  // for the common case.
  const truncated = allRows.length > SQL_ROW_CAP;
  const rows = truncated ? allRows.slice(0, SQL_ROW_CAP) : allRows;
  const timing = Date.now() - start;

  const colInfo = stmt.columns();
  const columns: string[] =
    colInfo.length > 0 ? colInfo.map((c) => c.name) : rows.length > 0 ? Object.keys(rows[0]) : [];
  const columnTypes: (string | null)[] =
    colInfo.length > 0 ? colInfo.map((c) => c.type ?? null) : columns.map(() => null);

  const rowArrays = rows.map((row) => columns.map((col) => row[col]));

  const result: SqliteQueryResult = {
    columns,
    columnTypes,
    rows: rowArrays,
    rowCount: rows.length,
    timing,
  };
  if (truncated) {
    result.truncated = true;
    result.rowCap = SQL_ROW_CAP;
  }
  return result;
}

// --- internals -------------------------------------------------------------

function liveStats(
  db: Db,
  def: SqliteTableDef,
): {
  recordCount: number;
  earliestDate: string | null;
  latestDate: string | null;
} {
  const countRow = db.prepare(`SELECT COUNT(*) AS n FROM ${def.tableName}`).get() as
    | { n: number | bigint }
    | undefined;
  const recordCount = Number(countRow?.n ?? 0);

  let earliestDate: string | null = null;
  let latestDate: string | null = null;
  if (def.timestampColumn && recordCount > 0) {
    try {
      const row = db
        .prepare(
          `SELECT MIN(${def.timestampColumn}) AS earliest, MAX(${def.timestampColumn}) AS latest FROM ${def.tableName}`,
        )
        .get() as { earliest: string | null; latest: string | null } | undefined;
      earliestDate = row?.earliest ?? null;
      latestDate = row?.latest ?? null;
    } catch {
      /* timestampColumn might not exist yet (migration in progress) */
    }
  }

  return { recordCount, earliestDate, latestDate };
}
