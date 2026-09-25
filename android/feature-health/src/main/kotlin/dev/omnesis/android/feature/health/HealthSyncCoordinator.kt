// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import android.util.Log
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.transport.DeliveryEvidence
import dev.omnesis.android.transport.DeliveryReporter
import dev.omnesis.android.transport.GatewayFailureKind
import dev.omnesis.android.transport.gatewayConnectionAdvice
import dev.omnesis.android.transport.RetryOutcome
import dev.omnesis.android.transport.classifyGatewayFailure
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.dto.AnalyticsIngestBody
import dev.omnesis.android.transport.dto.SourceFamilyBody
import dev.omnesis.android.transport.dto.SyncStateBody
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Orchestrates one device-hosted Health Connect source against the gateway —
 * the Android analogue of the iOS SyncCoordinator + Uploader pair, collapsed
 * into one class because pages upload inline (no offline buffer):
 *
 * Explicit source registration is owned by the membership coordinator.
 * [syncNow] drains [HealthConnectSource] page-by-page into
 *     `POST /analytics/ingest`, persisting the Changes-API cursor on
 *     `/sync-state/health-connect:local` and broadcasting `sync.status` device
 *     events (same payload shape as the iOS `forwardLifecycle` emitter) so the
 *     fleet sees the sync live.
 *
 * A page the gateway answers and refuses reproduces its refusal on every pass,
 * and the catalog is walked in order — so an undeliverable page aborts the
 * pass with its type's cursor unadvanced, and every type after it in the
 * catalog starves for as long as that lasts. [giveUpOrRethrow] counts those
 * refusals durably against the [HealthSyncUnit] they belong to and, once the
 * run has both spent its budget and outlived the grace window, gives up on
 * that one unit — the type resumes from a later cursor, the rest of the
 * catalog syncs, and a marker records what was skipped. Transient failures
 * never count, however long they last.
 *
 * Concurrent [syncNow] calls coalesce: a call landing while a drain is in
 * flight awaits that drain's result instead of starting another.
 */
class HealthSyncCoordinator(
    private val sourceFactory: () -> HealthConnectSource,
    private val analytics: AnalyticsClient,
    private val settings: HealthSettings,
    private val availability: () -> HealthConnectAvailability,
    private val sendEvent: (String, JsonObject) -> Unit,
    private val clock: () -> Instant = Instant::now,
) : DeliveryReporter {
    enum class FailureOrigin { GATEWAY, SOURCE_READ }

    /** Terminal state of one [syncNow] call. */
    sealed interface SyncResult {
        /** Drain completed; [processed] counts uploaded rows + deletion tombstones. */
        data class Success(val processed: Int) : SyncResult

        /** Gates not met (feature disabled or Health Connect unavailable); nothing ran. */
        data class Skipped(val reason: String) : SyncResult

        /** Auth failure (401/403) — retrying won't help; the user must re-pair. */
        data class NeedsAttention(val message: String) : SyncResult

        /**
         * Drain aborted. [retryable] is false only when the gateway answered
         * and refused the payload — see [classifyGatewayFailure].
         */
        data class Failed(
            val message: String,
            val retryable: Boolean,
            val origin: FailureOrigin = FailureOrigin.GATEWAY,
        ) : SyncResult

        /**
         * The source was REMOVED in Omnesis. The gateway rejects its pushes and
         * won't resurrect it, so syncing is disabled locally (re-opt-in to
         * resume). Terminal — the worker stops, the UI reflects it.
         */
        data class SourceRemoved(val message: String) : SyncResult

        /**
         * The source is PAUSED in Omnesis. Pushes are declined but the source
         * still exists; the not-yet-accepted page is left for re-send so no data
         * is lost. Retryable — a later pass succeeds once it's resumed.
         */
        data class SourcePaused(val message: String) : SyncResult
    }

    /** Thrown from the page callback when the gateway rejects this source. */
    private class SourceRejectedException(val reason: String) :
        Exception("source rejected: $reason")

    companion object {
        const val SOURCE_ID =
            "${HealthConnectSource.SOURCE_TYPE}:${HealthConnectSource.ACCOUNT_ID_LOCAL}"
        const val SOURCE_LABEL = "Health Connect"
    }

    private val inFlightLock = Any()
    private var inFlight: CompletableDeferred<SyncResult>? = null




    /**
     * Runs one full sync pass, serialized: the first caller owns the drain and
     * later callers awaiting concurrently get the owner's result. Never throws
     * (besides cancellation) — every failure classifies into a [SyncResult].
     */
    suspend fun syncNow(): SyncResult {
        val mine: CompletableDeferred<SyncResult>
        val owner: Boolean
        synchronized(inFlightLock) {
            val existing = inFlight
            if (existing != null) {
                mine = existing
                owner = false
            } else {
                mine = CompletableDeferred()
                inFlight = mine
                owner = true
            }
        }
        if (!owner) return mine.await()
        try {
            val result = runSync()
            mine.complete(result)
            return result
        } catch (t: Throwable) {
            // Only cancellation escapes runSync; joiners see it too.
            mine.completeExceptionally(t)
            throw t
        } finally {
            synchronized(inFlightLock) { if (inFlight === mine) inFlight = null }
        }
    }

    /** Whether a pass already owns the drain. */
    private val syncInFlight: Boolean
        get() = synchronized(inFlightLock) { inFlight != null }

    override suspend fun deliveryEvidence(): DeliveryEvidence = DeliveryEvidence(
        sourceId = SOURCE_ID,
        blocked = settings.pushRefusals.blocked,
        skipped = settings.pushRefusals.skipped,
    )

    /**
     * A retry does not join a pass that is already running: that pass started
     * before the tap, and reporting its outcome would answer a question the
     * user did not ask.
     */
    override suspend fun retryDelivery(): RetryOutcome {
        if (syncInFlight) return RetryOutcome.BUSY
        return syncNow().toRetryOutcome()
    }

    /**
     * Records are read from Health Connect rather than copied into the app, so
     * there is nothing here to delete — only the record of which record types
     * syncing moved past, which is what would have told the user a re-sync was
     * worth running.
     */
    override suspend fun discardUndelivered() {
        settings.pushRefusals.clearSkipped()
    }

    /**
     * What one pass amounted to for the delivery surface. A pass that never
     * ran — the source is off, unpermitted, paused, or gone from the gateway —
     * left nothing undelivered, so it reads as "nothing was waiting" rather
     * than as a failure.
     */
    private fun SyncResult.toRetryOutcome(): RetryOutcome = when (this) {
        is SyncResult.Success -> if (processed > 0) RetryOutcome.DELIVERED else RetryOutcome.IDLE
        is SyncResult.Failed -> when (origin) {
            FailureOrigin.SOURCE_READ -> RetryOutcome.INCOMPLETE
            FailureOrigin.GATEWAY -> if (retryable) RetryOutcome.UNREACHABLE else RetryOutcome.REFUSED
        }
        is SyncResult.NeedsAttention -> RetryOutcome.FAILED
        is SyncResult.Skipped, is SyncResult.SourceRemoved, is SyncResult.SourcePaused -> RetryOutcome.IDLE
    }

    private suspend fun runSync(): SyncResult {
        if (!settings.healthConnectEnabled) {
            return SyncResult.Skipped("Health Connect syncing is disabled")
        }
        val avail = availability()
        if (avail != HealthConnectAvailability.Available) {
            return SyncResult.Skipped("Health Connect is not available: $avail")
        }

        emitStatus {
            put("state", "syncing")
            put("startedAt", clock().toEpochMilli())
        }

        var processed = 0
        try {
            val existing = analytics.getSyncState(SOURCE_ID)
            val loaded = HealthCursor.fromJsonElement(existing?.cursor)

            val outcome = sourceFactory().sync(loaded) { page ->
                val resp = try {
                    analytics.ingest(
                        AnalyticsIngestBody(
                            tableName = page.tableName,
                            records = page.records,
                            schema = page.schema,
                            sourceId = SOURCE_ID,
                            deletedIds = page.deletedIds.ifEmpty { null },
                            deleteKeyColumn = page.deleteKeyColumn,
                        ),
                    )
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (classifyGatewayFailure(e) == GatewayFailureKind.PERMANENT) giveUpOrRethrow(page.unit, e)
                    throw e
                }
                // The gateway can accept the request (200) yet decline this
                // source (removed/paused). Stop the drain so the page isn't
                // counted as processed — its cursor won't advance, so a paused
                // source re-sends it on resume.
                resp.rejected.firstOrNull { it.sourceId == SOURCE_ID }?.let {
                    throw SourceRejectedException(it.reason)
                }
                settings.pushRefusals.clearRun(page.unit.key)
                settings.pushRefusals.blocked = false
                processed += page.records.size + page.deletedIds.size
            }
            if (outcome.skipped.isNotEmpty()) {
                Log.i("Omnesis:health", "sync skipped ${outcome.skipped.size} type(s): ${outcome.skipped}")
            }

            // Elide the write only when nothing moved AND a state row already
            // exists — the first pass always writes so the gateway learns the
            // source's label/icon even if every type was skipped.
            if (!(existing != null && outcome.cursor == loaded)) {
                persistCursor(outcome.cursor)
            }

            if (outcome.failed.isNotEmpty()) {
                val message = "Health Connect could not read: ${outcome.failed.joinToString()}. " +
                    "Successfully read data was saved. Try syncing again."
                emitStatus {
                    put("state", "error")
                    put("errorMessage", message)
                    putJsonObject("progress") { put("processed", processed) }
                }
                return SyncResult.Failed(message, retryable = true, origin = FailureOrigin.SOURCE_READ)
            }

            emitStatus {
                put("state", "completed")
                put("completedAt", clock().toEpochMilli())
                putJsonObject("progress") { put("processed", processed) }
            }
            return SyncResult.Success(processed)
        } catch (e: CancellationException) {
            throw e
        } catch (e: HealthSyncException) {
            // A rejection thrown from the page callback arrives wrapped with the
            // partial cursor (pages up to — but not including — the rejected
            // one). Handle it specially: it's not an error.
            (e.cause as? SourceRejectedException)?.let {
                return handleRejection(it.reason, partialCursor = e.cursor)
            }
            // Every page handed to onPage is already uploaded, so the
            // partially-advanced cursor is safe — and valuable: persist it
            // FIRST so the next pass doesn't re-read uploaded history, then
            // surface the failure.
            runCatching { persistCursor(e.cursor) }
            emitError(e)
            noteAuthorityRefusal(e.cause ?: e)
            return classify(e.cause ?: e)
        } catch (e: SourceRejectedException) {
            return handleRejection(e.reason, partialCursor = null)
        } catch (e: Exception) {
            emitError(e)
            noteAuthorityRefusal(e)
            return classify(e)
        }
    }

    /**
     * Records a gateway verdict that refused this device's authority to send
     * rather than the payload it sent. No budget applies — no amount of
     * re-sending earns a scope — so it is kept for the delivery surface and
     * cleared the moment a push gets through.
     */
    private fun noteAuthorityRefusal(cause: Throwable) {
        if (classifyGatewayFailure(cause) == GatewayFailureKind.NEEDS_ATTENTION) {
            settings.pushRefusals.blocked = true
        }
    }


    /**
     * Count one refusal against the unit the refused page came from and, once
     * the run is exhausted, throw [HealthPageGivenUpException] so the sync
     * advances that type past the unit and carries on with the rest of the
     * catalog. Below the budget this returns and the caller rethrows, so the
     * pass aborts and the whole unit is retried next time.
     *
     * The count is persisted before the throw, so a give-up the sync cannot
     * complete does not hand the run its budget back. The records stay in
     * Health Connect: the marker is what says a re-sync of the source would
     * recover them.
     */
    private fun giveUpOrRethrow(unit: HealthSyncUnit, cause: Exception) {
        val now = clock()
        if (!settings.pushRefusals.noteRefusal(unit.key, now)) return
        val marker = settings.pushRefusals.recordSkipped(unit.description, now)
        Log.w("Omnesis:health", "Skipped ${marker.unit} after ${marker.refusals} refusals: ${cause.message}")
        throw HealthPageGivenUpException(unit)
    }

    /**
     * React to the gateway declining this source. `paused` retains the
     * partially-advanced cursor so the not-yet-accepted page re-sends on resume.
     * `removed` disables syncing locally (the gateway already deleted the row
     * and won't resurrect it) so the source stops producing.
     */
    private suspend fun handleRejection(reason: String, partialCursor: HealthCursor?): SyncResult {
        if (reason == "paused") {
            if (partialCursor != null) runCatching { persistCursor(partialCursor) }
            return SyncResult.SourcePaused("Health Connect is paused in Omnesis")
        }
        settings.healthConnectEnabled = false
        return SyncResult.SourceRemoved("Health Connect was removed in Omnesis")
    }

    private suspend fun persistCursor(cursor: HealthCursor) {
        analytics.setSyncState(
            SOURCE_ID,
            SyncStateBody(
                cursor = cursor.toJsonElement(),
                label = SOURCE_LABEL,
                icon = HEALTH_CONNECT_ICON_DATA_URI,
                // One account per type here, so the family's identity is this
                // account's — said outright rather than left to be guessed
                // from whichever row a reader reaches first.
                family = SourceFamilyBody(label = SOURCE_LABEL, icon = HEALTH_CONNECT_ICON_DATA_URI),
            ),
        )
    }

    /** Field names mirror the iOS `forwardLifecycle` emitter exactly. */
    private fun emitStatus(build: JsonObjectBuilder.() -> Unit) {
        sendEvent(
            "sync.status",
            buildJsonObject {
                put("sourceId", SOURCE_ID)
                build()
            },
        )
    }

    private fun emitError(e: Exception) {
        val failure = if (e is HealthSyncException) e.cause ?: e else e
        emitStatus {
            put("state", "error")
            put("errorMessage", gatewayConnectionAdvice(failure) ?: e.message ?: "Health Connect sync failed")
        }
    }

    /**
     * Turns a gateway failure into this source's terminal state. The
     * transient/permanent split is [classifyGatewayFailure]'s, shared with
     * every other device-hosted source so that a rate limit or a proxy
     * timeout is never mistaken for a verdict on the payload.
     */
    private fun classify(cause: Throwable): SyncResult = when (classifyGatewayFailure(cause)) {
        GatewayFailureKind.NEEDS_ATTENTION ->
            SyncResult.NeedsAttention(cause.message ?: "authentication failed")
        GatewayFailureKind.PERMANENT ->
            SyncResult.Failed(cause.message ?: "sync failed", retryable = false)
        GatewayFailureKind.TRANSIENT ->
            SyncResult.Failed(gatewayConnectionAdvice(cause) ?: cause.message ?: "sync failed", retryable = true)
    }
}
