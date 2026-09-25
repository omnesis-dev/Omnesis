// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Wire DTOs for the gateway's structured-analytics surface:
 *
 *   POST /analytics/ingest        — upsert rows (+ apply tombstones) into a DuckDB table
 *   GET/POST /sync-state/:id      — persist the source's opaque cursor between syncs
 *
 * Gateway reference: `packages/gateway/src/http/schemas/analytics.ts`
 * (`analyticsIngestBody`) and `AnalyticsService.ingest`. The schema shape mirrors
 * `AnalyticsTableSchema` in `packages/source-sdk/src/structured-source.ts` — the
 * gateway CREATEs the table from the schema on first sight and evolves it on
 * later pages, so every page attaches it.
 */

/** One column of an analytics table. `type` is a DuckDB column type (VARCHAR, DOUBLE, TIMESTAMPTZ, INTEGER, JSON, ...). */
@Serializable
data class AnalyticsColumn(
    val name: String,
    val type: String,
    val description: String,
    val nullable: Boolean? = null,
    /**
     * Exhaustive provider-owned values for a closed VARCHAR domain. This is
     * source-schema metadata and must never be sampled from the user's rows.
     */
    val allowedValues: List<String>? = null,
    /** Known exact values for an open/extensible VARCHAR vocabulary. Non-exhaustive. */
    val canonicalValues: List<String>? = null,
    /** Source-owned human phrases keyed by exact categorical wire value. */
    val valueAliases: Map<String, List<String>>? = null,
    /** `series` marks the logical series selector in a tall table. */
    val categoricalRole: String? = null,
    /**
     * What this column's value identifies, so a client can render it as a
     * link to the corresponding page instead of plain text — `"document"`,
     * `"person"`, `"source"`, or `"url"`. Mirrors `ColumnReference` in
     * `packages/source-sdk/src/structured-source.ts`.
     */
    val references: String? = null,
)

/**
 * How to render one row of a table when it is cited as a record. Mirrors
 * `RecordDisplaySpec` in `packages/source-sdk/src/structured-source.ts`:
 * `titleColumns` (optionally joined via a `{column}` `titleTemplate`) compose the
 * row's title; `keyColumns` are surfaced as its key fields. Both must be non-empty
 * and name columns declared on the table.
 */
@Serializable
data class RecordDisplaySpec(
    val titleColumns: List<String>,
    val titleTemplate: String? = null,
    val keyColumns: List<String>,
)

/**
 * A DuckDB table declaration the source owns. Primary key is mandatory — ingest is
 * at-least-once. `semanticTimeColumn` names the real-world event-time column a
 * record citation is placed at on a timeline — `start_time` for every
 * `hc_*` table — and `record` declares how to render a single row when cited.
 */
@Serializable
data class AnalyticsTableSchema(
    val tableName: String,
    val displayName: String,
    val description: String,
    val columns: List<AnalyticsColumn>,
    val primaryKey: List<String>,
    /**
     * The columns a deletion or a snapshot names one of this table's rows by.
     * Omitted, the primary key answers. A tall table that fans one upstream
     * record into several rows declares the column they share, which says that
     * naming the record removes all of them — the unit the upstream deletes by.
     */
    val deleteKey: List<String>? = null,
    val exampleQueries: List<String>? = null,
    val semanticTimeColumn: String? = null,
    val record: RecordDisplaySpec? = null,
)

/**
 * `POST /analytics/ingest`. One request == one page of one table. `records` are
 * upserted by primary key; `deletedIds` are tombstones applied after the upserts
 * (Health Connect's Changes API reports deletions by record id). Which columns
 * a tombstone matches on is the TABLE's declaration (`AnalyticsTableSchema.deleteKey`),
 * so a tall table whose rows share their parent record's id is deleted by that
 * record. `deleteKeyColumn` says the same thing per page and is kept for a
 * gateway that predates the declaration.
 */
@Serializable
data class AnalyticsIngestBody(
    val tableName: String,
    val records: List<Map<String, JsonElement>>,
    val schema: AnalyticsTableSchema? = null,
    val sourceId: String? = null,
    val deletedIds: List<String>? = null,
    val deleteKeyColumn: String? = null,
)

@Serializable
data class AnalyticsIngestResponse(
    val ingested: Int = 0,
    val deleted: Int = 0,
    /**
     * Per-source rejections. The gateway accepts the request (HTTP 200) but
     * declines to write a source that was **removed** or **paused** in Omnesis,
     * reporting it here. Absent on the success path → defaults to empty.
     */
    val rejected: List<PushRejection> = emptyList(),
)

/** One per-source rejection in a push response. `reason` is `"removed"`/`"paused"`. */
@Serializable
data class PushRejection(
    val sourceId: String,
    val reason: String,
)

/**
 * `GET`/`POST /sync-state/:sourceId`. The cursor is opaque to the gateway — it
 * persists whatever JSON object the device posts and hands it back on GET.
 * `label`/`icon` ride along so a device-hosted source (no collector provider
 * package) can supply its display name and icon, exactly as iOS does for
 * Apple Health.
 *
 * `family` is the identity of the source's TYPE rather than this account's,
 * for a client that groups a corpus by family. It has no default: a family
 * derived from whichever account happened to push last is how a source that
 * names each account after its institution ends up naming the family after
 * one of them. A source that declares none simply has none.
 */
@Serializable
data class SyncStateBody(
    val cursor: JsonElement,
    val label: String? = null,
    val icon: String? = null,
    val family: SourceFamilyBody? = null,
)

/** See [SyncStateBody.family]. */
@Serializable
data class SourceFamilyBody(
    val label: String? = null,
    val icon: String? = null,
)

@Serializable
data class SyncStateResponse(
    val cursor: JsonElement? = null,
    val lastSyncedAt: String? = null,
    val hasMore: Boolean? = null,
)

/**
 * Request body for `POST /admin/sources` — registers a source row bound to this
 * device. `enabled` carries no default so it always serializes (OmnesisJson omits
 * default-valued fields), matching the explicit body iOS sends.
 */
@Serializable
data class CreateSourceBody(
    val type: String,
    val accountId: String,
    val deviceId: String,
    val enabled: Boolean,
)
