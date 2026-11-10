// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

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
