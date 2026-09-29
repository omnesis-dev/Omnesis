// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.TranscriptionDto
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.decodeBody
import dev.omnesis.android.transport.http.postBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import java.io.File
import java.time.Duration

/**
 * Client for gateway dictation (`POST /dictation/transcribe`, experimental): the
 * phone posts the audio it recorded and receives the transcript. Every refusal the
 * route documents is returned as a typed [DictationOutcome] rather than thrown, so
 * the recording surface decides per case whether the recording is worth keeping
 * for a retry. See `packages/gateway/src/http/routes/dictation.ts`.
 */
class DictationClient(private val http: GatewayHttp) {

    /**
     * Sends [audio] as the raw request body. [language] is an ISO 639 hint the
     * gateway ignores when it is not one; null lets the transcriber detect it.
     */
    suspend fun transcribe(audio: File, mimeType: String, language: String?): DictationOutcome {
        val body = try {
            http.postBody(
                path = "dictation/transcribe",
                query = language?.let { mapOf("language" to it) } ?: emptyMap(),
                body = audio.asRequestBody(mimeType.toMediaType()),
                timeout = TRANSCRIBE_TIMEOUT,
            )
        } catch (e: GatewayException) {
            return outcomeFor(e)
        }
        val result = try {
            decodeBody<TranscriptionDto>(body)
        } catch (e: GatewayException) {
            return DictationOutcome.Failed(e)
        }
        return DictationOutcome.Transcribed(result.text, result.language, result.durationSec)
    }

    private fun outcomeFor(e: GatewayException): DictationOutcome = when {
        e is GatewayException.Network -> DictationOutcome.Unreachable(e)
        e is GatewayException.NotFound -> DictationOutcome.Unsupported
        e is GatewayException.ServerError && e.code == "DICTATION_DISABLED" -> DictationOutcome.Disabled
        e is GatewayException.ServerError && e.code == "TRANSCRIBER_UNAVAILABLE" ->
            DictationOutcome.TranscriberUnavailable(e.body)
        e is GatewayException.ServerError && (e.code == "PAYLOAD_TOO_LARGE" || e.status == 413) ->
            DictationOutcome.TooLarge
        else -> DictationOutcome.Failed(e)
    }

    companion object {
        /**
         * A cold transcriber loads its model on the first request, which takes
         * seconds on top of the transcription itself.
         */
        val TRANSCRIBE_TIMEOUT: Duration = Duration.ofSeconds(60)
    }
}

/** What became of one `POST /dictation/transcribe`. */
sealed interface DictationOutcome {
    data class Transcribed(val text: String, val language: String?, val durationSec: Double?) : DictationOutcome

    /** 404: the gateway is not in experimental mode, or predates the route. */
    data object Unsupported : DictationOutcome

    /** 409 `DICTATION_DISABLED`: the operator has not switched gateway dictation on. */
    data object Disabled : DictationOutcome

    /** 503 `TRANSCRIBER_UNAVAILABLE`: no runnable transcriber, or this transcription failed. */
    data class TranscriberUnavailable(val message: String?) : DictationOutcome

    /** 413 `PAYLOAD_TOO_LARGE`: the recording is over the advertised `maxAudioBytes`. */
    data object TooLarge : DictationOutcome

    /** The gateway could not be reached, or the connection dropped mid-request. */
    data class Unreachable(val error: GatewayException) : DictationOutcome

    /** Any other failure: authorization, an unexpected status, an unreadable reply. */
    data class Failed(val error: GatewayException) : DictationOutcome
}
