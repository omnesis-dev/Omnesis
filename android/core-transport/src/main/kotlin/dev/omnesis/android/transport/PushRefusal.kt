// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * A run of gateway refusals against ONE unit of a device-hosted source's data,
 * named by [unitKey] in that source's own cursor terms — a record type's page,
 * a backfill page within a phase, a time window, the head of a buffer.
 *
 * The key is what makes the count mean anything: it changes only when the
 * source moves past the refused unit, so a refusal against a different unit
 * starts its own run instead of inheriting a spent one.
 *
 * [firstAtMillis] is when the run started, not when the data was collected.
 * The grace window exists to give a gateway-side fix its chance, and a window
 * measured from anything else is already satisfied for whatever sits at the
 * head of a backed-up queue.
 */
data class RefusalRun(val unitKey: String, val count: Int, val firstAtMillis: Long)

/**
 * When a run of refusals has gone on long enough that re-sending is no longer
 * worth blocking everything behind it. Both legs must hold: enough attempts to
 * rule out a one-off, and enough elapsed time that a fix on the gateway could
 * have landed. Attempts alone are not enough — a sync runs on session rebuild
 * and on demand as well as hourly, so a single foreground could spend the
 * whole budget in seconds.
 */
object RefusalPolicy {
    const val MAX_REFUSALS = 5
    val GRACE: Duration = Duration.ofHours(6)

    fun exhausted(run: RefusalRun, now: Instant): Boolean =
        run.count >= MAX_REFUSALS &&
            Duration.between(Instant.ofEpochMilli(run.firstAtMillis), now) >= GRACE
}

/**
 * A unit of data a source stopped trying to send. Every device-hosted source
 * records these in the same shape so one surface can render all of them,
 * resolving the source's label and icon from [sourceId] through the source
 * catalog rather than from anything stored here.
 *
 * The payload itself is read from the OS (Health Connect, MediaStore, the call
 * log, usage stats) rather than owned by the app, so there is nothing to set
 * aside — but a re-sync of the source can read it again, and this marker is
 * what tells the user that one is worth running.
 */
@Serializable
data class SkippedPush(
    /** Gateway source id, e.g. `photos:local`. */
    val sourceId: String,
    /** What was skipped, in the source's own terms. */
    val unit: String,
    /** How many refusals it took before the client gave up. */
    val refusals: Int,
    /** When the client gave up. */
    val atMillis: Long,
)

/**
 * The durable half of giving up on a push the gateway answers and refuses: the
 * open [RefusalRun], and the [SkippedPush] markers for the units a source has
 * stopped re-sending.
 *
 * It has to be durable rather than in-memory because the run has to outlive the
 * process: WorkManager cold-starts the app for each background pass, so an
 * in-memory count would reset to zero on every attempt and never reach its
 * budget. Storage is a string key/value store — SharedPreferences in
 * production — reached through [read]/[write] so this stays independent of any
 * one source's settings class.
 */
class PushRefusalLedger(
    private val sourceId: String,
    private val keyPrefix: String,
    private val read: (String) -> String?,
    private val write: (String, String?) -> Unit,
    private val maxSkipped: Int = MAX_SKIPPED,
) {
    private val keyUnit = "$keyPrefix.refusal.unit"
    private val keyCount = "$keyPrefix.refusal.count"
    private val keyFirstAt = "$keyPrefix.refusal.firstAt"
    private val keySkipped = "$keyPrefix.skipped"
    private val keyBlocked = "$keyPrefix.blocked"

    /**
     * Whether the gateway last answered a push by refusing this device's
     * authority to send for this source — a scope this pairing does not carry,
     * or a pairing it no longer honors at all. Neither a retry nor a different
     * payload helps, so it is reported rather than counted against the refusal
     * budget.
     *
     * Durable for the same reason the run is: each background pass cold-starts
     * the app, so an in-memory flag would be false again before anyone read it.
     */
    var blocked: Boolean
        get() = read(keyBlocked) == "true"
        set(value) = write(keyBlocked, if (value) "true" else null)

    /** The run in progress, or null when the last push against that unit was not refused. */
    var openRun: RefusalRun?
        get() {
            val unit = read(keyUnit) ?: return null
            val count = read(keyCount)?.toIntOrNull() ?: return null
            val firstAt = read(keyFirstAt)?.toLongOrNull() ?: return null
            return RefusalRun(unit, count, firstAt)
        }
        set(value) {
            write(keyUnit, value?.unitKey)
            write(keyCount, value?.count?.toString())
            write(keyFirstAt, value?.firstAtMillis?.toString())
        }

    /**
     * Counts one refusal against [unit] and answers whether the caller should
     * give up on it. The count is persisted before this returns, so an advance
     * that then throws does not hand the run its budget back.
     *
     * Only call this for a failure the gateway actually gave a verdict on —
     * see [classifyGatewayFailure]. A transient failure that reached the budget
     * would cost data an outage would have delivered.
     */
    fun noteRefusal(unit: String, now: Instant): Boolean {
        val open = openRun?.takeIf { it.unitKey == unit }
        val run = open?.copy(count = open.count + 1) ?: RefusalRun(unit, count = 1, firstAtMillis = now.toEpochMilli())
        openRun = run
        return RefusalPolicy.exhausted(run, now)
    }

    /**
     * Retires the run once [unit] gets through. A run counting a different unit
     * is left alone — a source that pushes several units per pass must not have
     * one unit's success forgive another unit's refusals.
     */
    fun clearRun(unit: String) {
        if (openRun?.unitKey == unit) openRun = null
    }

    /**
     * Records that the source gave up on [unit] and closes the run that was
     * counting it. The markers are capped at [maxSkipped], oldest dropped
     * first, so a source that keeps producing undeliverable data cannot grow
     * this without bound.
     */
    fun recordSkipped(unit: String, now: Instant): SkippedPush {
        val entry = SkippedPush(
            sourceId = sourceId,
            unit = unit,
            refusals = openRun?.count ?: 0,
            atMillis = now.toEpochMilli(),
        )
        write(keySkipped, JSON.encodeToString(SKIPPED_LIST, (skipped + entry).takeLast(maxSkipped)))
        openRun = null
        return entry
    }

    /** Everything this source has given up on, oldest first. */
    val skipped: List<SkippedPush>
        get() {
            val raw = read(keySkipped) ?: return emptyList()
            return runCatching { JSON.decodeFromString(SKIPPED_LIST, raw) }.getOrDefault(emptyList())
        }

    /**
     * Forgets what this source gave up on. The units themselves are not
     * recoverable by dropping their markers — this only discards the record
     * that a re-sync would be worth running.
     */
    fun clearSkipped() {
        write(keySkipped, null)
    }

    /** Wipes the run, the blocked flag and every marker — for a source resetting to defaults. */
    fun clear() {
        openRun = null
        blocked = false
        clearSkipped()
    }

    companion object {
        const val MAX_SKIPPED = 20

        private val JSON = Json { ignoreUnknownKeys = true }
        private val SKIPPED_LIST = ListSerializer(SkippedPush.serializer())
    }
}

/**
 * "1 photo" / "42 photos". A [SkippedPush] description is copy the user reads
 * in the delivery banner, not a log line, so it counts things the way a person
 * writes them.
 */
fun countOf(count: Int, singular: String, plural: String = "${singular}s"): String =
    "$count ${if (count == 1) singular else plural}"

/**
 * A moment rendered the way the rest of the app writes dates. The same
 * reasoning as [countOf]: an ISO-8601 instant is right for a cursor and wrong
 * for a sentence. Zone and locale are injectable so a test can pin them.
 */
fun readableMoment(
    millis: Long,
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): String = Instant.ofEpochMilli(millis)
    .atZone(zone)
    .format(DateTimeFormatter.ofPattern("d MMM yyyy, HH:mm", locale))
