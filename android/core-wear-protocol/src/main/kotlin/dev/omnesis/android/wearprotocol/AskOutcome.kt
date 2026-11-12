// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

/**
 * How a relayed question ended. The phone produces the gateway outcomes; the
 * watch adds the relay outcomes only it can observe. The iOS counterpart is
 * `SiriAskOutcome` in `SiriAsk.swift`.
 */
sealed interface AskOutcome {
    /** Stable wire discriminator, carried as `outcome` on [AskResult] and [CaptureAnswer]. */
    val tag: String

    /** The turn settled with this answer (non-empty). */
    data class Answered(val text: String) : AskOutcome {
        override val tag: String get() = TAG
        internal companion object { const val TAG = "answered" }
    }

    /** The turn settled but produced no text. */
    data object EmptyAnswer : AskOutcome {
        override val tag: String get() = "emptyAnswer"
    }

    /**
     * The turn died. [reason] is the gateway's own sentence naming the
     * condition when it sent one.
     */
    data class Failed(val reason: String? = null) : AskOutcome {
        override val tag: String get() = TAG
        internal companion object { const val TAG = "failed" }
    }

    /** The wait ran out with the turn still running; the answer arrives as a notification. */
    data object StillWorking : AskOutcome {
        override val tag: String get() = "stillWorking"
    }

    /** The resumed conversation's previous turn is still running. */
    data object PreviousTurnRunning : AskOutcome {
        override val tag: String get() = "previousTurnRunning"
    }

    /** The phone is not paired with a gateway. */
    data object NotPaired : AskOutcome {
        override val tag: String get() = "notPaired"
    }

    /** The gateway predates asking by voice. */
    data object ExperimentalOff : AskOutcome {
        override val tag: String get() = "experimentalOff"
    }

    /** The gateway rejected the phone's token. */
    data object Unauthorized : AskOutcome {
        override val tag: String get() = "unauthorized"
    }

    /** The phone could not reach the gateway. */
    data object Unreachable : AskOutcome {
        override val tag: String get() = "unreachable"
    }

    /** The question reached a session but the send failed. */
    data object SendFailed : AskOutcome {
        override val tag: String get() = "sendFailed"
    }

    /** Watch only: no phone could be reached to relay the question. */
    data object PhoneUnreachable : AskOutcome {
        override val tag: String get() = "phoneUnreachable"
    }

    /** Watch only: the watch's own Data Layer connection is not usable. */
    data object WatchLinkInactive : AskOutcome {
        override val tag: String get() = "watchLinkInactive"
    }

    /** Watch only: the relay failed for another reason, or its result could not be read. */
    data object RelayFailed : AskOutcome {
        override val tag: String get() = "relayFailed"
    }

    /** Watch only: the turn finished but its answer never reached the watch. */
    data object AnswerOnPhone : AskOutcome {
        override val tag: String get() = "answerOnPhone"
    }

    /** Watch only: the phone never took the question live, so it was queued. */
    data object QueuedForPhone : AskOutcome {
        override val tag: String get() = "queuedForPhone"
    }

    /** How a screen presents an outcome. */
    enum class Kind {
        /** What the person asked for. */
        ANSWER,

        /** Neither success nor failure: the work continues elsewhere. */
        STATUS,

        /** Something went wrong. */
        FAILURE,
    }

    val kind: Kind
        get() = when (this) {
            is Answered -> Kind.ANSWER
            StillWorking, PreviousTurnRunning, AnswerOnPhone, QueuedForPhone -> Kind.STATUS
            EmptyAnswer, is Failed, NotPaired, ExperimentalOff, Unauthorized, Unreachable,
            SendFailed, PhoneUnreachable, WatchLinkInactive, RelayFailed,
            -> Kind.FAILURE
        }

    /**
     * The `text` that travels with [tag]: the answer, or a failure's reason.
     * Both share one field because the tag already says which it is.
     */
    val wireText: String?
        get() = when (this) {
            is Answered -> text
            is Failed -> reason?.takeIf { it.isNotEmpty() }
            else -> null
        }

    companion object {
        private val parameterless: Map<String, AskOutcome> = listOf(
            EmptyAnswer, StillWorking, PreviousTurnRunning, NotPaired, ExperimentalOff,
            Unauthorized, Unreachable, SendFailed, PhoneUnreachable, WatchLinkInactive,
            RelayFailed, AnswerOnPhone, QueuedForPhone,
        ).associateBy { it.tag }

        /**
         * The outcome a received tag and text describe. A tag this build does
         * not know reads as [RelayFailed], so a newer peer degrades to a
         * stated failure.
         */
        fun fromWire(tag: String, text: String?): AskOutcome = when (tag) {
            Answered.TAG -> Answered(text.orEmpty())
            Failed.TAG -> Failed(text)
            else -> parameterless[tag] ?: RelayFailed
        }
    }
}
