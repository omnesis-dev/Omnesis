// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.transport.dto.SourceSyncStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * True when merging a live broadcast moved the source's state, or any member's state.
 * Progress ticks leave every state as it was and return false.
 */
internal fun syncStateChanged(previous: SourceSyncStatus?, merged: SourceSyncStatus): Boolean {
    if (previous?.state != merged.state) return true
    fun states(s: SourceSyncStatus?) = s?.members?.associate { it.deviceId to it.state }
    return states(previous) != states(merged)
}

/**
 * Whether a broadcast earns a re-fetch of its source: a state change (the source's or
 * a member's), any completed run — its notices may have changed even when the state
 * did not — or a report from a device the shared source does not list yet.
 */
internal fun refetchWanted(
    previous: SourceSyncStatus?,
    merged: SourceSyncStatus,
    broadcast: SyncStatusBroadcast,
): Boolean {
    if (broadcast.state == "completed") return true
    if (syncStateChanged(previous, merged)) return true
    val members = previous?.members ?: return false
    return broadcast.deviceId != null && members.none { it.deviceId == broadcast.deviceId }
}

/**
 * Keeps a source's notices current while live `sync.status` events arrive.
 *
 * A broadcast carries no notices — the gateway composes them on a fetch — so when
 * [refetchWanted] says an event matters this re-fetches that one source and hands the
 * result to [apply]. Each screen that shows sources (the list and the detail) owns one,
 * so a transition costs one `GET /admin/sync/status/{id}` per open screen, debounced:
 *
 * - every trigger within [debounceMs] restarts the wait, so a burst settles into one fetch;
 * - a newer trigger cancels an older one's fetch, and a result from a superseded trigger
 *   is dropped even if it arrives;
 * - a failed fetch is retried once after [retryDelayMs], then dropped — the merged
 *   status stands;
 * - results are ordered against full loads by when each request *started* (see
 *   [beginFullLoad] / [reconcileFullLoad]), so whichever read the gateway later wins.
 */
internal class SyncStatusRefetcher(
    private val scope: CoroutineScope,
    private val fetch: suspend (sourceId: String) -> SourceSyncStatus,
    private val apply: (SourceSyncStatus) -> Unit,
    private val debounceMs: Long = 1_000,
    private val retryDelayMs: Long = 2_000,
) {
    /** Orders every trigger and every request start, fetch or full load alike. */
    private var sequence = 0L
    private val pending = mutableMapOf<String, Job>()
    /** Latest trigger per source; an entry leaves when its fetch finishes. */
    private val generations = mutableMapOf<String, Long>()
    /** When the applied re-fetch of a source started, until a later full load covers it. */
    private val answeredAt = mutableMapOf<String, Long>()
    /** When the latest applied full load started. */
    private var fullLoadAt = 0L

    /** Call after merging [broadcast]; schedules a re-fetch when [refetchWanted]. */
    fun onBroadcast(
        sourceId: String,
        previous: SourceSyncStatus?,
        merged: SourceSyncStatus,
        broadcast: SyncStatusBroadcast,
    ) {
        if (refetchWanted(previous, merged, broadcast)) schedule(sourceId)
    }

    /** Stamp a full load as it starts; pass the stamp to [reconcileFullLoad]. */
    fun beginFullLoad(): Long = ++sequence

    /**
     * The statuses a full load started at [ticket] should leave on screen: its own
     * [loaded] ones, except where a re-fetch that started later already answered — that
     * source keeps its [current] status. A source the load no longer returns stays gone.
     */
    fun reconcileFullLoad(
        ticket: Long,
        loaded: Map<String, SourceSyncStatus>,
        current: Map<String, SourceSyncStatus>,
    ): Map<String, SourceSyncStatus> {
        fullLoadAt = maxOf(fullLoadAt, ticket)
        val newer = current.filterKeys { id -> id in loaded && (answeredAt[id] ?: 0L) > ticket }
        answeredAt.entries.removeAll { it.value <= fullLoadAt }
        return loaded + newer
    }

    private fun schedule(sourceId: String) {
        val generation = ++sequence
        generations[sourceId] = generation
        pending.remove(sourceId)?.cancel()
        val job = scope.launch {
            delay(debounceMs)
            val (startedAt, result) = fetchWithRetry(sourceId) ?: return@launch
            val current = generations[sourceId] == generation
            val fresher = startedAt > fullLoadAt && startedAt > (answeredAt[sourceId] ?: 0L)
            if (current && fresher) {
                answeredAt[sourceId] = startedAt
                apply(result)
            }
        }
        pending[sourceId] = job
        job.invokeOnCompletion {
            if (pending[sourceId] === job) pending.remove(sourceId)
            if (generations[sourceId] == generation) generations.remove(sourceId)
        }
    }

    /** The first successful answer with the stamp of the request that produced it. */
    private suspend fun fetchWithRetry(sourceId: String): Pair<Long, SourceSyncStatus>? {
        repeat(2) { attempt ->
            if (attempt > 0) delay(retryDelayMs)
            val startedAt = ++sequence
            try {
                return startedAt to fetch(sourceId)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Retried once below, then dropped.
            }
        }
        return null
    }
}
