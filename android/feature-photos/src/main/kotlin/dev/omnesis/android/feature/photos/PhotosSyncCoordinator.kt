// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

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
import dev.omnesis.android.transport.dto.SourceFamilyBody
import dev.omnesis.android.transport.dto.SyncStateBody
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

private const val TAG = "Omnesis:photos"
private val RECONCILE_INTERVAL: Duration = Duration.ofDays(1)

/**
 * Orchestrates the device-hosted Photos source against the gateway — the
 * Android analogue of `HealthSyncCoordinator`/`CallLogSyncCoordinator`, but
 * documents-only: Photos has no analytics table, so [analytics] is used
 * SOLELY for its `getSyncState`/`setSyncState` cursor-persistence methods,
 * never `.ingest()` (mirrors iOS's `PhotosSource` having an empty
 * `analyticsSchemas` array / a nil `tableName`).
 *
 * Explicit registration is owned by the membership coordinator.
 * [syncNow] runs one [PhotosSource.sync] pass, pushes any resulting
 *     documents, runs the throttled whole-library reconcile snapshot when
 *     due (at most once/[RECONCILE_INTERVAL] — see [PhotosSettings.lastReconcileAt]),
 *     persists the cursor, and broadcasts `sync.status` device events.
 *
 * The cursor advances only on a push that got through, which is what makes a
 * refused page fatal if nothing gives up on it: the same page is rebuilt and
 * re-sent every pass, and the phased backfill (screenshots → recent → backfill
 * → steady) never reaches its next page, let alone its next phase. [giveUp]
 * counts refusals durably against the page's own cursor position and, once the
 * run has both spent its budget and outlived the grace window, advances past
 * that one page — inside the phase, never abandoning the phase machine — and
 * records what was skipped. Transient failures never count, however long they
 * last.
 *
 * Concurrent [syncNow] calls coalesce: a call landing while a drain is in
 * flight awaits that drain's result instead of starting another — the same
 * pattern that lets the JobScheduler live-trigger path and the periodic
 * WorkManager path share one entry point without racing.
 */
class PhotosSyncCoordinator(
    private val sourceFactory: () -> PhotosSource,
    private val analytics: AnalyticsClient,
    private val documents: DocumentsClient,
    private val settings: PhotosSettings,
    private val hasPermission: () -> Boolean,
    private val hasFullAccess: () -> Boolean = hasPermission,
    private val accessGeneration: () -> Long = { 0L },
    private val sendEvent: (String, JsonObject) -> Unit,
    private val clock: () -> Instant = Instant::now,
    private val prepareSync: suspend () -> Unit = {},
) : DeliveryReporter {
    /** Terminal state of one [syncNow] call. */
    sealed interface SyncResult {
        /** Drain completed; [processed] counts documents pushed. */
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
        const val SOURCE_ID = "${PhotosSource.SOURCE_TYPE}:${PhotosSource.ACCOUNT_ID_LOCAL}"
        const val SOURCE_LABEL = "Photos"
    }

    /**
     * The page of the phased backfill one push covered: [from] is the cursor
     * the pass read from — the identity of a stuck push, since it moves only
     * when a page gets through — and [to] the cursor that resumes after it.
     */
    private data class PagePush(val from: PhotosCursor, val to: PhotosCursor, val documents: Int)

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
     * Photos are read from MediaStore rather than copied into the app, so
     * there is nothing here to delete — only the record of what syncing moved
     * past, which is what would have told the user a re-sync was worth running.
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
        if (!settings.photosEnabled) {
            return SyncResult.Skipped("Photos syncing is disabled")
        }
        if (!hasPermission()) {
            return SyncResult.Skipped("Photos permission not granted")
        }

        emitStatus {
            put("state", "syncing")
            put("startedAt", clock().toEpochMilli())
        }

        // The page this pass is pushing, held while the push is in flight so
        // the catch below can count a refusal against it.
        var pushed: PagePush? = null
        try {
            prepareSync()
            val existing = analytics.getSyncState(SOURCE_ID)
            val persisted = PhotosCursor.fromJsonElement(existing?.cursor)
            val generation = accessGeneration()
            val loaded = if (persisted.accessGeneration == generation) {
                persisted
            } else {
                PhotosCursor(
                    accessGeneration = generation,
                    // A source row proves the gateway can already hold richer
                    // NEW-tier documents. A first-ever empty source keeps the
                    // normal cheap backfill; a restored/legacy source does not
                    // risk downgrading anything it previously indexed.
                    preserveRichAnalysis = existing != null,
                )
            }

            val outcome = sourceFactory().sync(loaded)

            var processed = 0
            if (outcome.documents.isNotEmpty()) {
                pushed = PagePush(from = loaded, to = outcome.cursor, documents = outcome.documents.size)
                val resp = documents.ingest(outcome.documents)
                resp.rejected.firstOrNull { it.sourceId == SOURCE_ID }?.let {
                    return handleRejection(it.reason)
                }
                // The page got through: nothing after this point is the page's
                // fault, so it stops being what a refusal is counted against,
                // and the gateway is demonstrably accepting this source again.
                pushed = null
                settings.pushRefusals.blocked = false
                processed += outcome.documents.size
            }
            // Nothing was refused, so any run this page had accumulated is retired.
            settings.pushRefusals.clearRun(pageKey(loaded))

            reconcileIfDue()

            // The gateway's last-synced time comes from this row. A successful
            // no-change pass must refresh it too, or the UI reports an old sync.
            persistCursor(outcome.cursor)

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
                    .onFailure { Log.w(TAG, "Could not give up on the refused page: $it") }
            }
            return classify(e)
        }
    }

    /**
     * Count one refusal against the page this pass tried to push and, once the
     * run is exhausted, advance the cursor past it so the next page — and
     * eventually the next phase — can be reached. The photos themselves stay
     * on the device: the marker is what says a re-sync of the source would
     * recover them.
     *
     * The count is persisted before the advance is attempted, so an advance
     * that throws does not hand the run its budget back.
     */
    private suspend fun giveUp(push: PagePush) {
        val now = clock()
        if (!settings.pushRefusals.noteRefusal(pageKey(push.from), now)) return
        persistCursor(push.to)
        val marker = settings.pushRefusals.recordSkipped(describe(push), now)
        Log.w(TAG, "Skipped ${marker.unit} after ${marker.refusals} refusals; the backfill can move on")
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

    /** Stable while the sync is stuck on this page — it is the page's own resume point. */
    private fun pageKey(from: PhotosCursor): String =
        "${from.phase}:${from.lastAssetDateAddedSec ?: 0}:${from.lastAssetId ?: ""}"

    private fun describe(push: PagePush): String {
        val phase = push.from.phase.name.lowercase()
        val after = push.from.lastAssetDateAddedSec
            ?.let { "added after ${readableMoment(it * 1000)}" }
            ?: "from the start of the library"
        return "${countOf(push.documents, "photo")} in the $phase pass, $after"
    }

    /**
     * Whole-library reconcile snapshot, throttled to at most once per
     * [RECONCILE_INTERVAL] — a photo library is orders of magnitude larger
     * than, say, a call log, so sending every current asset id on every sync
     * pass (as call-log unconditionally does) would be real cost. This is
     * the SOLE deletion mechanism for Photos — see `PhotosSource`'s doc
     * comment for why there's no per-id live-path delete.
     */
    private suspend fun reconcileIfDue() {
        val last = settings.lastReconcileAt
        val now = clock()
        if (last != null && Duration.between(last, now) < RECONCILE_INTERVAL) return

        // A selected-photo grant exposes a subset, not a deletion snapshot.
        // Re-check after enumeration as permission can change while MediaStore is queried.
        if (!hasFullAccess()) return
        // Null means the enumeration did not run — which the two access checks
        // around it cannot detect, because they test the permission and this is
        // the case where the permission is still granted and the provider is
        // simply unavailable. Sending an empty list here would claim the whole
        // library was deleted.
        val presentIds = sourceFactory().fetchAllExternalIds() ?: return
        if (!hasFullAccess()) return
        documents.reconcile(
            providerId = PhotosSource.PROVIDER_ID,
            sourceId = SOURCE_ID,
            presentExternalIds = presentIds,
        )
        settings.lastReconcileAt = now
    }

    /**
     * React to the gateway declining this source. `paused` leaves the cursor
     * untouched so the un-accepted page re-sends on resume. `removed`
     * disables syncing locally (the gateway already deleted the row and won't
     * resurrect it).
     */
    private fun handleRejection(reason: String): SyncResult {
        if (reason == "paused") {
            return SyncResult.SourcePaused("Photos is paused in Omnesis")
        }
        settings.photosEnabled = false
        return SyncResult.SourceRemoved("Photos was removed in Omnesis")
    }

    private suspend fun persistCursor(cursor: PhotosCursor) {
        val generation = accessGeneration()
        val safeCursor = if (cursor.accessGeneration == generation) cursor else PhotosCursor(accessGeneration = generation)
        analytics.setSyncState(
            SOURCE_ID,
            SyncStateBody(
                cursor = safeCursor.toJsonElement(),
                label = SOURCE_LABEL,
                icon = PHOTOS_ICON_DATA_URI,
                // One account per type here, so the family's identity is this
                // account's — said outright rather than left to be guessed
                // from whichever row a reader reaches first.
                family = SourceFamilyBody(label = SOURCE_LABEL, icon = PHOTOS_ICON_DATA_URI),
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
            put("errorMessage", e.message ?: "Photos sync failed")
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
