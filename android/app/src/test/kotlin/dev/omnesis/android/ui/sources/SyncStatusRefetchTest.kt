// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.SourceNotice
import dev.omnesis.android.transport.dto.SourceSyncStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When a live `sync.status` event earns a re-fetch of that source's status, and which answer wins. */
class SyncStatusRefetchTest {

    private val fresh = SourceSyncStatus(
        sourceId = "s",
        state = "synced",
        notices = listOf(SourceNotice(kind = "coverage-partial", severity = "info", title = "Only recent history is reachable")),
    )

    private fun broadcast(json: String) =
        SyncStatusBroadcast.decode(OmnesisJson.parseToJsonElement(json).jsonObject)!!

    /** Feeds broadcasts through the real merge, as a view model does. */
    private class Harness(
        scope: TestScope,
        fresh: SourceSyncStatus,
        failures: Int = 0,
        start: SourceSyncStatus = SourceSyncStatus(sourceId = "s", state = "synced"),
    ) {
        var status: SourceSyncStatus? = start
        val fetched = mutableListOf<String>()
        val applied = mutableListOf<SourceSyncStatus>()
        private var failuresLeft = failures
        val refetcher = SyncStatusRefetcher(
            scope = scope,
            fetch = { id ->
                fetched += id
                if (failuresLeft-- > 0) error("gateway unreachable") else fresh
            },
            apply = { applied += it; status = it },
        )

        fun receive(b: SyncStatusBroadcast) {
            val previous = status
            val merged = mergeSyncStatus(previous, b, "s")
            refetcher.onBroadcast("s", previous, merged, b)
            status = merged
        }
    }

    @Test
    fun `a state change fetches the source once after the debounce`() = runTest {
        val h = Harness(this, fresh)
        h.receive(broadcast("""{"sourceId":"s","state":"error","errorMessage":"Disk unavailable"}"""))
        advanceTimeBy(999)
        runCurrent()
        assertEquals(emptyList<String>(), h.fetched)
        advanceUntilIdle()
        assertEquals(listOf("s"), h.fetched)
        assertEquals(fresh, h.status)
    }

    @Test
    fun `progress ticks alone never fetch`() = runTest {
        val h = Harness(this, fresh, start = SourceSyncStatus(sourceId = "s", state = "syncing"))
        repeat(20) { i ->
            h.receive(broadcast("""{"sourceId":"s","state":"syncing","progress":{"processed":$i}}"""))
        }
        advanceUntilIdle()
        assertEquals(emptyList<String>(), h.fetched)
    }

    @Test
    fun `a burst of changes and ticks settles into one fetch`() = runTest {
        val h = Harness(this, fresh)
        h.receive(broadcast("""{"sourceId":"s","state":"syncing"}"""))
        repeat(5) { i ->
            advanceTimeBy(100)
            h.receive(broadcast("""{"sourceId":"s","state":"syncing","progress":{"processed":$i}}"""))
        }
        h.receive(broadcast("""{"sourceId":"s","state":"completed","completedAt":1717000000000}"""))
        advanceUntilIdle()
        assertEquals(listOf("s"), h.fetched)
    }

    @Test
    fun `a completed run fetches even when the state did not move`() = runTest {
        val h = Harness(this, fresh)
        h.receive(broadcast("""{"sourceId":"s","state":"completed","completedAt":1717000000000}"""))
        advanceUntilIdle()
        assertEquals(listOf("s"), h.fetched)
    }

    @Test
    fun `a report from a device the shared source does not list fetches`() {
        val previous = SourceSyncStatus(
            sourceId = "s",
            state = "synced",
            members = listOf(SourceSyncStatus(sourceId = "s", deviceId = "a", state = "synced")),
        )
        val b = broadcast("""{"sourceId":"s","deviceId":"new","state":"synced"}""")
        val merged = mergeSyncStatus(previous, b, "s")
        assertFalse(syncStateChanged(previous, merged))
        assertTrue(refetchWanted(previous, merged, b))
    }

    @Test
    fun `a failed fetch is retried once`() = runTest {
        val h = Harness(this, fresh, failures = 1)
        h.receive(broadcast("""{"sourceId":"s","state":"error","errorMessage":"Disk unavailable"}"""))
        advanceUntilIdle()
        assertEquals(listOf("s", "s"), h.fetched)
        assertEquals(listOf(fresh), h.applied)
    }

    @Test
    fun `two failures leave the merged status`() = runTest {
        val h = Harness(this, fresh, failures = 2)
        h.receive(broadcast("""{"sourceId":"s","state":"error","errorMessage":"Disk unavailable"}"""))
        advanceUntilIdle()
        assertEquals(listOf("s", "s"), h.fetched)
        assertEquals(emptyList<SourceSyncStatus>(), h.applied)
        assertEquals("error", h.status?.state)
    }

    @Test
    fun `a member's state change counts even when the aggregate stays put`() {
        val before = SourceSyncStatus(
            sourceId = "s",
            state = "synced",
            members = listOf(
                SourceSyncStatus(sourceId = "s", deviceId = "a", state = "synced"),
                SourceSyncStatus(sourceId = "s", deviceId = "b", state = "synced"),
            ),
        )
        val after = before.copy(members = listOf(before.members!![0], before.members!![1].copy(state = "error")))
        assertTrue(syncStateChanged(before, after))
        assertFalse(syncStateChanged(before, before.copy(progress = SourceSyncStatus.Progress(processed = 3))))
    }

    @Test
    fun `a newer trigger's result stands over a slower earlier fetch`() = runTest {
        val first = CompletableDeferred<SourceSyncStatus>()
        val second = CompletableDeferred<SourceSyncStatus>()
        val answers = ArrayDeque(listOf(first, second))
        val applied = mutableListOf<SourceSyncStatus>()
        val refetcher = SyncStatusRefetcher(
            scope = this,
            // Answers ignore cancellation, as a response already on the wire would.
            fetch = { withContext(NonCancellable) { answers.removeFirst().await() } },
            apply = { applied += it },
        )
        val idle = SourceSyncStatus(sourceId = "s", state = "synced")
        val syncing = idle.copy(state = "syncing")
        val failed = idle.copy(state = "error")
        val tick = broadcast("""{"sourceId":"s","state":"syncing"}""")

        refetcher.onBroadcast("s", idle, syncing, tick)
        advanceTimeBy(1_001)
        runCurrent() // the first fetch is in flight
        refetcher.onBroadcast("s", syncing, failed, tick)
        advanceTimeBy(1_001)
        runCurrent() // the second fetch is in flight

        val newer = failed.copy(errorMessage = "newer")
        second.complete(newer)
        runCurrent()
        first.complete(syncing.copy(errorMessage = "older"))
        advanceUntilIdle()

        assertEquals(listOf(newer), applied)
    }

    @Test
    fun `a full load that started before a re-fetch cannot overwrite it`() = runTest {
        val h = Harness(this, fresh)
        val ticket = h.refetcher.beginFullLoad() // a reload starts reading the gateway
        h.receive(broadcast("""{"sourceId":"s","state":"error","errorMessage":"Disk unavailable"}"""))
        advanceUntilIdle() // the re-fetch starts later and lands first
        assertEquals(listOf(fresh), h.applied)

        val older = SourceSyncStatus(sourceId = "s", state = "error")
        val other = SourceSyncStatus(sourceId = "t", state = "synced")
        val kept = h.refetcher.reconcileFullLoad(ticket, mapOf("s" to older, "t" to other), mapOf("s" to fresh))
        assertEquals(mapOf("s" to fresh, "t" to other), kept)
    }

    @Test
    fun `a re-fetch that started before a full load is dropped once the load lands`() = runTest {
        val answer = CompletableDeferred<SourceSyncStatus>()
        val applied = mutableListOf<SourceSyncStatus>()
        val refetcher = SyncStatusRefetcher(scope = this, fetch = { answer.await() }, apply = { applied += it })
        val idle = SourceSyncStatus(sourceId = "s", state = "synced")
        refetcher.onBroadcast("s", idle, idle.copy(state = "error"), broadcast("""{"sourceId":"s","state":"error"}"""))
        advanceTimeBy(1_001)
        runCurrent() // the re-fetch is in flight
        val loaded = SourceSyncStatus(sourceId = "s", state = "synced", notices = emptyList())
        val ticket = refetcher.beginFullLoad()
        assertEquals(mapOf("s" to loaded), refetcher.reconcileFullLoad(ticket, mapOf("s" to loaded), mapOf("s" to idle)))

        answer.complete(idle.copy(state = "error"))
        advanceUntilIdle()
        assertEquals(emptyList<SourceSyncStatus>(), applied)
    }
}
