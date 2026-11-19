// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.util.Log
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.completeWith
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** What the recorder is doing, shared by the screen and the notification. */
sealed interface RecordingState {
    data object Idle : RecordingState

    data class Active(
        val sessionId: String,
        val title: String?,
        /** Audio time before the current run, ms. */
        val recordedMs: Long,
        /** When the current run started (epoch ms), or null while paused. */
        val runningSinceMs: Long?,
        val chunks: Int,
        /** Paused because the microphone could not be reopened, not by the user. */
        val micLost: Boolean = false,
    ) : RecordingState {
        val paused: Boolean get() = runningSinceMs == null

        fun elapsedMs(nowMs: Long): Long = recordedMs + (runningSinceMs?.let { nowMs - it } ?: 0)
    }
}

/**
 * The one owner of a recording's bookkeeping: opens the session in the
 * outbox, files each closed chunk (dropping the audio of a silent one), and
 * closes the session when recording stops. The foreground service drives the
 * microphone and reports to it; the screen and the notification read [state].
 *
 * Every outbox write runs on one queue, in the order it was reported, so a
 * stop never overtakes the chunk closed just before it. The queue lives in
 * this singleton rather than the service, so a chunk closed while the system
 * destroys the service is still filed. Each chunk is in the outbox before
 * anything tries to upload it; after a process kill, [recoverInterrupted]
 * files what the recorder left on disk and closes the session, so a kill
 * loses at most the audio of the chunk being recorded.
 */
class RecordingController(
    private val outbox: RecordingOutbox,
    private val files: RecordingFiles,
    private val onWorkQueued: () -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
    private val zone: () -> ZoneId = ZoneId::systemDefault,
    private val locale: () -> Locale = Locale::getDefault,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val _state = MutableStateFlow<RecordingState>(RecordingState.Idle)
    val state: StateFlow<RecordingState> = _state.asStateFlow()

    private val queue = Channel<suspend () -> Unit>(Channel.UNLIMITED)

    init {
        scope.launch {
            for (work in queue) {
                try {
                    work()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "Recording bookkeeping failed: ${e.message}")
                }
            }
        }
    }

    private fun enqueue(work: suspend () -> Unit) {
        queue.trySend(work)
    }

    /** Run [work] on the queue, after everything enqueued before it, and wait for its result. */
    private suspend fun <T> serial(work: suspend () -> T): T {
        val result = CompletableDeferred<T>()
        enqueue { result.completeWith(runCatching { work() }) }
        return result.await()
    }

    /**
     * Open a session; the service starts the microphone right after. Null
     * while another session is active or its stop is still being filed.
     */
    suspend fun begin(title: String?, id: String = UUID.randomUUID().toString()): RecordingState.Active? = serial {
        if (_state.value != RecordingState.Idle) return@serial null
        val now = clock()
        val instant = Instant.ofEpochMilli(now)
        val zoneId = zone()
        withContext(Dispatchers.IO) { files.sessionDir(id).mkdirs() }
        outbox.addSession(
            OutboxSession(
                id = id,
                title = title?.trim()?.takeIf { it.isNotEmpty() },
                startedAt = instant.toString(),
                startedTimeZoneId = zoneId.id,
                startedUtcOffsetSeconds = zoneId.rules.getOffset(instant).totalSeconds,
                language = locale().toLanguageTag(),
                chunkCount = null,
                endedAt = null,
                created = false,
                finished = false,
                refusal = null,
            ),
        )
        val active = RecordingState.Active(id, title, recordedMs = 0, runningSinceMs = now, chunks = 0)
        _state.value = active
        onWorkQueued()
        active
    }

    /** The directory the recorder writes the session's chunk files into. */
    fun directoryFor(sessionId: String): File = files.sessionDir(sessionId)

    /** The recorder stopped; [micLost] when it was the microphone, not the user. */
    fun onPaused(micLost: Boolean = false) {
        _state.update { s ->
            val active = s as? RecordingState.Active ?: return@update s
            val since = active.runningSinceMs
            if (since == null) {
                active.copy(micLost = active.micLost || micLost)
            } else {
                active.copy(recordedMs = active.recordedMs + (clock() - since), runningSinceMs = null, micLost = micLost)
            }
        }
    }

    fun onResumed() {
        _state.update { s ->
            val active = s as? RecordingState.Active ?: return@update s
            if (active.runningSinceMs == null) active.copy(runningSinceMs = clock(), micLost = false) else active
        }
    }

    /** Queue one closed chunk of [sessionId] for filing. */
    fun chunkClosed(sessionId: String, chunk: RecordedChunk) = enqueue { fileChunk(sessionId, chunk) }

    /**
     * Queue the session's close after every chunk reported before it; [then]
     * runs once the session is closed.
     */
    fun stopped(sessionId: String, chunkCount: Int, then: () -> Unit = {}) = enqueue {
        closeSession(sessionId, chunkCount)
        then()
    }

    /** Forget a session that never recorded (the microphone did not open, or the start was abandoned). */
    fun discard(sessionId: String) = enqueue {
        outbox.remove(sessionId)
        withContext(Dispatchers.IO) { files.sessionDir(sessionId).deleteRecursively() }
        _state.update { s -> if ((s as? RecordingState.Active)?.sessionId == sessionId) RecordingState.Idle else s }
    }

    /** Wait until everything queued so far has run. */
    suspend fun flush() = serial { }

    /**
     * Close the sessions a killed process left open: every session still
     * without a chunk count other than the active one. Chunk files the
     * recorder wrote but never reported are filed as interrupted chunks (an
     * empty one as a silent placeholder, keeping the numbers dense), then the
     * session is closed at the end of its last chunk. A session that recorded
     * nothing and the gateway never saw is removed.
     */
    suspend fun recoverInterrupted() = serial {
        val activeId = (_state.value as? RecordingState.Active)?.sessionId
        var recovered = false
        for (session in outbox.sessions()) {
            if (session.chunkCount != null || session.id == activeId) continue
            recover(session)
            recovered = true
        }
        if (recovered) onWorkQueued()
    }

    private suspend fun recover(session: OutboxSession) {
        val leftovers = withContext(Dispatchers.IO) { leftoverChunks(session) }
        if (leftovers.isEmpty() && session.chunksFiled == 0 && !session.created) {
            outbox.remove(session.id)
            withContext(Dispatchers.IO) { files.sessionDir(session.id).deleteRecursively() }
            return
        }
        leftovers.forEach { outbox.addChunk(it) }
        val endedAt = leftovers.lastOrNull()?.let { Instant.parse(it.startedAt).plusMillis(it.durationMs).toString() }
            ?: session.filedUntil
            ?: session.startedAt
        outbox.markStopped(session.id, session.chunksFiled + leftovers.size, endedAt)
        Log.i(TAG, "Recovered an interrupted recording with ${leftovers.size} unreported chunks")
    }

    /** The chunk files from [OutboxSession.chunksFiled] on, as interrupted chunks with no gap in their numbers. */
    private fun leftoverChunks(session: OutboxSession): List<OutboxChunk> {
        val bySeq = files.sessionDir(session.id).listFiles().orEmpty()
            .mapNotNull { f -> ChunkPolicy.seqOf(f.name)?.let { it to f } }
            .filter { (seq, _) -> seq >= session.chunksFiled }
            .toMap()
        val last = bySeq.keys.maxOrNull() ?: return emptyList()
        var cursor = Instant.parse(session.filedUntil ?: session.startedAt)
        return (session.chunksFiled..last).map { seq ->
            val file = bySeq[seq]?.takeIf { it.length() > 0 }
            if (file == null) {
                bySeq[seq]?.delete()
                OutboxChunk(session.id, seq, cursor.toString(), 0, silent = true, interrupted = true, file = null, mimeType = null)
            } else {
                // The audio's length, estimated from its size at the target bit rate.
                val durationMs = file.length() * 8_000 / ChunkPolicy.BIT_RATE
                val endsAt = Instant.ofEpochMilli(file.lastModified())
                val startsAt = maxOf(cursor, endsAt.minusMillis(durationMs))
                cursor = maxOf(cursor, endsAt)
                OutboxChunk(
                    sessionId = session.id,
                    seq = seq,
                    startedAt = startsAt.toString(),
                    durationMs = durationMs,
                    silent = false,
                    interrupted = true,
                    file = file,
                    mimeType = ChunkPolicy.MIME_TYPE,
                )
            }
        }
    }

    /** File one closed chunk. A silent or empty chunk keeps its timing but not its audio. */
    private suspend fun fileChunk(sessionId: String, chunk: RecordedChunk) {
        val empty = withContext(Dispatchers.IO) { !chunk.file.exists() || chunk.file.length() == 0L }
        val silent = empty || chunk.durationMs == 0L || ChunkPolicy.isSilent(chunk.peakAmplitude)
        if (silent) withContext(Dispatchers.IO) { chunk.file.delete() }
        outbox.addChunk(
            OutboxChunk(
                sessionId = sessionId,
                seq = chunk.seq,
                startedAt = Instant.ofEpochMilli(chunk.startedAtMs).toString(),
                durationMs = if (empty) 0 else chunk.durationMs,
                silent = silent,
                interrupted = chunk.interrupted,
                file = if (silent) null else chunk.file,
                mimeType = if (silent) null else ChunkPolicy.MIME_TYPE,
            ),
        )
        _state.update { s ->
            val active = s as? RecordingState.Active
            if (active?.sessionId == sessionId) active.copy(chunks = maxOf(active.chunks, chunk.seq + 1)) else s
        }
        onWorkQueued()
    }

    private suspend fun closeSession(sessionId: String, chunkCount: Int) {
        outbox.markStopped(sessionId, chunkCount, Instant.ofEpochMilli(clock()).toString())
        _state.update { s -> if ((s as? RecordingState.Active)?.sessionId == sessionId) RecordingState.Idle else s }
        onWorkQueued()
    }

    private companion object {
        const val TAG = "Omnesis:Recording"
    }
}

/** Where chunk files live: under `noBackupFilesDir`, one directory per session. */
class RecordingFiles(private val root: File) {
    fun sessionDir(sessionId: String): File = File(root, sessionId)

    /** Remove session directories the outbox no longer names (left by a kill mid-delete). */
    fun sweep(knownSessionIds: Set<String>) {
        root.listFiles()?.forEach { dir ->
            if (dir.isDirectory && dir.name !in knownSessionIds) dir.deleteRecursively()
        }
    }
}
