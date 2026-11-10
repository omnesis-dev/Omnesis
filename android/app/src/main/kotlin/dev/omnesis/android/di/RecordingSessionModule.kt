// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.recording.OutboxChunk
import dev.omnesis.android.feature.recording.OutboxSession
import dev.omnesis.android.feature.recording.RecordingSessionProvider
import dev.omnesis.android.feature.recording.RecordingsGateway
import dev.omnesis.android.feature.recording.ui.RecordingAvailability
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.client.GatewayClient
import dev.omnesis.android.transport.client.RecordingsClient
import dev.omnesis.android.transport.dto.FinishRecordingBody
import dev.omnesis.android.transport.dto.RecordingChunkMetadata
import dev.omnesis.android.transport.dto.StartRecordingBody
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

    @Provides
    fun provideRecordingAvailability(sessionManager: SessionManager): RecordingAvailability =
        object : RecordingAvailability {
            override val state: StateFlow<RecordingAvailability.Availability> = sessionManager.recordingAvailability
        }
}
