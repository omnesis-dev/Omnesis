// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.util.Log
import dev.omnesis.android.transport.DeliveryEvidence
import dev.omnesis.android.transport.DeliveryReporter
import dev.omnesis.android.transport.GatewayFailureKind
import dev.omnesis.android.transport.RetryOutcome
import dev.omnesis.android.transport.classifyGatewayFailure
import dev.omnesis.android.transport.countOf
import dev.omnesis.android.transport.readableMoment
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
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
 * Orchestrates one device-hosted Call Log source against the gateway — the
 * Android analogue of `HealthSyncCoordinator`, pushing BOTH channels a
 * device-hosted source can use (Health Connect only ever uses the analytics
 * one): day-aggregate documents via [DocumentsClient] and per-call rows via
 * [AnalyticsClient].
 *
 * Explicit registration is owned by the membership coordinator.
 * [syncNow] runs one [CallLogSource.sync] pass, pushes its analytics rows,
 *     pushes its rebuilt day documents, reconciles the full external-id
 *     snapshot (deletes any day-document whose calls are all gone — a real
 *     possibility here, unlike Apple's call history, since a user can delete
 *     individual `CallLog.Calls` rows), persists the cursor, and broadcasts
 *     `sync.status` device events.
 *
 * The cursor advances only on a push that got through, which is what makes a
 * refused window fatal if nothing gives up on it: every later pass re-reads
 * from the same watermark and re-sends the same refused calls, so no call
 * logged after them ever reaches Omnesis either. [giveUp] counts refusals
 * durably against the watermark the window starts at and, once the run has
 * both spent its budget and outlived the grace window, advances past that one
 * window and records what was skipped. Transient failures never count, however
 * long they last.
 *
 * Concurrent [syncNow] calls coalesce: a call landing while a drain is in
 * flight awaits that drain's result instead of starting another.
 */
class CallLogSyncCoordinator(
    private val sourceFactory: () -> CallLogSource,
    private val analytics: AnalyticsClient,
    private val documents: DocumentsClient,
    private val settings: CallLogSettings,
    private val hasPermission: () -> Boolean,
    private val sendEvent: (String, JsonObject) -> Unit,
    private val clock: () -> Instant = Instant::now,
) : DeliveryReporter {
    /** Terminal state of one [syncNow] call. */
    sealed interface SyncResult {
        /** Drain completed; [processed] counts uploaded analytics rows + documents. */
        data class Success(val processed: Int) : SyncResult

        /** Gates not met (feature disabled or permission not granted); nothing ran. */
        data class Skipped(val reason: String) : SyncResult

        /** Auth failure (401/403) — retrying won't help; the user must re-pair. */
        data class NeedsAttention(val message: String) : SyncResult

        /**
         * Drain aborted. [retryable] is false only when the gateway answered
         * and refused the payload — see [classifyGatewayFailure].
         */
        data class Failed(val message: String, val retryable: Boolean) : SyncResult

        /** The source was REMOVED in Omnesis — syncing is disabled locally. */
        data class SourceRemoved(val message: String) : SyncResult

        /** The source is PAUSED in Omnesis — retryable, cursor not advanced. */
        data class SourcePaused(val message: String) : SyncResult
    }

    companion object {
        const val SOURCE_ID = "${CallLogSource.SOURCE_TYPE}:${CallLogSource.ACCOUNT_ID_LOCAL}"
        const val SOURCE_LABEL = "Android Call Log"

        private const val TAG = "Omnesis:calllog"
    }

    /**
     * The window of new calls one pass pushed: [from] is the watermark it read
     * from — the identity of a stuck push, since it moves only when a push
     * gets through — and [to] the watermark that resumes after it.
     */
    private data class WindowPush(val from: CallLogCursor, val to: CallLogCursor, val calls: Int)

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
     * Calls are read from the system call log rather than copied into the app,
     * so there is nothing here to delete — only the record of which windows
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
        is SyncResult.Failed -> if (retryable) RetryOutcome.UNREACHABLE else RetryOutcome.REFUSED
        is SyncResult.NeedsAttention -> RetryOutcome.FAILED
        is SyncResult.Skipped, is SyncResult.SourceRemoved, is SyncResult.SourcePaused -> RetryOutcome.IDLE
    }

    private suspend fun runSync(): SyncResult {
        if (!settings.callLogEnabled) {
            return SyncResult.Skipped("Call Log syncing is disabled")
        }
        if (!hasPermission()) {
            return SyncResult.Skipped("READ_CALL_LOG permission not granted")
        }

        emitStatus {
            put("state", "syncing")
            put("startedAt", clock().toEpochMilli())
        }

        // The window this pass is pushing, held while the pushes are in flight
        // so the catch below can count a refusal against it.
        var pushed: WindowPush? = null
        try {
            val existing = analytics.getSyncState(SOURCE_ID)
            val loaded = CallLogCursor.fromJsonElement(existing?.cursor)

            val outcome = sourceFactory().sync(loaded)
            if (outcome.analyticsRows.isNotEmpty() || outcome.documents.isNotEmpty()) {
                pushed = WindowPush(from = loaded, to = outcome.cursor, calls = outcome.analyticsRows.size)
            }

            var processed = 0
            if (outcome.analyticsRows.isNotEmpty()) {
                val resp = analytics.ingest(
                    AnalyticsIngestBody(
                        tableName = ANDROID_CALL_LOG_TABLE,
                        records = outcome.analyticsRows,
                        schema = androidCallLogSchema,
                        sourceId = SOURCE_ID,
                    ),
                )
                resp.rejected.firstOrNull { it.sourceId == SOURCE_ID }?.let {
                    return handleRejection(it.reason)
                }
                processed += outcome.analyticsRows.size
            }
            if (outcome.documents.isNotEmpty()) {
                val resp = documents.ingest(outcome.documents)
                resp.rejected.firstOrNull { it.sourceId == SOURCE_ID }?.let {
                    return handleRejection(it.reason)
                }
                processed += outcome.documents.size
            }
            // Both channels got through: nothing after this point is the
            // window's fault, so it stops being what a refusal is counted
            // against, and any run it had accumulated is retired.
            if (pushed != null) settings.pushRefusals.blocked = false
            pushed = null
            settings.pushRefusals.clearRun(windowKey(loaded))
            // Deletion snapshot: covers a day-document whose calls were all
            // removed from CallLog.Calls (the user cleared history / deleted
            // rows), which the analytics/documents pushes above never signal.
            //
            // Withheld when the enumeration could not run. Sending an empty
            // list would tell the gateway every day document it holds has been
            // deleted, on the strength of a query that returned no cursor —
            // and deletion detection resumes on the next pass that can read.
            val present = outcome.presentExternalIds
            if (present != null) {
                documents.reconcile(
                    providerId = CallLogSource.PROVIDER_ID,
                    sourceId = SOURCE_ID,
                    presentExternalIds = present,
                )
            }

            // Elide the write only when nothing moved AND a state row already
            // exists — the first pass always writes so the gateway learns the
            // source's label/icon (carried only on this call, never on
            // `POST /admin/sources`) even if the call log is completely empty.
            if (!(existing != null && outcome.cursor == loaded)) {
                persistCursor(outcome.cursor)
            }

            emitStatus {
                put("state", "completed")
                put("completedAt", clock().toEpochMilli())
                putJsonObject("progress") { put("processed", processed) }
            }
            return SyncResult.Success(processed)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            emitError(e)
            noteAuthorityRefusal(e)
            val push = pushed
            if (push != null && classifyGatewayFailure(e) == GatewayFailureKind.PERMANENT) {
                runCatching { giveUp(push) }
                    .onFailure { Log.w(TAG, "Could not give up on the refused window: $it") }
            }
            return classify(e)
        }
    }

    /**
     * Count one refusal against the window this pass tried to push and, once
     * the run is exhausted, advance the watermark past it so calls logged
     * after it can flow. The calls stay in `CallLog.Calls`: the marker is what
     * says a re-sync of the source would recover them.
     *
     * The count is persisted before the advance is attempted, so an advance
     * that throws does not hand the run its budget back.
     */
    private suspend fun giveUp(push: WindowPush) {
        val now = clock()
        if (!settings.pushRefusals.noteRefusal(windowKey(push.from), now)) return
        persistCursor(push.to)
        val marker = settings.pushRefusals.recordSkipped(describe(push), now)
        Log.w(TAG, "Skipped ${marker.unit} after ${marker.refusals} refusals; later calls can sync again")
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

    /** Stable while the sync is stuck on this window — it is the window's own start. */
    private fun windowKey(from: CallLogCursor): String =
        "${from.lastDateMillis}:${from.lastId}:${from.insertIdHighWater}"

    private fun describe(push: WindowPush): String {
        val after = if (push.from.lastDateMillis > 0) {
            "logged after ${readableMoment(push.from.lastDateMillis)}"
        } else {
            "from the start of the call log"
        }
        return "${countOf(push.calls, "call")} $after"
    }

    /**
     * React to the gateway declining this source. `paused` leaves the cursor
     * untouched so the un-accepted page re-sends on resume. `removed`
     * disables syncing locally (the gateway already deleted the row and won't
     * resurrect it).
     */
    private suspend fun handleRejection(reason: String): SyncResult {
        if (reason == "paused") {
            return SyncResult.SourcePaused("Call Log is paused in Omnesis")
        }
        settings.callLogEnabled = false
        return SyncResult.SourceRemoved("Call Log was removed in Omnesis")
    }

    private suspend fun persistCursor(cursor: CallLogCursor) {
        analytics.setSyncState(
            SOURCE_ID,
            SyncStateBody(
                cursor = cursor.toJsonElement(),
                label = SOURCE_LABEL,
                icon = CALL_LOG_ICON_DATA_URI,
                // One account per type here, so the family's identity is this
                // account's — said outright rather than left to be guessed
                // from whichever row a reader reaches first.
                family = SourceFamilyBody(label = SOURCE_LABEL, icon = CALL_LOG_ICON_DATA_URI),
            ),
        )
    }

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
        emitStatus {
            put("state", "error")
            put("errorMessage", e.message ?: "Call Log sync failed")
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
            SyncResult.Failed(cause.message ?: "sync failed", retryable = true)
    }
}
