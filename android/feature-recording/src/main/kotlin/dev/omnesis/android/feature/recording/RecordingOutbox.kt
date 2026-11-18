// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import java.io.File

/** One recording session as the phone keeps it until the gateway has all of it. */
data class OutboxSession(
    val id: String,
    val title: String?,
    /** ISO-8601 instant recording started. */
    val startedAt: String,
    val startedTimeZoneId: String?,
    val startedUtcOffsetSeconds: Int?,
    val language: String?,
    /** Set once recording stopped: how many chunks were recorded. */
    val chunkCount: Int?,
    val endedAt: String?,
    /** The gateway acknowledged the session's start. */
    val created: Boolean,
    /** The gateway acknowledged the session's finish; nothing is left to send. */
    val finished: Boolean,
    /** Why the gateway refused the session, when it did; nothing more is sent. */
    val refusal: String?,
    /** One past the highest chunk number filed so far. */
    val chunksFiled: Int = 0,
    /** ISO-8601 instant the latest filed chunk ends, or null before the first. */
    val filedUntil: String? = null,
)

/** One recorded chunk waiting for the gateway's acknowledgement. */
data class OutboxChunk(
    val sessionId: String,
    val seq: Int,
    val startedAt: String,
    val durationMs: Long,
    /** Nothing above the silence threshold: sent without audio. */
    val silent: Boolean,
    val interrupted: Boolean,
    /** The chunk's audio file; null for a silent chunk, whose audio was dropped. */
    val file: File?,
    val mimeType: String?,
)

/**
 * The durable record of what still has to reach the gateway. A recording
 * outlives the process that made it — the app may be killed mid-meeting, or
 * the phone may be offline for hours — so every chunk is recorded here the
 * moment its file is closed and leaves only when the gateway acknowledges it.
 * Implemented over SQLite in production ([SqliteRecordingOutbox]); tests use
 * an in-memory store.
 */
interface RecordingOutbox {
    suspend fun addSession(session: OutboxSession)
    /** File a chunk, advancing the session's [OutboxSession.chunksFiled] and [OutboxSession.filedUntil]. */
    suspend fun addChunk(chunk: OutboxChunk)
    suspend fun markStopped(sessionId: String, chunkCount: Int, endedAt: String)

    suspend fun sessions(): List<OutboxSession>
    suspend fun pendingChunks(sessionId: String): List<OutboxChunk>

    /** Whether the gateway is known to hold the session; false makes the next drain send its start again. */
    suspend fun setCreated(sessionId: String, created: Boolean)
    /** The gateway has the chunk: forget it, then delete its file (a file left by a kill is swept with its session). */
    suspend fun ackChunk(sessionId: String, seq: Int)
    suspend fun markFinished(sessionId: String)
    /** The gateway will never take this session: stop sending it. Its audio stays until the session is removed. */
    suspend fun markRefused(sessionId: String, reason: String)
    /** Forget a session entirely, with any chunk files it still holds. */
    suspend fun remove(sessionId: String)
}
