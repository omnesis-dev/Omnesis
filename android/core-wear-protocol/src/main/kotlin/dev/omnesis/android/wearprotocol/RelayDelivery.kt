// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds

/**
 * How long the watch keeps trying to hand a question or note to the phone app
 * live before queueing it. A phone app the system has evicted takes a while
 * to start: the first send starts it, and a later send lands once it is up.
 * Only an unreachable phone is retried; any other outcome means the phone has
 * the relay, so a question is never asked twice. The iOS counterpart is
 * `WatchRelayPatience` in `WatchRelayDelivery.swift`.
 */
object RelayPatience {
    /** Total time spent on live delivery, measured from the first attempt. */
    val DELIVERY_WINDOW: Duration = 20.seconds

    /**
     * The longest the watch waits on one send for the phone's reply. Past it
     * the answer exists or will, but did not reach the watch
     * ([AskOutcome.AnswerOnPhone]).
     */
    val SEND_TIMEOUT: Duration = 70.seconds

    /**
     * How long the phone waits for the watch's [DisplayedReceipt] before
     * treating an answer as not shown.
     */
    val DISPLAYED_REPLY_TIMEOUT: Duration = 2.seconds

    // Short at first, when a suspended app is about to answer, then longer
    // while a cold start completes. The last entry repeats.
    private val PAUSES: List<Duration> = listOf(0.7.seconds, 1.5.seconds, 2.5.seconds, 3.seconds)

    /**
     * The pause before the next attempt, or null when another attempt would
     * start past [DELIVERY_WINDOW]. [attempts] counts sends already made;
     * [elapsed] is the time since the first began.
     */
    fun pause(attempts: Int, elapsed: Duration): Duration? {
        val pause = PAUSES[attempts.coerceIn(1, PAUSES.size) - 1]
        return pause.takeIf { elapsed + it < DELIVERY_WINDOW }
    }
}

/** The rules for a relay the phone app never took live. */
object RelayQueue {
    /**
     * A queued question older than this is dropped rather than answered: its
     * answer arrives as a notification, and one for a question asked long ago
     * reads as unprompted. A note has no such limit.
     */
    val ASK_EXPIRY: Duration = 10.minutes

    /**
     * Whether a question queued at [queuedAt] is too old to answer. A queued
     * time in the future (the two clocks disagree) is fresh.
     */
    fun askIsExpired(queuedAt: EpochMillis, now: EpochMillis): Boolean = (now - queuedAt).milliseconds > ASK_EXPIRY
}

/**
 * The relay refs the phone has already acted on, so a relay that arrives both
 * live and queued is handled once. Bounded and in memory: it covers the
 * minutes in which both copies could arrive. Not thread-safe.
 */
class RecentRefs {
    private val refs = ArrayDeque<String>()

    /**
     * Record [ref], returning false when it was already recorded. A relay
     * without a ref is always new.
     */
    fun insert(ref: String?): Boolean {
        if (ref == null) return true
        if (ref in refs) return false
        refs.addLast(ref)
        while (refs.size > CAPACITY) refs.removeFirst()
        return true
    }

    companion object {
        const val CAPACITY = 32
    }
}

/** What the phone does with a relay the watch queued. */
object RelayInbox {
    sealed interface Action {
        data class SaveNote(val ref: String, val text: String, val captureTime: NoteCaptureTime) : Action

        data class Ask(val ref: String, val question: String, val conversationId: String?) : Action

        data class Drop(val reason: DropReason) : Action
    }

    enum class DropReason {
        /** A note whose capture fields do not describe a real time. */
        NOTE_WITHOUT_CAPTURE_TIME,

        /** Neither a question nor a note, or one with nothing in it. */
        UNKNOWN_KIND,

        /** A question asked longer ago than [RelayQueue.ASK_EXPIRY]. */
        EXPIRED,

        /** Already acted on from another copy of the same relay. */
        DUPLICATE,
    }

    /**
     * Decide what to do with [queued], recording its ref in [handled] when it
     * is acted on. A dropped relay does not spend its ref.
     */
    fun route(queued: QueuedRelay, now: EpochMillis, handled: RecentRefs): Action =
        when (val message = queued.message) {
            is TextNote -> routeNote(message, handled)
            is AskRequest -> routeAsk(message, queued.queuedAt, now, handled)
            else -> Action.Drop(DropReason.UNKNOWN_KIND)
        }

    private fun routeNote(note: TextNote, handled: RecentRefs): Action {
        val text = note.trimmedText ?: return Action.Drop(DropReason.UNKNOWN_KIND)
        val captureTime = note.captureTime ?: return Action.Drop(DropReason.NOTE_WITHOUT_CAPTURE_TIME)
        if (!handled.insert(note.ref)) return Action.Drop(DropReason.DUPLICATE)
        return Action.SaveNote(note.ref, text, captureTime)
    }

    private fun routeAsk(ask: AskRequest, queuedAt: EpochMillis, now: EpochMillis, handled: RecentRefs): Action {
        val question = ask.trimmedQuestion ?: return Action.Drop(DropReason.UNKNOWN_KIND)
        if (RelayQueue.askIsExpired(queuedAt, now)) return Action.Drop(DropReason.EXPIRED)
        if (!handled.insert(ask.ref)) return Action.Drop(DropReason.DUPLICATE)
        return Action.Ask(ask.ref, question, ask.resumedConversationId)
    }
}

/**
 * The live questions the phone is answering, by ref, so a later copy of one
 * is answered from the first rather than run again: a send the watch saw fail
 * can still have landed, and its retry then arrives while, or after, the
 * first copy runs. [Waiter] is whatever the phone holds to reply to a copy.
 * Not thread-safe.
 */
class LiveAskLedger<Waiter> {
    sealed interface Claim {
        /** The first copy: run the question, then [settle] it. */
        data object Run : Claim

        /** A later copy of a question still running; its waiter is held. */
        data object Held : Claim

        /** A later copy of a question that settled with this result. */
        data class Reply(val result: AskResult) : Claim

        /** A later copy of a question this ledger no longer tracks. */
        data object Untracked : Claim
    }

    private sealed interface Entry<out W> {
        data class Running<W>(val waiting: List<W>) : Entry<W>

        data class Settled(val result: AskResult) : Entry<Nothing>
    }

    private val entries = LinkedHashMap<String, Entry<Waiter>>()

    /**
     * Claim [ref] for a live copy that arrived with [waiter]. [isNew] says
     * whether the ref was unseen by the phone's [RecentRefs].
     */
    fun claim(ref: String, isNew: Boolean, waiter: Waiter): Claim {
        if (isNew) {
            entries.remove(ref)
            entries[ref] = Entry.Running(emptyList())
            while (entries.size > RecentRefs.CAPACITY) entries.remove(entries.keys.first())
            return Claim.Run
        }
        return when (val entry = entries[ref]) {
            is Entry.Running -> {
                entries[ref] = Entry.Running(entry.waiting + waiter)
                Claim.Held
            }
            is Entry.Settled -> Claim.Reply(entry.result)
            null -> Claim.Untracked
        }
    }

    /** Record the first copy's result and return the later copies waiting on it. */
    fun settle(ref: String, result: AskResult): List<Waiter> {
        val running = entries[ref] as? Entry.Running ?: return emptyList()
        entries[ref] = Entry.Settled(result)
        return running.waiting
    }
}

/**
 * What the phone remembers about recordings it has finished with. Unlike
 * [RecentRefs] this is kept on disk, because a recording's DataItem can
 * arrive again long after the process that handled it ended.
 */
object RecordingInboxPolicy {
    /** Processing attempts before a recording is given up and the person is told. */
    const val MAX_ATTEMPTS = 3

    /**
     * How long a completed ref is remembered: twice as long as the watch can
     * keep sending the recording, so no copy outlives its receipt.
     */
    val RECEIPT_RETENTION: Duration = OutboxPolicy.RETENTION * 2

    /** Whether a recording captured at [capturedAt] is too old to process. */
    fun recordingIsExpired(capturedAt: EpochMillis, now: EpochMillis): Boolean =
        (now - capturedAt).milliseconds > OutboxPolicy.RETENTION

    /** Whether the receipt for a ref completed at [completedAt] can be forgotten. */
    fun receiptIsExpired(completedAt: EpochMillis, now: EpochMillis): Boolean =
        (now - completedAt).milliseconds > RECEIPT_RETENTION
}
