// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Applies retained gateway tombstones; missing rows never imply removal. */
class SourceRemovalReconciler(
    private val log: (String) -> Unit = {},
    waitForPendingAuthority: Boolean = false,
    private val optIns: () -> Collection<HostedSourceOptIn>,
) {
    private val pendingAuthorityReady = CompletableDeferred<Unit>().also { if (!waitForPendingAuthority) it.complete(Unit) }
    private val lock = Any()
    private val epochs = mutableMapOf<String, Long>()
    private var sessionEpoch = 0L

    fun invalidateSession() = synchronized(lock) {
        sessionEpoch++
        _removed.value = emptySet()
        pendingResumes = emptySet()
    }

    private val active = mutableMapOf<String, Int>()
    private var pendingResumes = emptySet<String>()
    private var readPendingResumes: (() -> Set<String>)? = null

    fun pendingResumesFrom(read: () -> Set<String>) = synchronized(lock) {
        readPendingResumes = read
        updatePendingResumes(read())
        pendingAuthorityReady.complete(Unit)
    }

    fun updatePendingResumes(sourceIds: Set<String>) = synchronized(lock) {
        for (id in (pendingResumes - sourceIds) + (sourceIds - pendingResumes)) {
            epochs[id] = (epochs[id] ?: 0L) + 1
        }
        pendingResumes = sourceIds
    }
    private val _removed = MutableStateFlow<Set<String>>(emptySet())
    val removed = _removed.asStateFlow()

    /** Deliver notices from current authority, serialized with activation/session invalidation. */
    fun withRemovedAuthority(deliver: (Set<String>) -> Unit) = synchronized(lock) {
        deliver(_removed.value)
    }

    /** A user activation supersedes removal reads started before or during that action. */
    suspend fun <T> activating(sourceId: String, action: suspend () -> T): T {
        synchronized(lock) {
            _removed.update { it - sourceId }
            epochs[sourceId] = (epochs[sourceId] ?: 0L) + 1
            active[sourceId] = (active[sourceId] ?: 0) + 1
        }
        return try { action() } finally {
            synchronized(lock) {
                epochs[sourceId] = (epochs[sourceId] ?: 0L) + 1
                active[sourceId] = (active[sourceId] ?: 1) - 1
            }
        }
    }

    suspend fun reconcile(fetchRemoved: suspend () -> List<String>) {
        pendingAuthorityReady.await()
        val (observedSession, observed) = synchronized(lock) {
            readPendingResumes?.let { updatePendingResumes(it()) }
            sessionEpoch to epochs.toMap()
        }
        val removed = fetchRemoved().toSet()
        currentCoroutineContext().ensureActive()
        synchronized(lock) {
            if (sessionEpoch != observedSession) return
            readPendingResumes?.let { updatePendingResumes(it()) }
            for (optIn in optIns()) {
                if (optIn.sourceId in removed && optIn.sourceId !in pendingResumes &&
                    (active[optIn.sourceId] ?: 0) == 0 &&
                    epochs[optIn.sourceId] == observed[optIn.sourceId]) {
                    try {
                        optIn.withdraw()
                        _removed.update { it + optIn.sourceId }
                    } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        log("Could not stop a removed source: ${e::class.simpleName}")
                    }
                }
            }
        }
    }
}
