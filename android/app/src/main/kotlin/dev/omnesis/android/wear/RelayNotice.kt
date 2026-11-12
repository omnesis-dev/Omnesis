// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.WearLine

/**
 * What the phone tells the person about a watch relay that did not end on the
 * watch. Never silent: the watch said it was sent.
 */
data class RelayNotice(
    val title: String,
    val body: String,
    /** The conversation a tap opens, when the relay reached one. */
    val conversationId: String? = null,
    /**
     * Notices sharing a slot replace each other, so a recording retried many
     * times leaves one notice. Null for a notice that stands on its own.
     */
    val slot: String? = null,
) {
    companion object {
        /** Banner length, matching the gateway's slow-answer push so both read the same. */
        internal const val MAX_BODY_LENGTH = 175

        private const val CAPTURE_SLOT = "watch-capture"

        /** A recorded note could not be saved. */
        val voiceNoteFailed = RelayNotice(
            title = "Couldn't save your voice note",
            body = "The note you recorded on your watch couldn't be saved. Record it again.",
        )

        /** A note typed or dictated as text could not be saved. */
        val textNoteFailed = RelayNotice(
            title = "Couldn't save your watch note",
            body = "The note you sent from your watch couldn't be saved. Write it again.",
        )

        /** A queued question arrived too late to be worth asking. */
        val questionExpired = RelayNotice(
            title = "Your watch question wasn't asked",
            body = "It reached your phone too late to be worth answering. Ask it again if you still need to.",
        )

        /** A recording could not be processed yet and is kept. */
        val captureDelayed =
            RelayNotice(WearLine.CAPTURE_NOTICE_TITLE.text, WearLine.CAPTURE_DELAYED.text, slot = CAPTURE_SLOT)

        /** A recording waited a week and was removed. */
        val captureExpired =
            RelayNotice(WearLine.CAPTURE_NOTICE_TITLE.text, WearLine.CAPTURE_EXPIRED.text, slot = CAPTURE_SLOT)

        /** A recording whose processing kept ending the app was given up. */
        val captureAbandoned =
            RelayNotice(WearLine.CAPTURE_NOTICE_TITLE.text, WearLine.RECORDING_NOT_SAVED.text, slot = CAPTURE_SLOT)

        /** The process ended while a recorded question was being asked. */
        val askInterrupted =
            RelayNotice(WearLine.CAPTURE_NOTICE_TITLE.text, WearLine.CAPTURE_ASK_INTERRUPTED.text, slot = CAPTURE_SLOT)

        /**
         * The notice for a question whose answer the watch did not show, or null
         * when the gateway's push is the one to announce it: a turn still
         * running when the phone stopped following it.
         */
        fun queuedAsk(outcome: AskOutcome, conversationId: String?): RelayNotice? = when (outcome) {
            AskOutcome.StillWorking, AskOutcome.PreviousTurnRunning -> null
            is AskOutcome.Answered -> RelayNotice("Answer ready", clipped(outcome.text), conversationId)
            AskOutcome.EmptyAnswer, is AskOutcome.Failed ->
                RelayNotice("Answer failed", clipped(WearLine.forOutcome(outcome)), conversationId)
            AskOutcome.NotPaired, AskOutcome.ExperimentalOff, AskOutcome.Unauthorized, AskOutcome.Unreachable,
            AskOutcome.SendFailed, AskOutcome.PhoneUnreachable, AskOutcome.WatchLinkInactive,
            AskOutcome.RelayFailed, AskOutcome.AnswerOnPhone, AskOutcome.QueuedForPhone,
            -> RelayNotice("Couldn't ask your watch question", clipped(WearLine.forOutcome(outcome)), conversationId)
        }

        /** One line, clipped to banner length with an ellipsis marking the cut. */
        internal fun clipped(text: String): String {
            val collapsed = text.split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
            return if (collapsed.length > MAX_BODY_LENGTH) collapsed.take(MAX_BODY_LENGTH - 1) + "…" else collapsed
        }
    }
}
