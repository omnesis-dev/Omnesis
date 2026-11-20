// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.recording.ChunkPolicy
import dev.omnesis.android.feature.recording.MarkedMomentSink
import dev.omnesis.android.feature.recording.OutboxChunk
import dev.omnesis.android.feature.recording.OutboxSession
import dev.omnesis.android.feature.recording.RecordingSessionProvider
import dev.omnesis.android.feature.recording.RecordingsGateway
import dev.omnesis.android.feature.recording.ui.RecordingAvailability
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.RelayedCapture
import dev.omnesis.android.notes.VoiceNoteAudio
import dev.omnesis.android.notes.VoiceNoteNotSavedException
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.client.GatewayClient
import dev.omnesis.android.transport.client.RecordingsClient
import dev.omnesis.android.transport.dto.FinishRecordingBody
import dev.omnesis.android.transport.dto.RecordingChunkMetadata
import dev.omnesis.android.transport.dto.StartRecordingBody
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.flow.StateFlow

/** [RecordingsGateway] over the session's [RecordingsClient], with [GatewayClient] for the capability check. */
class ClientRecordingsGateway(
    private val client: RecordingsClient,
    private val gateway: GatewayClient,
    private val deviceId: String?,
) : RecordingsGateway {
    override suspend fun accepting(): Boolean = gateway.status().let { it.experimental && it.recordings }

    override suspend fun start(session: OutboxSession) {
        client.start(
            StartRecordingBody(
                id = session.id,
                title = session.title,
                origin = if (session.ambient) "ambient" else null,
                startedAt = session.startedAt,
                startedTimeZoneId = session.startedTimeZoneId,
                startedUtcOffsetSeconds = session.startedUtcOffsetSeconds,
                language = session.language,
                deviceId = deviceId,
            ),
        )
    }

    override suspend fun putChunk(chunk: OutboxChunk) {
        client.putChunk(
            id = chunk.sessionId,
            seq = chunk.seq,
            metadata = RecordingChunkMetadata(
                startedAt = chunk.startedAt,
                durationMs = chunk.durationMs,
                silent = chunk.silent.takeIf { it },
                interrupted = chunk.interrupted.takeIf { it },
            ),
            audio = if (chunk.silent) null else chunk.file,
            audioMimeType = chunk.mimeType,
        )
    }

    override suspend fun finish(sessionId: String, chunkCount: Int, endedAt: String) {
        client.finish(sessionId, FinishRecordingBody(chunkCount, endedAt))
    }

    override suspend fun delete(sessionId: String) = client.delete(sessionId)
}

/** The capture surface a marked moment's note is saved under. */
const val MARKED_MOMENT_SURFACE = "android-marked-moment"

@Module
@InstallIn(SingletonComponent::class)
object RecordingSessionModule {
    /**
     * The recording feature's way to the live session. Through [SessionManager],
     * a WorkManager cold start rebuilds the session from the persisted pairing;
     * an unpaired app yields null and the upload waits.
     */
    @Provides
    fun provideRecordingSessionProvider(sessionManager: SessionManager): RecordingSessionProvider =
        RecordingSessionProvider {
            sessionManager.session?.let { ClientRecordingsGateway(it.recordings, it.gateway, it.pairing.deviceId) }
        }

    /**
     * A marked moment's clip becomes a Tell Omnesis voice note, captured when
     * the moment was marked, naming the recording it was cut from. The notes
     * queue delivers it, offline or not, and owns the file from here on.
     */
    @Provides
    fun provideMarkedMomentSink(notes: NotesRepository): MarkedMomentSink =
        MarkedMomentSink { clip, recordingId ->
            try {
                notes.capture(
                    text = "",
                    surface = MARKED_MOMENT_SURFACE,
                    audio = VoiceNoteAudio(clip.file, ChunkPolicy.MIME_TYPE),
                    relayed = RelayedCapture(
                        noteId = UUID.randomUUID().toString(),
                        capturedAt = Instant.ofEpochMilli(clip.markedAtMs),
                    ),
                    recordingId = recordingId,
                )
            } catch (_: VoiceNoteNotSavedException) {
                // The gateway takes no audio now and the clip has no text of its own: nothing to save.
            }
        }

    @Provides
    fun provideRecordingAvailability(sessionManager: SessionManager): RecordingAvailability =
        object : RecordingAvailability {
            override val state: StateFlow<RecordingAvailability.Availability> = sessionManager.recordingAvailability
        }
}
