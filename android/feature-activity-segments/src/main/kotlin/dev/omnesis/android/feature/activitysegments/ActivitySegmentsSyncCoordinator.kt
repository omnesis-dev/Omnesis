// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import android.util.Log
import dev.omnesis.android.transport.DeliveryEvidence
import dev.omnesis.android.transport.DeliveryReporter
import dev.omnesis.android.transport.GatewayFailureKind
import dev.omnesis.android.transport.RetryOutcome
import dev.omnesis.android.transport.SkippedPush
import dev.omnesis.android.transport.classifyGatewayFailure
import dev.omnesis.android.transport.countOf
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.DocumentsClient
import dev.omnesis.android.transport.dto.AnalyticsIngestBody
import dev.omnesis.android.transport.dto.SourceFamilyBody
import dev.omnesis.android.transport.dto.SyncStateBody
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Orchestrates the device-hosted Activity Segments source against the
 * gateway. Bolts a pull-based upload half onto the push-based
 * [ActivityTransitionReceiver] half — [ActivityTransitionBuffer] is where
 * they meet:
 *
 *  1. Read this member's gateway cursor. After a reset or projection upgrade,
 *     replay durable history in bounded pages, committing progress only after
 *     analytics and day documents have both been accepted.
 *  2. [buffer].readAll() — every not-yet-resolved transition event.
 *  3. [ActivitySegmentsNormalizer.mergeIntoSegments] — reconstruct closed
 *     segments; the genuinely still-open trailing segment is held back for
 *     the next drain.
 *  4. If any segments closed: upsert them into [history] (so a later drain
 *     touching the same day still rebuilds the FULL day, not just this
 *     drain's slice — see [ActivitySegmentsHistoryStore]), push analytics
 *     rows, then push the affected days' rebuilt "Movement Timeline"
 *     documents.
 *  5. Only after BOTH pushes and the cursor save succeed, [buffer].deleteUpTo(consumedThroughId)
 *     — any exception before this point leaves the buffer completely
 *     untouched, so the next drain retries the exact same events safely.
 *  Unfinished intervals stay buffered; resolved sub-floor blips and orphan
 *  exits can be consumed without producing an upload.
 *
 * Retrying forever is only safe while the failure is one a retry can fix. A
 * push the gateway answers and refuses reproduces its refusal on every pass,
 * and the buffer is strictly FIFO under a fixed read window — so an
 * undeliverable range at the head would eventually hide every event behind
 * it. [noteRefusal] counts those refusals durably and, once the run has both
 * exhausted its budget and outlived the grace window, moves the range into
 * quarantine so the buffer can drain again and leaves a [SkippedPush] marker
 * saying what was set aside. Transient failures never count, however long they
 * last.
 *
 * Concurrent [syncNow] calls coalesce: a call landing while a drain is in
 * flight awaits that drain's result instead of starting another.
 */
class ActivitySegmentsSyncCoordinator(
    private val buffer: ActivityTransitionBuffer,
    private val history: ActivitySegmentsHistoryStore,
    private val analytics: AnalyticsClient,
    private val documents: DocumentsClient,
    private val settings: ActivitySegmentsSettings,
    private val hasPermission: () -> Boolean,
    private val availability: () -> ActivitySegmentsAvailability,
    private val sendEvent: (String, JsonObject) -> Unit,
    private val clock: () -> Instant = Instant::now,
) : DeliveryReporter {
    /** Terminal state of one [syncNow] call. */
    sealed interface SyncResult {
        /** Drain completed; [processed] counts uploaded analytics rows + documents. */
        data class Success(val processed: Int) : SyncResult

        /** Gates not met (feature disabled, permission not granted, or GMS unavailable); nothing ran. */
        data class Skipped(val reason: String) : SyncResult

        /** Auth failure (401/403) — retrying won't help; the user must re-pair. */
        data class NeedsAttention(val message: String) : SyncResult

        /**
         * Drain aborted. [retryable] is false only when the gateway answered
         * and refused the payload — see [classifyGatewayFailure]. The buffer
         * keeps the events, unless a run of refusals quarantined them.
         */
        data class Failed(val message: String, val retryable: Boolean) : SyncResult

        /** The source was REMOVED in Omnesis — syncing is disabled locally. */
        data class SourceRemoved(val message: String) : SyncResult

        /** The source is PAUSED in Omnesis — retryable, the buffer is untouched. */
        data class SourcePaused(val message: String) : SyncResult
    }

    companion object {
        const val SOURCE_TYPE = "android-activity-segments"
        const val ACCOUNT_ID_LOCAL = "local"
        const val PROVIDER_ID = "android"
        const val SOURCE_ID = "$SOURCE_TYPE:$ACCOUNT_ID_LOCAL"
        const val SOURCE_LABEL = "Android Activity Segments"

        private const val TAG = "Omnesis:activitysegments"
        private const val HISTORY_PROJECTION_VERSION = 1
        private const val HISTORY_PAGE_SIZE = 200
    }

    /**
     * The stretch of the transition buffer one push covered: [headId] is the
     * buffer's oldest row (the identity of a stuck push — it moves only when
     * the buffer drains) and [throughId] the last row the push resolved.
     */
    private data class BufferRange(val headId: Long, val throughId: Long)

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

    override suspend fun deliveryEvidence(): DeliveryEvidence {
        // Raw transitions include an unfinished activity, not just uploadable
        // data. Use the drain's own bounded snapshot and closure rules so an
        // open interval is not mistaken for a failed delivery. This is read-only:
        // the sync pass still owns uploads and removal of resolved events.
        val ready = ActivitySegmentsNormalizer.mergeIntoSegments(buffer.readAll(), clock()).closedSegments
        return DeliveryEvidence(
            sourceId = SOURCE_ID,
            blocked = settings.pushRefusals.blocked,
            queuedCount = ready.size,
            // Time spent doing an activity is not time spent waiting to upload.
            // A forced closure becomes eligible at the fixed safety deadline,
            // even though the normalizer closes its payload at the current time.
            oldestQueuedAtMillis = ready.minOfOrNull {
                if (it.truncated) it.startMillis + ActivitySegmentsNormalizer.MAX_OPEN_AGE.toMillis()
                else it.endMillis
            },
            setAsideCount = buffer.quarantinedCount(),
            skipped = settings.pushRefusals.skipped,
        )
    }

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
     * The only source that holds a copy of its own payload, so this is the one
     * discard that deletes data: the quarantined transition events go, along
     * with the record of which ranges syncing gave up on.
     */
    override suspend fun discardUndelivered() {
        buffer.discardQuarantined()
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
        if (!settings.activitySegmentsEnabled) {
            return SyncResult.Skipped("Activity Segments syncing is disabled")
        }
        if (!hasPermission()) {
            return SyncResult.Skipped("Activity recognition permission not granted")
        }
        val avail = availability()
        if (avail != ActivitySegmentsAvailability.Available) {
            return SyncResult.Skipped("Google Play services is not available: $avail")
        }

        emitStatus {
            put("state", "syncing")
            put("startedAt", clock().toEpochMilli())
        }

        // The buffer range this pass is about to push, captured before the
        // push so the catch below can count a refusal against it.
        var pushed: BufferRange? = null
        try {
            var cursor = analytics.getSyncState(SOURCE_ID)?.cursor as? JsonObject ?: buildJsonObject { put("lastConsumedId", 0L) }
            var processed = 0
            // The gateway's member cursor is the authority: detach, resync, or
            // re-pair can clear it while this phone still retains its history.
            // The projection revision also rebuilds existing day documents.
            val revision = (cursor["historyProjectionVersion"] as? JsonPrimitive)?.intOrNull
            var afterId = if (revision == HISTORY_PROJECTION_VERSION) {
                (cursor["historyReplayAfter"] as? JsonPrimitive)?.contentOrNull
            } else null
            if (revision != HISTORY_PROJECTION_VERSION || afterId != null) {
                while (true) {
                    yield()
                    val page = history.segmentsPage(afterId, HISTORY_PAGE_SIZE)
                    val upload = uploadSegments(page)
                    if (upload !is SyncResult.Success) return upload
                    processed += upload.processed
                    val more = page.size == HISTORY_PAGE_SIZE
                    val next = buildJsonObject {
                        cursor.forEach { (key, value) -> if (key != "historyReplayAfter") put(key, value) }
                        put("historyProjectionVersion", HISTORY_PROJECTION_VERSION)
                        if (more) put("historyReplayAfter", ActivitySegmentsNormalizer.segmentId(page.last()))
                    }
                    // Commit a page only after both planes accept it. A process
                    // death or a failed cursor write repeats stable upsert IDs.
                    persistCursor(next)
                    cursor = next
                    if (!more) break
                    afterId = ActivitySegmentsNormalizer.segmentId(page.last())
                }
            }
            val events = buffer.readAll()
            val outcome = ActivitySegmentsNormalizer.mergeIntoSegments(events, clock())

            if (outcome.closedSegments.isEmpty()) {
                // No segment qualified, but sub-floor blips and orphan EXITs
                // still resolved (consumedThroughId non-null) — drop them now
                // or they accumulate in the buffer forever. Left unresolved,
                // readAll()'s fixed 5000-row window would eventually fill
                // entirely with dead rows and stop surfacing new real events.
                persistCursor(cursorWithConsumed(cursor, outcome.consumedThroughId))
                outcome.consumedThroughId?.let {
                    buffer.deleteUpTo(it)
                    settings.pushRefusals.clearRun(events.first().id.toString())
                }
                // A successful empty pass is still a sync. Persisting the
                // existing cursor stamps lastSyncedAt so the UI does not fall
                // back to "Ready to sync" after briefly receiving the live
                // completion event.
                emitStatus {
                    put("state", "completed")
                    put("completedAt", clock().toEpochMilli())
                    putJsonObject("progress") { put("processed", processed) }
                }
                return SyncResult.Success(processed)
            }

            pushed = outcome.consumedThroughId?.let { BufferRange(headId = events.first().id, throughId = it) }
            history.upsertAll(outcome.closedSegments)

            val upload = uploadSegments(outcome.closedSegments)
            if (upload !is SyncResult.Success) return upload
            processed += upload.processed
            persistCursor(cursorWithConsumed(cursor, outcome.consumedThroughId))

            // Both pushes succeeded — safe to drop the resolved events. A
            // held-back trailing open segment's events are never touched
            // (consumedThroughId excludes them; see mergeIntoSegments).
            outcome.consumedThroughId?.let { buffer.deleteUpTo(it) }
            pushed?.let {
                settings.pushRefusals.clearRun(it.headId.toString())
                settings.pushRefusals.blocked = false
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
            val range = pushed
            if (range != null && classifyGatewayFailure(e) == GatewayFailureKind.PERMANENT) {
                runCatching { noteRefusal(range) }
                    .onFailure { Log.w(TAG, "Could not record the refusal: $it") }
            }
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
     * Count one refusal against the buffer range that is stuck, and — once the
     * run is exhausted — move that range into quarantine so everything behind
     * it can drain. A refused range never leaves on its own: re-sending it
     * reproduces the refusal, and the buffer's fixed read window means enough
     * undeliverable rows at the head eventually hide every new event behind
     * them.
     *
     * The count is persisted before the move is attempted, so a move that
     * throws does not hand the run its budget back.
     */
    private suspend fun noteRefusal(range: BufferRange) {
        val now = clock()
        if (!settings.pushRefusals.noteRefusal(range.headId.toString(), now)) return
        val moved = buffer.quarantine(range.throughId)
        val marker = settings.pushRefusals.recordSkipped(countOf(moved, "buffered activity transition event"), now)
        Log.w(TAG, "Quarantined $moved refused transition event(s) after ${marker.refusals} refusals; the buffer can drain again")
    }

    /**
     * React to the gateway declining this source. `paused` leaves the buffer
     * untouched so the un-accepted events re-send on resume. `removed`
     * disables syncing locally (the gateway already deleted the row and won't
     * resurrect it).
     */
    private suspend fun handleRejection(reason: String): SyncResult {
        if (reason == "paused") {
            return SyncResult.SourcePaused("Activity Segments is paused in Omnesis")
        }
        settings.activitySegmentsEnabled = false
        return SyncResult.SourceRemoved("Activity Segments was removed in Omnesis")
    }

    private fun cursorWithConsumed(cursor: JsonObject, consumedThroughId: Long?): JsonObject = buildJsonObject {
        cursor.forEach { (key, value) -> put(key, value) }
        consumedThroughId?.let { put("lastConsumedId", it) }
    }

    /** Canonical analytics rows and full, clipped day projections share one retry boundary. */
    private suspend fun uploadSegments(segments: List<Segment>): SyncResult {
        if (segments.isEmpty()) return SyncResult.Success(0)
        val analyticsRows = segments.map { ActivitySegmentsNormalizer.analyticsRow(it) }
        val analyticsResp = analytics.ingest(
            AnalyticsIngestBody(
                tableName = ANDROID_ACTIVITY_SEGMENTS_TABLE,
                records = analyticsRows,
                schema = androidActivitySegmentsSchema,
                sourceId = SOURCE_ID,
            ),
        )
        analyticsResp.rejected.firstOrNull { it.sourceId == SOURCE_ID }?.let { return handleRejection(it.reason) }
        val affectedDates = segments.flatMap { ActivitySegmentsNormalizer.splitAtDayBoundaries(it) }
            .map { ActivitySegmentsNormalizer.startDate(it) }.toSortedSet()
        val dayDocuments = affectedDates.map { date ->
            ActivitySegmentsNormalizer.buildDayDocument(
                segments = history.segmentsForDate(date.toString()), date = date,
                providerId = PROVIDER_ID, sourceId = SOURCE_ID,
            )
        }
        val documentsResp = documents.ingest(dayDocuments)
        documentsResp.rejected.firstOrNull { it.sourceId == SOURCE_ID }?.let { return handleRejection(it.reason) }
        settings.pushRefusals.blocked = false
        return SyncResult.Success(analyticsRows.size + dayDocuments.size)
    }

    private suspend fun persistCursor(cursor: JsonObject) {
        analytics.setSyncState(
            SOURCE_ID,
            SyncStateBody(
                cursor = cursor,
                label = SOURCE_LABEL,
                icon = ACTIVITY_SEGMENTS_ICON_DATA_URI,
                // One account per type here, so the family's identity is this
                // account's — said outright rather than left to be guessed
                // from whichever row a reader reaches first.
                family = SourceFamilyBody(label = SOURCE_LABEL, icon = ACTIVITY_SEGMENTS_ICON_DATA_URI),
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
            put("errorMessage", e.message ?: "Activity Segments sync failed")
        }
        Log.w(TAG, "Sync failed: $e")
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
