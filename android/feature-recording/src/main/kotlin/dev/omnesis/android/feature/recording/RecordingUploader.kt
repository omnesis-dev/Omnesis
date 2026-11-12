// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.PersonSummary
import dev.omnesis.android.transport.dto.RecordingSpeakerDto
import dev.omnesis.android.transport.dto.RecordingSummaryDto
import dev.omnesis.android.transport.dto.SpeakerMapping

/**
 * What the uploader needs of the gateway; the app binds it to
 * `RecordingsClient` on the live session. Every call is idempotent on the
 * gateway, so a call whose reply was lost is simply repeated.
 */
interface RecordingsGateway {
    /** Whether the gateway advertises the recordings capability right now. */
    suspend fun accepting(): Boolean
    suspend fun start(session: OutboxSession)
    suspend fun putChunk(chunk: OutboxChunk)
    suspend fun finish(sessionId: String, chunkCount: Int, endedAt: String)
    suspend fun delete(sessionId: String)

    /** The gateway's most recent recordings, newest first. */
    suspend fun recent(limit: Int): List<RecordingSummaryDto>

    /** Who spoke in a recording; empty when the gateway did not tell them apart. */
    suspend fun speakers(sessionId: String): List<RecordingSpeakerDto>

    /** Say who [speaker] is; answers the recording's speakers as they now stand. */
    suspend fun setSpeaker(sessionId: String, speaker: Int, mapping: SpeakerMapping): List<RecordingSpeakerDto>

    /** People matching [query] (`GET /people?q=`), for choosing who a speaker is. */
    suspend fun searchPeople(query: String, limit: Int): List<PersonSummary>
}

/**
 * Drains the [RecordingOutbox] to the gateway: for each session, its start,
 * then its chunks in recording order, then — once recording stopped and every
 * chunk is acknowledged — its finish. Sessions are sent oldest first.
 *
 * Nothing is sent unless the gateway advertises the recordings capability. A
 * failure that may clear leaves the session in place for the next attempt and
 * moves on to the next session; the drain then ends in [Result.Retry]. A 404
 * is one of those: the gateway may have dropped or not yet stored the session,
 * so the session's start is sent again next time. Only a request the gateway
 * rejects as invalid (400, 409, 413) marks the session refused; its audio stays
 * on the phone until the owner deletes the recording.
 */
class RecordingUploader(
    private val outbox: RecordingOutbox,
    private val gateway: RecordingsGateway,
) {
    sealed interface Result {
        /** Everything sendable was acknowledged; [sent] calls succeeded on the way. */
        data class Done(val sent: Int) : Result
        /** A failure that may clear; try again later. */
        data class Retry(val reason: String) : Result
    }

    suspend fun drain(): Result {
        val accepting = try {
            gateway.accepting()
        } catch (e: GatewayException) {
            return Result.Retry(e.message ?: "gateway error")
        }
        if (!accepting) return Result.Retry("the gateway does not advertise recordings")
        var retry: String? = null
        var sent = 0
        for (session in outbox.sessions()) {
            if (session.finished || session.refusal != null) continue
            try {
                send(session) { sent++ }
            } catch (e: GatewayException) {
                if (e is GatewayException.NotFound) outbox.setCreated(session.id, false)
                val refusal = permanentRefusal(e)
                if (refusal != null) {
                    outbox.markRefused(session.id, refusal)
                } else {
                    retry = retry ?: (e.message ?: "gateway error")
                }
            }
        }
        return retry?.let { Result.Retry(it) } ?: Result.Done(sent)
    }

    /** Send what [session] still owes the gateway, calling [onSent] after each acknowledged call. */
    private suspend fun send(session: OutboxSession, onSent: () -> Unit) {
        if (!session.created) {
            gateway.start(session)
            outbox.setCreated(session.id, true)
            onSent()
        }
        for (chunk in outbox.pendingChunks(session.id).sortedBy { it.seq }) {
            gateway.putChunk(withAudioOrGap(chunk))
            outbox.ackChunk(chunk.sessionId, chunk.seq)
            onSent()
        }
        val chunkCount = session.chunkCount ?: return
        val endedAt = session.endedAt ?: return
        // A chunk recorded after `pendingChunks` was read is sent on the next drain.
        if (outbox.pendingChunks(session.id).isNotEmpty()) return
        gateway.finish(session.id, chunkCount, endedAt)
        outbox.markFinished(session.id)
        onSent()
    }

    companion object {
        /**
         * A chunk whose audio file is gone is sent as an interrupted silent
         * chunk, so its number still reaches the gateway and the sequence
         * stays dense.
         */
        fun withAudioOrGap(chunk: OutboxChunk): OutboxChunk =
            if (chunk.silent || chunk.file?.exists() == true) {
                chunk
            } else {
                chunk.copy(silent = true, interrupted = true, file = null, mimeType = null)
            }

        /**
         * The reason a gateway answer means the session can never be sent, or
         * null when trying again may work: a 400 (invalid request), a 409 (a
         * chunk past the end, a conflicting finish) or a 413 (too large).
         * Gateway transcription switched off is not one: the operator may
         * switch it back on, and the audio waits.
         */
        fun permanentRefusal(e: GatewayException): String? = when (e) {
            is GatewayException.ServerError -> when {
                e.code == "DICTATION_DISABLED" -> null
                e.status in PERMANENT_STATUSES -> e.body ?: "The gateway refused the recording (${e.status})."
                else -> null
            }
            else -> null
        }

        private val PERMANENT_STATUSES = setOf(400, 409, 413)
    }
}
