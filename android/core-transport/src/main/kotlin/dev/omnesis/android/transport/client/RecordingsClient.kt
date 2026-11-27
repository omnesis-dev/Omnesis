// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.FinishRecordingBody
import dev.omnesis.android.transport.dto.NewParticipant
import dev.omnesis.android.transport.dto.RecordingChunkAckDto
import dev.omnesis.android.transport.dto.RecordingChunkMetadata
import dev.omnesis.android.transport.dto.RecordingParticipantDto
import dev.omnesis.android.transport.dto.RecordingParticipantsResponse
import dev.omnesis.android.transport.dto.RecordingSpeakerDto
import dev.omnesis.android.transport.dto.RecordingSpeakersResponse
import dev.omnesis.android.transport.dto.RecordingStatusDto
import dev.omnesis.android.transport.dto.RecordingSummaryDto
import dev.omnesis.android.transport.dto.RecordingsListResponse
import dev.omnesis.android.transport.dto.SpeakerMapping
import dev.omnesis.android.transport.dto.StartRecordingBody
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.deleteJsonSegments
import dev.omnesis.android.transport.http.deleteSegments
import dev.omnesis.android.transport.http.getPrivateJson
import dev.omnesis.android.transport.http.postJson
import dev.omnesis.android.transport.http.postJsonSegments
import dev.omnesis.android.transport.http.putBodySegments
import dev.omnesis.android.transport.http.putJsonSegments
import kotlinx.serialization.json.JsonObject
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

    /** `GET /recordings?limit=` — the gateway's most recent recordings, newest first. */
    suspend fun list(limit: Int = 20): List<RecordingSummaryDto> =
        http.getPrivateJson<RecordingsListResponse>(listOf("recordings"), mapOf("limit" to limit.toString()))
            .recordings

    /**
     * `GET /recordings/:id/speakers` — who spoke, with how long and a few lines each,
     * and who was present without a turn. No speakers when the gateway did not tell
     * them apart; 404 for an unknown recording.
     */
    suspend fun speakers(id: String): RecordingSpeakersResponse =
        http.getPrivateJson(listOf("recordings", id, "speakers"))

    /**
     * `POST /recordings/:id/participants` — add someone who was present without a
     * speaking turn; answers the participants. 400 for an unknown person id.
     */
    suspend fun addParticipant(id: String, participant: NewParticipant): List<RecordingParticipantDto> =
        http.postJsonSegments<JsonObject, RecordingParticipantsResponse>(
            listOf("recordings", id, "participants"),
            participant.toJson(),
        ).participants

    /** `DELETE /recordings/:id/participants/:key` — answers the participants left. */
    suspend fun removeParticipant(id: String, key: String): List<RecordingParticipantDto> =
        http.deleteJsonSegments<RecordingParticipantsResponse>(listOf("recordings", id, "participants", key))
            .participants

    /**
     * `PUT /recordings/:id/speakers/:n` — say who speaker [speaker] is; answers the
     * recording's speakers as they now stand. 404 for an unknown speaker, 400 for an
     * unknown person id.
     */
    suspend fun setSpeaker(id: String, speaker: Int, mapping: SpeakerMapping): List<RecordingSpeakerDto> =
        http.putJsonSegments<JsonObject, RecordingSpeakersResponse>(
            listOf("recordings", id, "speakers", speaker.toString()),
            mapping.toJson(),
        ).speakers

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
