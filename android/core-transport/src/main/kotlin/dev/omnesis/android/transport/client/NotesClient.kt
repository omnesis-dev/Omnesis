// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.CreateNoteBody
import dev.omnesis.android.transport.dto.NoteEntryDto
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.VoiceNoteAcceptedDto
import dev.omnesis.android.transport.dto.VoiceNoteBody
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.postBody
import dev.omnesis.android.transport.http.postJson
import java.io.File
import java.time.Duration
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody

/**
 * Client for the gateway's quick-capture `/notes` surface ("Tell Omnesis").
 * Auth is the standard device bearer token. Older gateways 404 every route,
 * which [GatewayHttp] maps to `GatewayException.NotFound`.
 */
class NotesClient(private val http: GatewayHttp) {

    /** `POST /notes` — capture one note; returns the stored entry (201). */
    suspend fun create(body: CreateNoteBody): NoteEntryDto =
        http.postJson("notes", body)

    /**
     * `POST /notes/voice` — capture a note with the audio it was dictated
     * from; the gateway saves it at once (202) and replaces its text with its own
     * transcript later. Idempotent per [VoiceNoteBody.id]. A gateway that
     * predates the route answers 404; one with dictation switched
     * off 409 `DICTATION_DISABLED`; one without a runnable transcriber 503
     * `TRANSCRIBER_UNAVAILABLE`. All surface as [dev.omnesis.android.transport.GatewayException].
     */
    suspend fun createVoice(note: VoiceNoteBody, audio: File, audioMimeType: String): VoiceNoteAcceptedDto =
        http.postBody("notes/voice", voiceNoteBody(note, audio, audioMimeType), VOICE_UPLOAD_TIMEOUT)

    companion object {
        /** Minutes of audio over a phone's uplink outlast the ordinary API timeout. */
        val VOICE_UPLOAD_TIMEOUT: Duration = Duration.ofMinutes(3)

        /** The multipart body: a `note` JSON part, then the `audio` file part. */
        fun voiceNoteBody(note: VoiceNoteBody, audio: File, audioMimeType: String): MultipartBody =
            MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("note", OmnesisJson.encodeToString(note))
                .addFormDataPart("audio", audio.name, audio.asRequestBody(audioMimeType.toMediaType()))
                .build()
    }
}
