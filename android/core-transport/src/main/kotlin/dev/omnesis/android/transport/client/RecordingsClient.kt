// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.FinishRecordingBody
import dev.omnesis.android.transport.dto.RecordingChunkAckDto
import dev.omnesis.android.transport.dto.RecordingChunkMetadata
import dev.omnesis.android.transport.dto.RecordingStatusDto
import dev.omnesis.android.transport.dto.StartRecordingBody
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.deleteSegments
import dev.omnesis.android.transport.http.getPrivateJson
import dev.omnesis.android.transport.http.postJson
import dev.omnesis.android.transport.http.postJsonSegments
import dev.omnesis.android.transport.http.putBodySegments
import java.io.File
import java.time.Duration
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody

/**
 * The gateway's recorded-conversation routes (experimental; a gateway without
 * them answers 404). Every call is idempotent, so an outbox may repeat any of
 * them after a lost reply.
 */
class RecordingsClient(private val http: GatewayHttp) {
    /** `POST /recordings` — 201 for a new session, 200 for a retry. 409 `DICTATION_DISABLED` when transcription is off. */
    suspend fun start(body: StartRecordingBody): RecordingStatusDto = http.postJson("recordings", body)

    /**
     * `PUT /recordings/:id/chunks/:seq` — one chunk; [audio] is null for a silent one.
     * 404 when the session is unknown, 409 when [seq] lies past a finished session's count.
     */
    suspend fun putChunk(
        id: String,
        seq: Int,
        metadata: RecordingChunkMetadata,
        audio: File?,
        audioMimeType: String?,
    ): RecordingChunkAckDto =
        http.putBodySegments(
            listOf("recordings", id, "chunks", seq.toString()),
            chunkBody(metadata, audio, audioMimeType),
            CHUNK_UPLOAD_TIMEOUT,
        )

    /** `POST /recordings/:id/finish` — idempotent; 409 when a different count was declared. */
    suspend fun finish(id: String, body: FinishRecordingBody): RecordingStatusDto =
        http.postJsonSegments(listOf("recordings", id, "finish"), body)

    suspend fun status(id: String): RecordingStatusDto = http.getPrivateJson(listOf("recordings", id))

    /** `DELETE /recordings/:id` — the session, its chunks and its document. */
    suspend fun delete(id: String) = http.deleteSegments(listOf("recordings", id))

    companion object {
        /** A chunk is about a minute of compressed audio; a slow uplink still gets it through. */
        val CHUNK_UPLOAD_TIMEOUT: Duration = Duration.ofMinutes(2)

        fun chunkBody(metadata: RecordingChunkMetadata, audio: File?, audioMimeType: String?): MultipartBody =
            MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("chunk", OmnesisJson.encodeToString(metadata))
                .apply {
                    if (audio != null) {
                        val type = (audioMimeType ?: "application/octet-stream").toMediaType()
                        addFormDataPart("audio", audio.name, audio.asRequestBody(type))
                    }
                }
                .build()
    }
}
