// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Wire DTOs for the gateway's recorded-conversation surface (`/recordings`,
 * experimental). A phone records a conversation and uploads it as numbered
 * chunks while it records; the gateway transcribes them and writes one
 * document per session.
 *
 * Gateway TS shapes (`packages/gateway/src/http/schemas/recordings.ts` and
 * `RecordingStatus` in `packages/gateway/src/recordings/service.ts`):
 *
 * ```ts
 * // POST /recordings  body: { id: uuid; title?; startedAt; startedTimeZoneId?;
 * //                            startedUtcOffsetSeconds?; language?; deviceId? }
 * // PUT  /recordings/:id/chunks/:seq  multipart: `chunk` JSON
 * //        { startedAt; durationMs; silent?; interrupted? } + `audio` (absent when silent)
 * // POST /recordings/:id/finish  body: { chunkCount; endedAt }
 * type RecordingStatus = {
 *   id: string; title: string | null; state: "recording" | "transcribing" | "done";
 *   chunkCount: number | null;
 *   chunks: { received; pending; transcribed; failed; silent };
 *   projected: boolean;
 * };
 * ```
 */
@Serializable
data class StartRecordingBody(
    val id: String,
    val title: String? = null,
    val startedAt: String,
    val startedTimeZoneId: String? = null,
    val startedUtcOffsetSeconds: Int? = null,
    val language: String? = null,
    val deviceId: String? = null,
)

/** The `chunk` part of `PUT /recordings/:id/chunks/:seq`. */
@Serializable
data class RecordingChunkMetadata(
    val startedAt: String,
    val durationMs: Long,
    val silent: Boolean? = null,
    val interrupted: Boolean? = null,
)

@Serializable
data class FinishRecordingBody(val chunkCount: Int, val endedAt: String)

@Serializable
data class RecordingChunkCountsDto(
    val received: Int = 0,
    val pending: Int = 0,
    val transcribed: Int = 0,
    val failed: Int = 0,
    val silent: Int = 0,
)

@Serializable
data class RecordingStatusDto(
    val id: String,
    val title: String? = null,
    /** `recording`, `transcribing` or `done`; an unknown state is kept as sent. */
    val state: String,
    val chunkCount: Int? = null,
    val chunks: RecordingChunkCountsDto = RecordingChunkCountsDto(),
    val projected: Boolean = false,
)

@Serializable
data class RecordingChunkAckDto(val seq: Int, val status: String)

/**
 * One row of `GET /recordings` — the gateway's `RecordingSummary`
 * (`packages/gateway/src/recordings/service.ts`), newest first:
 *
 * ```ts
 * interface RecordingSummary {
 *   id: string; title: string; startedAt: string; state: RecordingState;
 *   speakers: number; namedSpeakers: number;
 * }
 * ```
 */
@Serializable
data class RecordingSummaryDto(
    val id: String,
    /** The display title; the gateway always sends one. */
    val title: String = "",
    val startedAt: String,
    /** `recording`, `transcribing` or `done`; an unknown state is kept as sent. */
    val state: String,
    /** Speakers the gateway told apart; 0 when it did not. */
    val speakers: Int = 0,
    /** Speakers the owner said who they are. */
    val namedSpeakers: Int = 0,
)

@Serializable
data class RecordingsListResponse(val recordings: List<RecordingSummaryDto> = emptyList())

/**
 * One speaker of `GET /recordings/:id/speakers` — the gateway's
 * `RecordingSpeakerView` (`packages/gateway/src/recordings/service.ts`):
 *
 * ```ts
 * interface RecordingSpeakerView {
 *   speaker: number;          // 1-based, in order of first appearance
 *   isSelf: boolean;
 *   personId: string | null;  // the mapped person
 *   name: string | null;      // the person's name or the given name; null when unnamed
 *   talkMs: number;
 *   samples: string[];        // the first few things they said
 * }
 * ```
 */
@Serializable
data class RecordingSpeakerDto(
    val speaker: Int,
    val isSelf: Boolean = false,
    val personId: String? = null,
    val name: String? = null,
    val talkMs: Long = 0,
    val samples: List<String> = emptyList(),
) {
    /** Whether the owner said who this speaker is. */
    val mapped: Boolean get() = isSelf || personId != null || name != null
}

@Serializable
data class RecordingSpeakersResponse(val speakers: List<RecordingSpeakerDto> = emptyList())

/**
 * Who one speaker is, the body of `PUT /recordings/:id/speakers/:n`: exactly
 * one of `{self:true}`, `{personId}`, `{name}` (1..120 characters, trimmed by
 * the gateway) or `{clear:true}` (the gateway's `setRecordingSpeakerBody`).
 */
sealed interface SpeakerMapping {
    data object Self : SpeakerMapping
    data class Person(val personId: String) : SpeakerMapping
    data class Name(val name: String) : SpeakerMapping
    data object Clear : SpeakerMapping

    fun toJson(): JsonObject = buildJsonObject {
        when (val mapping = this@SpeakerMapping) {
            Self -> put("self", true)
            is Person -> put("personId", mapping.personId)
            is Name -> put("name", mapping.name)
            Clear -> put("clear", true)
        }
    }

    companion object {
        const val MAX_NAME_LENGTH = 120
    }
}
