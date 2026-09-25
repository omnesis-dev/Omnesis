// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.session.SessionManager.GatewaySession
import dev.omnesis.android.transport.SourceSyncStatusReader
import dev.omnesis.android.transport.dto.SourceSyncStatus
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import javax.inject.Singleton
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

@Module
@InstallIn(SingletonComponent::class)
object SourceSyncStatusModule {
    @Provides
    @Singleton
    fun provideSourceSyncStatusReader(sessions: SessionManager): SourceSyncStatusReader =
        GatewaySourceSyncStatusReader(sessions)
}

private class GatewaySourceSyncStatusReader(
    private val sessions: SessionManager,
) : SourceSyncStatusReader {
    override suspend fun read(sourceId: String): SourceSyncStatus? {
        val session = sessions.session ?: return null
        return read(session, sourceId)
    }

    private suspend fun read(session: GatewaySession, sourceId: String): SourceSyncStatus? {
        val deviceId = session.pairing.deviceId ?: return null
        val status = session.admin.syncStatus(sourceId).forDevice(deviceId)
        return status.takeIf { sessions.session === session }
    }

    override fun observe(sourceId: String): Flow<SourceSyncStatus?> = sessionBoundStatusFlow(
        sessions = sessions.state.map { sessions.session },
        triggers = { session -> triggers(session, sourceId) },
        read = { session -> emitCurrent(session, sourceId) },
    )

    private fun triggers(session: GatewaySession, sourceId: String): Flow<Unit> {
        val socket = session.socket
        val matchingEvents = socket.events
            .filter { event ->
                event.type == "sync.status" &&
                    event.payload["sourceId"]?.jsonPrimitive?.contentOrNull == sourceId
            }
            .map { Unit }
        val reconnects = socket.state
            .filter { it is ConnectionState.Connected }
            .map { Unit }
        return merge(matchingEvents, reconnects)
    }

    private suspend fun emitCurrent(session: GatewaySession, sourceId: String): SourceSyncStatus? = try {
        read(session, sourceId)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        // Preserve the prior status; the next event, session, or resume retries.
        null
    }
}

/** Switches status reads atomically with the active gateway session. */
@OptIn(ExperimentalCoroutinesApi::class)
internal fun <S : Any, T> sessionBoundStatusFlow(
    sessions: Flow<S?>,
    triggers: (S) -> Flow<Unit>,
    read: suspend (S) -> T?,
): Flow<T?> = sessions
    .distinctUntilChanged()
    .flatMapLatest { session ->
        flow {
            // A status belongs to one gateway pairing. Clear it at the
            // boundary so a failed first read cannot expose the previous
            // gateway's state in the new session.
            emit(null)
            if (session == null) {
                return@flow
            }
            read(session)?.let { emit(it) }
            triggers(session).collect { read(session)?.let { emit(it) } }
        }
    }
