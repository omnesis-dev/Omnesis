// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import java.time.Duration
import java.time.Instant

/**
 * What one device-hosted source knows about its own data that has not reached
 * the gateway. Every field is evidence the source can produce without asking
 * the gateway anything, which is the point: the gateway cannot report data it
 * was never given.
 *
 * [queuedCount] and [setAsideCount] are non-zero only for a source that owns a
 * durable queue of its own. A source whose payload is read from the OS on
 * demand has nothing queued — what it has instead is [skipped] markers.
 */
data class DeliveryEvidence(
    /** Gateway source id, e.g. `photos:local`. */
    val sourceId: String,
    /**
     * The gateway answered a push by refusing this device's authority to send
     * for this source. Retrying reproduces it; the remedy is on the gateway.
     */
    val blocked: Boolean = false,
    /** Rows waiting in this source's own durable queue. */
    val queuedCount: Int = 0,
    /** Wall clock of the oldest queued row, or null when nothing is queued. */
    val oldestQueuedAtMillis: Long? = null,
    /** Rows the source stopped re-sending and is retaining rather than deleting. */
    val setAsideCount: Int = 0,
    /** Units this source moved past without delivering. */
    val skipped: List<SkippedPush> = emptyList(),
)

/**
 * The seam every device-hosted source offers the delivery-health surface. Each
 * source implements it over its own cursor model and its own queue, so the
 * surface aggregates without knowing that any particular source exists.
 */
interface DeliveryReporter {
    /** What this source currently has undelivered. */
    suspend fun deliveryEvidence(): DeliveryEvidence

    /** Run one pass because the user asked, and say what it achieved. */
    suspend fun retryDelivery(): RetryOutcome

    /**
     * Drop the retained rows and the record of what was skipped. Irreversible:
     * the retained rows are deleted, and with the markers gone nothing is left
     * to say a re-sync of this source would be worth running.
     */
    suspend fun discardUndelivered()
}

/**
 * What a user-triggered retry amounted to. Every pass produces one, so a retry
 * that achieved nothing is distinguishable from a button that is not wired up.
 */
enum class RetryOutcome {
    /** Something went through. */
    DELIVERED,

    /** The gateway answered, and refused. Retrying reproduces it. */
    REFUSED,

    /** The gateway could not be reached. Retrying later is the fix. */
    UNREACHABLE,

    /** A source could not read all its local data; gateway access may be healthy. */
    INCOMPLETE,

    /** A pass was already running; this one observed nothing. */
    BUSY,

    /** Nothing was pending. */
    IDLE,

    /** The pass could not start — most often a pairing the gateway no longer honors. */
    FAILED,
}

/** A source's durable queue that has not drained. */
data class QueuedBacklog(
    val sourceId: String,
    val count: Int,
    /** How long the oldest queued row has been waiting, or null when the queue is empty. */
    val oldestAgeMillis: Long?,
)

/** Rows a source stopped re-sending and is retaining on the phone. */
data class SetAside(val sourceId: String, val count: Int)

/** Everything the delivery-health surface renders, folded across every source. */
data class PushHealthSnapshot(
    /** Sources the gateway is refusing this device's authority for, sorted. */
    val blockedSourceIds: List<String> = emptyList(),
    /** Per-source durable queues, sorted by source id. */
    val queued: List<QueuedBacklog> = emptyList(),
    /** Per-source retained rows, sorted by source id. */
    val setAside: List<SetAside> = emptyList(),
    /** Units every source has given up on, oldest first. */
    val skipped: List<SkippedPush> = emptyList(),
)

/**
 * The policy behind "is this phone's data actually getting through?" — the
 * question a sync status cannot answer, because a sync reads from the OS and
 * the push is a separate step that fails on its own.
 *
 * Deliberately free of any UI dependency, so the decisions are ordinary values
 * the JVM-only test lane can exercise without rendering anything.
 */
object PushHealth {

    /**
     * How stale the oldest queued row must get before the backlog is worth
     * reporting. Long enough to clear a normal sync, a background pass, and an
     * overnight gap in connectivity without crying wolf.
     */
    val BACKLOG_THRESHOLD: Duration = Duration.ofHours(6)

    /** Where a user-triggered retry is in its cycle. */
    sealed interface RetryPhase {
        data object Idle : RetryPhase

        data object Running : RetryPhase

        /**
         * The last finished retry's result, kept on screen until a later pass
         * moves the numbers out from under it.
         */
        data class Reported(val outcome: RetryOutcome) : RetryPhase
    }

    /** Folds every source's evidence into the one thing the surface renders. */
    fun summarize(evidence: List<DeliveryEvidence>, now: Instant): PushHealthSnapshot {
        val nowMillis = now.toEpochMilli()
        return PushHealthSnapshot(
            blockedSourceIds = evidence.filter { it.blocked }.map { it.sourceId }.sorted(),
            queued = evidence
                .filter { it.queuedCount > 0 }
                .sortedBy { it.sourceId }
                .map {
                    QueuedBacklog(
                        sourceId = it.sourceId,
                        count = it.queuedCount,
                        // Clamped at zero: a row whose wall clock is ahead of the
                        // phone's — the clock moved backwards between the insert
                        // and this read — has not been waiting a negative time.
                        oldestAgeMillis = it.oldestQueuedAtMillis?.let { at -> (nowMillis - at).coerceAtLeast(0) },
                    )
                },
            setAside = evidence
                .filter { it.setAsideCount > 0 }
                .sortedBy { it.sourceId }
                .map { SetAside(it.sourceId, it.setAsideCount) },
            skipped = evidence.flatMap { it.skipped }.sortedBy { it.atMillis },
        )
    }

    /** True when there is nothing worth telling the user about. */
    fun isHealthy(snapshot: PushHealthSnapshot): Boolean =
        snapshot.blockedSourceIds.isEmpty() && !isBacklogged(snapshot) && !hasUndelivered(snapshot)

    /**
     * Whether a queue is stale enough to report as a delivery failure.
     *
     * Suppressed while any source is blocked. A blocked source's rows are never
     * removed and sit at the head of its queue, so the oldest-row age grows
     * without bound however healthy everything else is — reporting it would
     * latch a second alarm whose retry cannot help. The blocked row is showing
     * in that case and carries the real remedy.
     */
    fun isBacklogged(snapshot: PushHealthSnapshot, threshold: Duration = BACKLOG_THRESHOLD): Boolean {
        if (snapshot.blockedSourceIds.isNotEmpty()) return false
        return snapshot.queued.any { (it.oldestAgeMillis ?: 0L) >= threshold.toMillis() }
    }

    /** Whether anything has been given up on — retained rows, or a skipped unit. */
    fun hasUndelivered(snapshot: PushHealthSnapshot): Boolean =
        snapshot.skipped.isNotEmpty() || snapshot.setAside.any { it.count > 0 }

    /**
     * One answer for a retry that ran several sources. Ordered by what the user
     * can act on: a pairing that no longer works outranks an unreachable
     * gateway, which outranks a refusal, because the earlier one is both the
     * more likely cause when they appear together and the one with a remedy.
     * An incomplete local read also outranks a delivery: one source's success
     * must not hide another source's read failure.
     * A pass that delivered something outranks the two that did nothing at all.
     */
    fun combine(outcomes: List<RetryOutcome>): RetryOutcome {
        val ranked = listOf(
            RetryOutcome.FAILED,
            RetryOutcome.UNREACHABLE,
            RetryOutcome.REFUSED,
            RetryOutcome.INCOMPLETE,
            RetryOutcome.DELIVERED,
            RetryOutcome.BUSY,
        )
        return ranked.firstOrNull { it in outcomes } ?: RetryOutcome.IDLE
    }

    /**
     * What a retry achieved, in one line.
     *
     * The copy is deliberately narrow about what this phone can promise. Its
     * queued rows are the only data it holds; everything else is read from the
     * OS when a pass runs, so "still waiting here" is a claim only the queue
     * can honor.
     */
    fun retryMessage(outcome: RetryOutcome): String = when (outcome) {
        RetryOutcome.DELIVERED -> "Some of it went through. The rest is still waiting."
        RetryOutcome.REFUSED ->
            "Omnesis answered, and refused this data. Retrying won't change that — " +
                "it'll be given up on if it keeps failing."
        RetryOutcome.UNREACHABLE -> "Couldn't reach Omnesis. This phone will keep trying in the background."
        RetryOutcome.INCOMPLETE -> "Some data couldn't be read on this phone. Check the affected source and try syncing again."
        RetryOutcome.BUSY -> "A sync is already running. Try again in a moment."
        RetryOutcome.IDLE -> "Nothing was waiting to be sent."
        RetryOutcome.FAILED -> "The sync couldn't start. Check this phone is still paired in Settings."
    }

    /**
     * Whether an outcome is bad news, which decides whether its line is colored
     * as a warning. Outcomes that leave data undelivered are: "nothing
     * was waiting" and "a sync is already running" report a retry that had
     * nothing to do, not one that failed.
     */
    fun retryIsTrouble(outcome: RetryOutcome): Boolean = when (outcome) {
        RetryOutcome.REFUSED, RetryOutcome.UNREACHABLE, RetryOutcome.FAILED, RetryOutcome.INCOMPLETE -> true
        RetryOutcome.DELIVERED, RetryOutcome.BUSY, RetryOutcome.IDLE -> false
    }

    /**
     * How long something has been waiting, at one unit of precision — a
     * duration ("3 days"), never a date, because the point is the wait rather
     * than when the data was captured. Anything under a minute still reads as
     * a minute: "0 minutes" would say the queue is moving when it is not.
     */
    fun waitedLabel(ageMillis: Long): String {
        val duration = Duration.ofMillis(ageMillis.coerceAtLeast(0))
        return when {
            duration.toDays() >= 1 -> plural(duration.toDays(), "day")
            duration.toHours() >= 1 -> plural(duration.toHours(), "hour")
            else -> plural(duration.toMinutes().coerceAtLeast(1), "minute")
        }
    }

    private fun plural(count: Long, noun: String): String = if (count == 1L) "1 $noun" else "$count ${noun}s"
}
