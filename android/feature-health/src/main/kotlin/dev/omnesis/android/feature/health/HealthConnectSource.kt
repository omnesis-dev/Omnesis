// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.os.RemoteException
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.changes.Change
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import dev.omnesis.android.transport.dto.AnalyticsTableSchema
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.reflect.KClass
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement

/**
 * The stretch of one record type's history a sync can be stuck on, and so the
 * smallest thing it can give up on: a baseline read of the type's whole
 * history, or the changes one `getChanges` response carried. [token] is the
 * changes token that response was requested with — null for a baseline.
 *
 * Giving up per type is what keeps one type's refusal from starving the rest:
 * the catalog is walked in order, so a type that aborts the pass takes every
 * type after it down with it.
 */
data class HealthSyncUnit(val typeName: String, val token: String?) {
    /**
     * Stable while the sync is stuck on this unit: a refused unit is re-read
     * from the same token on every pass, so the key names the same unit until
     * something moves past it.
     */
    val key: String get() = "$typeName@${token ?: "baseline"}"

    val description: String get() = if (token == null) {
        "$typeName — the type's full history"
    } else {
        "$typeName — one batch of changes"
    }
}

/**
 * One page of normalized rows and/or deletion tombstones for one `hc_*` table —
 * the unit the uploader turns into a `POST /analytics/ingest` body.
 * `records.size + deletedIds.size` never exceeds the source's page size.
 * [unit] is the stretch of history the page came from, so the uploader can
 * count a refusal against something that outlives this pass.
 */
data class HealthPage(
    val tableName: String,
    val schema: AnalyticsTableSchema,
    val records: List<Map<String, JsonElement>>,
    val unit: HealthSyncUnit,
    val deletedIds: List<String> = emptyList(),
    val deleteKeyColumn: String? = null,
)

/**
 * Thrown by the page callback when it has given up on the page's [unit]. The
 * sync then advances that type's cursor past the unit and carries on with the
 * rest of the catalog, instead of aborting the pass the way any other failure
 * does.
 */
class HealthPageGivenUpException(val unit: HealthSyncUnit) :
    Exception("gave up on ${unit.key}")

/** Result of one [HealthConnectSource.sync] pass. */
data class SyncOutcome(
    val cursor: HealthCursor,
    val upserted: Int,
    val deleted: Int,
    /** Catalog names skipped this pass (permission missing, category disabled, or revoked mid-sync). */
    val skipped: List<String>,
    /** Provider reads that failed; these types retain their cursor for retry. */
    val failed: List<String> = emptyList(),
)

/**
 * Thrown when a sync pass aborts on an unexpected error (Binder failure, I/O).
 * Carries the cursor with every token advanced *before* the failure so the
 * caller can persist it — pages already emitted stay valid (row ids are stable,
 * a re-send dedups via primary-key upsert).
 */
class HealthSyncException(
    val cursor: HealthCursor,
    val upserted: Int,
    val deleted: Int,
    cause: Throwable,
) : Exception("Health Connect sync aborted: ${cause.message}", cause)

/**
 * The Health Connect sync engine: walks [HealthTypeCatalog] in order and emits
 * [HealthPage]s of normalized rows, tracking per-type incremental state with the
 * Changes API.
 *
 * Per type, in catalog order:
 *  - Disabled category or missing read permission (re-checked every pass) →
 *    type is skipped, cursor untouched.
 *  - No token yet → BASELINE: grab a changes token *first* (so writes landing
 *    during the read aren't missed), then page through every record from epoch
 *    to now, then persist the token.
 *  - Token present → DELTA: drain `getChanges`, emitting each response's net
 *    effect as it arrives (nothing buffers across responses). Within a
 *    response, changes fold last-state-wins — an upsert of a record cancels
 *    its pending deletion and vice versa — and records written by
 *    [selfPackageName] are dropped (they'd be echoes of our own writes). For
 *    tables with a deletion key, every response's row pages are preceded by a
 *    tombstone-only page deleting the upserted record ids, so fanned-out rows
 *    from a previous, larger version of a record can't linger. The advanced
 *    token persists only after the full drain. An expired token re-baselines
 *    the type — existing rows dedup via PK upsert; deletions that happened
 *    during the blind window are accepted as lost (the Changes API has no
 *    replay past expiry).
 *  - SecurityException mid-sync → the type is skipped; its token is dropped
 *    only if the read permission is confirmed gone (a background read without
 *    the background-read grant throws the same exception and must keep it).
 *  - A [HealthPageGivenUpException] from the page callback advances the type
 *    past the refused unit — the baseline's own token, or the token after the
 *    refused changes response — and the walk continues with the next type.
 *  - A provider [RemoteException] that cannot recover through a baseline
 *    records the failed type, retains its token, and lets other types sync.
 *  - Any other failure aborts the pass with a [HealthSyncException] carrying
 *    the partially-advanced cursor.
 */
class HealthConnectSource(
    private val client: HealthConnectClient,
    private val accountId: String,
    private val selfPackageName: String,
    private val settings: HealthSettings,
    private val clock: () -> Instant = Instant::now,
    private val pageSize: Int = 500,
) {
    companion object {
        const val SOURCE_TYPE = "health-connect"
        const val ACCOUNT_ID_LOCAL = "local"

        // Backoff for Health Connect's request-rate quota (see withRateLimitRetry).
        private const val RATE_LIMIT_BASE_DELAY_MS = 1_000L
        private const val RATE_LIMIT_MAX_DELAY_MS = 30_000L
        private const val RATE_LIMIT_MAX_RETRIES = 8
    }

    suspend fun sync(cursor: HealthCursor, onPage: suspend (HealthPage) -> Unit): SyncOutcome {
        var current = cursor
        var upserted = 0
        var deleted = 0
        val skipped = mutableListOf<String>()
        val failed = mutableListOf<String>()

        val enabledCategories = settings.enabledCategories
        val granted = withRateLimitRetry { client.permissionController.getGrantedPermissions() }

        for (entry in HealthTypeCatalog.entries) {
            val category = HealthCategory.fromTableName(entry.tableName)
            if (category != null && category !in enabledCategories) {
                skipped += entry.name
                continue
            }
            // A permission missing here keeps the token: a later re-grant
            // resumes via changes replay (or re-baselines on token expiry).
            // Only the mid-flight SecurityException below, once confirmed as a
            // real revocation, drops the token.
            if (HealthTypeCatalog.readPermissionFor(entry) !in granted) {
                skipped += entry.name
                continue
            }

            try {
                val result = syncEntry(entry, current, onPage)
                current = result.cursor
                upserted += result.upserted
                deleted += result.deleted
            } catch (e: CancellationException) {
                throw e
            } catch (e: SecurityException) {
                // Health Connect throws SecurityException both for a real
                // revocation and for a background read without the
                // background-read grant. Re-check the grant to tell them
                // apart: only a confirmed revocation drops the token (so a
                // future re-grant starts from a fresh baseline); otherwise
                // the type keeps its token for the next foreground pass.
                skipped += entry.name
                val stillGranted = withRateLimitRetry { client.permissionController.getGrantedPermissions() }
                if (HealthTypeCatalog.readPermissionFor(entry) !in stillGranted) {
                    current = current.withToken(entry.name, null)
                }
            } catch (e: UnsupportedOperationException) {
                // The device's Health Connect module can't serve this record
                // type at all (a record class newer than the installed module).
                // Skip the type and keep its token; a provider update may start
                // serving it.
                skipped += entry.name
            } catch (e: LinkageError) {
                // Same failure surfaced at class-link time: the platform-backed
                // client references hidden/absent framework methods for record
                // types newer than the device's module (seen with
                // MindfulnessSessionRecord on the API 35 image). Per-type, not
                // fatal — skip and continue with the remaining types.
                skipped += entry.name
            } catch (e: RemoteException) {
                // The Health Connect provider hit an INTERNAL error serving this
                // type's read — e.g. its "while parsing a protocol message, the
                // input ended unexpectedly" protobuf failure (observed for
                // WeightRecord on some devices, likely from data another app wrote
                // into Health Connect). It's specific to this record type, so skip
                // it and keep going so a failing type does not starve the healthy
                // types on every retry. The type is reported
                // in the returned `failed` list; the token is left untouched, so a
                // later provider/data change re-attempts it.
                Log.w("Omnesis:health", "Health Connect provider failed to read ${entry.name}; skipping this type: ${e.message}")
                failed += entry.name
            } catch (e: Exception) {
                throw HealthSyncException(current, upserted, deleted, e)
            }
        }

        // lastFullSyncAt moves only when at least one type actually synced
        // and no provider read failed; partial progress is not a full success.
        // A skipped type can still change the cursor (a confirmed revocation
        // drops its token), so callers must elide the sync-state write on
        // cursor EQUALITY, not on the all-skipped condition.
        if (failed.isEmpty() && skipped.size < HealthTypeCatalog.entries.size) {
            current = current.copy(lastFullSyncAt = HealthNormalizer.isoUtcMillis(clock()))
        }
        return SyncOutcome(current, upserted, deleted, skipped, failed)
    }

    private data class EntryResult(val cursor: HealthCursor, val upserted: Int, val deleted: Int)

    /**
     * Runs a Health Connect read, retrying with exponential backoff when the provider
     * rejects it for exceeding its request-rate quota. Reading the whole catalogue
     * (every record type, paged) on a data-rich device blows past Health Connect's
     * per-app rate limit; the provider then throws a [RemoteException] whose message
     * says the quota was exceeded, and the only remedy is to wait for it to replenish.
     * We back off and retry the SAME call rather than skipping the type, so a busy
     * provider just slows the sync instead of dropping data. Non-rate-limit errors
     * (e.g. the "parsing a protocol message" internal error) propagate immediately so
     * their own handling (re-baseline / skip) still applies.
     */
    private suspend fun <T> withRateLimitRetry(block: suspend () -> T): T {
        var delayMs = RATE_LIMIT_BASE_DELAY_MS
        var attempt = 0
        while (true) {
            try {
                return block()
            } catch (e: RemoteException) {
                if (!isRateLimited(e) || attempt >= RATE_LIMIT_MAX_RETRIES) throw e
                attempt++
                Log.w("Omnesis:health", "Health Connect rate-limited; backing off ${delayMs}ms (attempt $attempt)")
                delay(delayMs)
                delayMs = (delayMs * 2).coerceAtMost(RATE_LIMIT_MAX_DELAY_MS)
            }
        }
    }

    private fun isRateLimited(e: RemoteException): Boolean {
        val m = e.message ?: return false
        return m.contains("rate limit", ignoreCase = true) || m.contains("quota", ignoreCase = true)
    }

    private suspend fun syncEntry(
        entry: CatalogEntry,
        cursor: HealthCursor,
        onPage: suspend (HealthPage) -> Unit,
    ): EntryResult {
        val token = cursor.tokenFor(entry.name)
            ?: return baseline(entry, cursor, onPage)

        var nextToken = token
        var upserted = 0
        var deleted = 0
        while (true) {
            val requestToken = nextToken
            val response = try {
                withRateLimitRetry { client.getChanges(requestToken) }
            } catch (e: RemoteException) {
                // Some Health Connect providers throw an internal error ("while
                // parsing a protocol message…") serving getChanges for a type even
                // though readRecords works fine for it. Recover exactly like an
                // expired token: drop the broken delta and re-read the type from
                // scratch via baseline (which doesn't hit the bug). Rows dedup by
                // primary key on re-ingest, so no duplication. If baseline ALSO
                // throws, it propagates to the per-type skip in sync().
                val rebaselined = baseline(entry, cursor, onPage)
                return EntryResult(rebaselined.cursor, upserted + rebaselined.upserted, deleted)
            }
            if (response.changesTokenExpired) {
                // The provider GC'd this token; replay is impossible. Pages
                // already emitted from earlier responses in this drain stay
                // valid — their rows dedup by primary key and their deletions
                // have been delivered. Re-baseline the type: re-read rows
                // dedup the same way, but deletions made during the blind
                // window (between the expired token and now) are lost until
                // the records age out.
                val rebaselined = baseline(entry, cursor, onPage)
                return EntryResult(rebaselined.cursor, upserted + rebaselined.upserted, deleted)
            }
            val folded = fold(response.changes)
            try {
                emitDelta(entry, folded, HealthSyncUnit(entry.name, requestToken), onPage)
            } catch (e: HealthPageGivenUpException) {
                // The uploader gave up on this response's changes. Resume from
                // the token that follows it: everything after this response
                // still syncs, and only what this one carried is lost.
                Log.w("Omnesis:health", "Skipping ${e.unit.key} — the gateway refused it and the run is spent")
                return EntryResult(cursor.withToken(entry.name, response.nextChangesToken), upserted, deleted)
            }
            upserted += folded.upserts.values.sumOf { it.size }
            deleted += folded.deletions.size
            nextToken = response.nextChangesToken
            if (!response.hasMore) break
        }

        return EntryResult(cursor.withToken(entry.name, nextToken), upserted, deleted)
    }

    /** Net effect of one `getChanges` response after a last-state-wins fold. */
    private class FoldedChanges {
        /** Normalized rows per upserted record id, in first-seen order. */
        val upserts = LinkedHashMap<String, List<Map<String, JsonElement>>>()

        /** Record ids whose final state in the response is deleted, in first-seen order. */
        val deletions = LinkedHashSet<String>()
    }

    /**
     * Folds one response's changes in order so only each record's final state
     * is emitted: an upsert of a record cancels its pending deletion and vice
     * versa. Upserts written by [selfPackageName] are echoes of our own writes
     * — they contribute no rows.
     */
    private fun fold(changes: List<Change>): FoldedChanges {
        val folded = FoldedChanges()
        for (change in changes) {
            when (change) {
                is UpsertionChange -> {
                    val id = change.record.metadata.id
                    folded.deletions.remove(id)
                    if (change.record.metadata.dataOrigin.packageName == selfPackageName) {
                        folded.upserts.remove(id)
                    } else {
                        folded.upserts[id] = HealthNormalizer.normalize(change.record, accountId)
                    }
                }
                is DeletionChange -> {
                    folded.upserts.remove(change.recordId)
                    folded.deletions += change.recordId
                }
            }
        }
        return folded
    }

    /**
     * Emits one response's net effect. Upserts re-ingest by primary key, but
     * fanned-out row ids are suffix-derived from the record — when an app
     * rewrites a record with fewer samples/stages/nutrients, the surplus rows
     * of the previous version would survive a plain re-upsert. For tables with
     * a deletion key, tombstone-only pages deleting every upserted record id
     * therefore go out FIRST (on their own pages: the gateway applies deletes
     * after upserts within one body), then the fresh rows. For a fresh insert
     * the pre-delete is an idempotent no-op.
     */
    private suspend fun emitDelta(
        entry: CatalogEntry,
        folded: FoldedChanges,
        unit: HealthSyncUnit,
        onPage: suspend (HealthPage) -> Unit,
    ) {
        if (HealthTypeCatalog.deleteKeyColumnFor(entry.tableName) != null && folded.upserts.isNotEmpty()) {
            for (chunk in folded.upserts.keys.chunked(pageSize)) {
                onPage(page(entry, records = emptyList(), unit = unit, deletedIds = chunk))
            }
        }
        emitPages(entry, folded.upserts.values.flatten(), folded.deletions.toList(), unit, onPage)
    }

    private suspend fun baseline(
        entry: CatalogEntry,
        cursor: HealthCursor,
        onPage: suspend (HealthPage) -> Unit,
    ): EntryResult {
        // Token before read: anything written while we page through history shows
        // up in the first delta sync instead of falling into a gap.
        val token = withRateLimitRetry { client.getChangesToken(ChangesTokenRequest(setOf(entry.recordType))) }
        val unit = HealthSyncUnit(entry.name, token = null)

        var upserted = 0
        try {
            readHistory(entry, unit) { emitted ->
                onPage(emitted)
                upserted += emitted.records.size
            }
        } catch (e: HealthPageGivenUpException) {
            // The uploader gave up on this type's history. The token was taken
            // before the read, so adopting it here leaves the type syncing
            // normally from now on — only the history behind it is lost.
            Log.w("Omnesis:health", "Skipping ${e.unit.key} — the gateway refused it and the run is spent")
        }

        return EntryResult(cursor.withToken(entry.name, token), upserted, 0)
    }

    /** Pages [entry]'s whole history to [onPage], oldest read first. */
    private suspend fun readHistory(
        entry: CatalogEntry,
        unit: HealthSyncUnit,
        onPage: suspend (HealthPage) -> Unit,
    ) {
        // One fixed end bound for the whole read: a page token is only valid
        // against the filter it was issued for.
        val end = clock()

        val buffer = mutableListOf<Map<String, JsonElement>>()
        // Guard against providers that never return a null page token (or keep
        // re-yielding the same page) — without it the read loops forever, which on
        // top of being wrong floods the provider and trips its rate limiter. We stop
        // as soon as a page makes no forward progress: zero records, no record id we
        // haven't already seen, or a page token identical to the one we just sent.
        val seenIds = HashSet<String>()
        var pageToken: String? = null
        do {
            @Suppress("UNCHECKED_CAST")
            val response = withRateLimitRetry {
                client.readRecords(
                    ReadRecordsRequest(
                        recordType = entry.recordType as KClass<Record>,
                        timeRangeFilter = TimeRangeFilter.between(Instant.EPOCH, end),
                        pageSize = pageSize,
                        pageToken = pageToken,
                    ),
                )
            }
            var freshInPage = 0
            for (record in response.records) {
                if (!seenIds.add(record.metadata.id)) continue
                freshInPage++
                if (record.metadata.dataOrigin.packageName == selfPackageName) continue
                buffer += HealthNormalizer.normalize(record, accountId)
            }
            while (buffer.size >= pageSize) {
                val chunk = buffer.subList(0, pageSize).toList()
                buffer.subList(0, pageSize).clear()
                onPage(page(entry, chunk, unit))
            }
            val next = response.pageToken
            if (response.records.isEmpty() || freshInPage == 0 || next == pageToken) break
            pageToken = next
        } while (pageToken != null)

        if (buffer.isNotEmpty()) {
            onPage(page(entry, buffer.toList(), unit))
        }
    }

    /** Chunk rows + deletions into pages of at most [pageSize] combined items. */
    private suspend fun emitPages(
        entry: CatalogEntry,
        rows: List<Map<String, JsonElement>>,
        deletions: List<String>,
        unit: HealthSyncUnit,
        onPage: suspend (HealthPage) -> Unit,
    ) {
        var rowIdx = 0
        var delIdx = 0
        while (rowIdx < rows.size || delIdx < deletions.size) {
            val chunkRows = rows.subList(rowIdx, minOf(rows.size, rowIdx + pageSize))
            val capacity = pageSize - chunkRows.size
            val chunkDeletions = if (capacity > 0 && delIdx < deletions.size) {
                deletions.subList(delIdx, minOf(deletions.size, delIdx + capacity))
            } else {
                emptyList()
            }
            onPage(page(entry, chunkRows.toList(), unit, chunkDeletions.toList()))
            rowIdx += chunkRows.size
            delIdx += chunkDeletions.size
        }
    }

    private fun page(
        entry: CatalogEntry,
        records: List<Map<String, JsonElement>>,
        unit: HealthSyncUnit,
        deletedIds: List<String> = emptyList(),
    ): HealthPage = HealthPage(
        tableName = entry.tableName,
        schema = HealthSchemas.forTable(entry.tableName),
        records = records,
        unit = unit,
        deletedIds = deletedIds,
        deleteKeyColumn = if (deletedIds.isEmpty()) null else HealthTypeCatalog.deleteKeyColumnFor(entry.tableName),
    )
}
