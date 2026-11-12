// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.AskActivityEvent
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.NoteCaptureTime
import dev.omnesis.android.wearprotocol.NoteOutcome
import java.io.File

/** How a question the watch relayed ended, and what following it up or announcing it needs. */
data class AskRun(
    val outcome: AskOutcome,
    /** The conversation the question went to, when it reached one. */
    val conversationId: String? = null,
    /** The assistant message holding the answer, once the question was posted. */
    val messageId: String? = null,
    /** No gateway notification will announce this outcome, so the phone must when the watch does not show it. */
    val notifyLocally: Boolean = false,
)

/** Asks the paired gateway on the watch's behalf. */
interface WatchAsker {
    /** A question the watch is waiting on, with its milestones reported as they happen. */
    suspend fun ask(question: String, resuming: String?, onActivity: (AskActivityEvent) -> Unit): AskRun

    /** A question nobody is waiting on: its answer reaches the person as a notification. */
    suspend fun handOff(question: String, resuming: String?): AskRun

    /**
     * A recorded question on a gateway that announces every answer itself and
     * withdraws the announcement once told the answer was seen.
     */
    suspend fun capture(question: String, resuming: String?, onActivity: (AskActivityEvent) -> Unit): AskRun
}

/** Saves a note the watch relayed through the phone's own note pipeline. */
fun interface WatchNoteSaver {
    /**
     * Saves [text] captured at [captureTime], which carries the watch's own
     * time zone. [ref] is the relay's ref, the note's idempotency key when it
     * is a UUID. With [audio] the note is a voice note for the gateway to
     * transcribe and [text] may be empty; the file is copied, never consumed,
     * and [locale] is the language tag the watch recorded it under, null when
     * it named none.
     *
     * [NoteOutcome.REJECTED] says the gateway will never take this note;
     * [NoteOutcome.CAPTURE_FAILED] that it could not be kept this time.
     */
    suspend fun save(text: String, captureTime: NoteCaptureTime, ref: String, audio: File?, locale: String?): NoteOutcome
}

/** What the paired gateway says about recordings, read when one is processed. */
data class CaptureGatewayStatus(
    /** The gateway transcribes voice notes. */
    val gatewayDictation: Boolean,
    /** The gateway announces a recorded question's answer itself. */
    val completionNotifications: Boolean,
)

/** The gateway calls a recording's processing makes. Every call throws when it cannot be made. */
interface CaptureBackend {
    suspend fun status(): CaptureGatewayStatus

    /** The gateway's transcript of [audio], null when it has none. */
    suspend fun transcribe(audio: File, locale: String?): String?

    /** Whether what was said is a question or a note. Never [CaptureRoute.AUTOMATIC]. */
    suspend fun classify(text: String): CaptureRoute

    /** Tells the gateway the watch showed the answer [messageId] of [conversationId]. */
    suspend fun markSeen(conversationId: String, messageId: String)
}

/** Transcribes a recording on this phone, null when it cannot or heard nothing. */
fun interface CaptureTranscriber {
    suspend fun transcribe(audio: File, locale: String?): String?
}

/** Posts a notification about a relay; a phone that may not post drops it. */
fun interface RelayNotifier {
    fun post(notice: RelayNotice)
}

/** Asks for recordings kept for retry to be processed again once the gateway may be reachable. */
fun interface RetryScheduler {
    fun retryLater()
}
