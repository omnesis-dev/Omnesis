// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import kotlinx.serialization.Serializable
import kotlin.time.Duration
import kotlin.time.Duration.Companion.days
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

/** One waiting note or recording, as the watch's outbox records it. */
@Serializable
data class OutboxEntry(
    val content: OutboxContent,
    val queuedAt: EpochMillis,
    /** Deliveries that ended in an error. */
    val failures: Int = 0,
    val lastFailureAt: EpochMillis? = null,
) {
    val ref: String get() = content.ref

    /** A note dictated as text, with no recording. */
    val isTextNote: Boolean get() = content is TextNote

    /** This entry after a delivery failed at [now]. */
    fun failed(now: EpochMillis): OutboxEntry = copy(failures = failures + 1, lastFailureAt = now)
}

/**
 * What the watch does with each note and recording waiting for the phone.
 *
 * Something counts as sent once it is safely in the outbox, whatever the state
 * of the link. From there it is handed to the Data Layer, and handed again
 * whenever nothing carries it: at launch, when the phone becomes reachable,
 * after a delivery fails (then after a backoff, so a failing link is not
 * hammered), and every [UNCARRIED_RECHECK] while no phone app is there to
 * take it. It leaves the outbox only when the phone confirms it (a
 * [NoteAck] or [RecordingReceipt] naming its ref) or when it has waited so
 * long it is dropped, and the person is told. Every copy carries the same ref,
 * so the phone acts on it once. The iOS counterpart is `WatchOutboxPolicy` in
 * `WatchVoice.swift`.
 */
object OutboxPolicy {
    /** How long an entry may wait for the phone before it is dropped. */
    val RETENTION: Duration = 7.days

    /**
     * The most entries kept waiting; the oldest beyond it are dropped. Two
     * minutes of speech at the watch's bit rate is about 360 KB, so this
     * bounds the outbox to a few tens of megabytes.
     */
    const val MAX_ENTRIES = 50

    /**
     * How often an entry nothing carries is offered again while it is not
     * backing off: no phone runs the phone app, so nothing took it and
     * nothing failed. The phone app appearing normally prompts a pass at
     * once; this is the pass that happens when that prompt never comes.
     */
    val UNCARRIED_RECHECK: Duration = 15.minutes

    private val BACKOFF: List<Duration> = listOf(30.seconds, 2.minutes, 10.minutes, 30.minutes, 60.minutes)

    /** How an entry is handed over. */
    enum class Transport {
        /** A recording goes as a DataItem carrying its audio. */
        RECORDING_ITEM,

        /** A text note to a reachable phone goes as a request, whose reply confirms it at once. */
        LIVE_MESSAGE,

        /** A text note to a phone out of reach goes as a queued DataItem. */
        QUEUED_ITEM,
    }

    fun transport(entry: OutboxEntry, phoneReachable: Boolean): Transport = when {
        !entry.isTextNote -> Transport.RECORDING_ITEM
        phoneReachable -> Transport.LIVE_MESSAGE
        else -> Transport.QUEUED_ITEM
    }

    /** What set the outbox moving. */
    enum class Trigger {
        /** Launch, or the phone becoming reachable: every waiting entry is sent. */
        LINK_MAY_HAVE_CHANGED,

        /** A delivery failed, or a backoff ran out: failed entries wait out their backoff. */
        RETRY,
    }

    enum class Action {
        /** Hand it to the Data Layer. */
        SEND,

        /** Something carries it already, or it is waiting out a backoff. */
        WAIT,

        /** Waited too long, or pushed out by newer entries: delete it and say so. */
        DROP,
    }

    /** The pause before an entry that failed [failures] times is sent again. */
    fun backoff(failures: Int): Duration = BACKOFF[failures.coerceIn(1, BACKOFF.size) - 1]

    /**
     * What to do with each entry, by ref. [carried] are the refs a delivery
     * is already carrying, which are never sent twice.
     */
    fun plan(
        entries: List<OutboxEntry>,
        carried: Set<String>,
        trigger: Trigger,
        now: EpochMillis,
    ): Map<String, Action> {
        val actions = LinkedHashMap<String, Action>()
        entries.sortedByDescending { it.queuedAt }.forEachIndexed { index, entry ->
            actions[entry.ref] = when {
                index >= MAX_ENTRIES || (now - entry.queuedAt).milliseconds > RETENTION -> Action.DROP
                entry.ref in carried -> Action.WAIT
                trigger == Trigger.RETRY && backoffEnd(entry)?.let { now < it } == true -> Action.WAIT
                else -> Action.SEND
            }
        }
        return actions
    }

    /**
     * When the outbox next needs a pass that nothing else will prompt, or
     * null when it is empty. A non-empty outbox always has one coming: for an
     * entry nothing carries, when its backoff ends, or after
     * [UNCARRIED_RECHECK] when it is not backing off; and for every entry,
     * carried or not, the moment it has waited long enough to be dropped, so
     * that the person is told.
     */
    fun nextRetry(entries: List<OutboxEntry>, carried: Set<String>, now: EpochMillis): EpochMillis? {
        val handOvers = entries.filter { it.ref !in carried }.map { entry ->
            backoffEnd(entry)?.takeIf { it > now } ?: (now + UNCARRIED_RECHECK.inWholeMilliseconds)
        }
        val expiries = entries.map { it.queuedAt + RETENTION.inWholeMilliseconds + 1 }
        return (handOvers + expiries).minOrNull()
    }

    /** When a failed entry's backoff ends, or null for one that has not failed. */
    private fun backoffEnd(entry: OutboxEntry): EpochMillis? {
        val failedAt = entry.lastFailureAt ?: return null
        if (entry.failures <= 0) return null
        return failedAt + backoff(entry.failures).inWholeMilliseconds
    }
}
