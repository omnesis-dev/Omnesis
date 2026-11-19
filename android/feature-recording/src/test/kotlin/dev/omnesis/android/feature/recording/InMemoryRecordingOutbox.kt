// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

/** A [RecordingOutbox] in memory, with the SQLite store's semantics. */
class InMemoryRecordingOutbox : RecordingOutbox {
    val sessionsById = linkedMapOf<String, OutboxSession>()
    val chunks = mutableListOf<OutboxChunk>()

    override suspend fun addSession(session: OutboxSession) {
        sessionsById.putIfAbsent(session.id, session)
    }

    override suspend fun addChunk(chunk: OutboxChunk) {
        if (chunks.none { it.sessionId == chunk.sessionId && it.seq == chunk.seq }) chunks += chunk
        update(chunk.sessionId) {
            if (it.chunksFiled > chunk.seq) {
                it
            } else {
                val endsAt = java.time.Instant.parse(chunk.startedAt).plusMillis(chunk.durationMs).toString()
                it.copy(chunksFiled = chunk.seq + 1, filedUntil = endsAt)
            }
        }
    }

    override suspend fun markStopped(sessionId: String, chunkCount: Int, endedAt: String) =
        update(sessionId) { it.copy(chunkCount = chunkCount, endedAt = endedAt) }

    override suspend fun sessions() = sessionsById.values.sortedBy { it.startedAt }

    override suspend fun pendingChunks(sessionId: String) = chunks.filter { it.sessionId == sessionId }.sortedBy { it.seq }

    override suspend fun setCreated(sessionId: String, created: Boolean) = update(sessionId) { it.copy(created = created) }

    override suspend fun ackChunk(sessionId: String, seq: Int) {
        val acked = chunks.filter { it.sessionId == sessionId && it.seq == seq }
        chunks.removeAll(acked)
        acked.forEach { it.file?.delete() }
    }

    override suspend fun markFinished(sessionId: String) = update(sessionId) { it.copy(finished = true) }

    override suspend fun markRefused(sessionId: String, reason: String) = update(sessionId) { it.copy(refusal = reason) }

    override suspend fun remove(sessionId: String) {
        val removed = chunks.filter { it.sessionId == sessionId }
        chunks.removeAll(removed)
        removed.forEach { it.file?.delete() }
        sessionsById.remove(sessionId)
    }

    private fun update(id: String, f: (OutboxSession) -> OutboxSession) {
        sessionsById[id]?.let { sessionsById[id] = f(it) }
    }
}
