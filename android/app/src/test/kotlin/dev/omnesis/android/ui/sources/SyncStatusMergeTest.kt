// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.SourceNotice
import dev.omnesis.android.transport.dto.SourceSyncStatus
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

/**
 * Spec for the live `sync.status` WS merge, ported from the iOS AdminCoordinator merge
 * (the iOS `merge`/`SyncStatusBroadcast` pair). Different lifecycle phases populate
 * different subsets of fields; the merge carries forward what a partial broadcast omits.
 */
class SyncStatusMergeTest {

    private val now = Instant.parse("2026-06-10T12:00:00Z")

    private fun broadcast(json: String): SyncStatusBroadcast =
        SyncStatusBroadcast.decode(OmnesisJson.parseToJsonElement(json).jsonObject)!!

    @Test
    fun `completed maps to canonical synced and stamps lastSyncAt clearing progress`() {
        val existing = SourceSyncStatus(
            sourceId = "s",
            state = "syncing",
            progress = SourceSyncStatus.Progress(processed = 5, total = 10),
        )
        val b = broadcast("""{"sourceId":"s","state":"completed","completedAt":1717000000000}""")
        val merged = mergeSyncStatus(existing, b, "s", now)

        assertEquals("synced", merged.state)
        assertNull("progress is dropped once not syncing", merged.progress)
        assertNotNull(merged.lastSyncAt)
        assertNull(merged.erroredAt)
    }

    @Test
    fun `syncing without progress carries forward the prior progress`() {
        val existing = SourceSyncStatus(
            sourceId = "s",
            state = "syncing",
            progress = SourceSyncStatus.Progress(processed = 7, total = 12, message = "Page 1"),
        )
        val b = broadcast("""{"sourceId":"s","state":"syncing"}""")
        val merged = mergeSyncStatus(existing, b, "s", now)

        assertEquals("syncing", merged.state)
        assertEquals(7, merged.progress?.processed)
        assertEquals(12, merged.progress?.total)
        assertEquals("Page 1", merged.progress?.message)
    }

    @Test
    fun `syncing with explicit progress overrides the prior progress`() {
        val existing = SourceSyncStatus(
            sourceId = "s",
            state = "syncing",
            progress = SourceSyncStatus.Progress(processed = 1, total = 10),
        )
        val b = broadcast("""{"sourceId":"s","state":"syncing","progress":{"processed":9,"total":10,"percentComplete":90.0}}""")
        val merged = mergeSyncStatus(existing, b, "s", now)

        assertEquals(9, merged.progress?.processed)
        assertEquals(90.0, merged.progress?.percentComplete!!, 0.0001)
    }

    @Test
    fun `error stamps erroredAt and carries the message`() {
        val b = broadcast("""{"sourceId":"s","state":"error","errorMessage":"boom"}""")
        val merged = mergeSyncStatus(null, b, "s", now)

        assertEquals("error", merged.state)
        assertEquals("boom", merged.errorMessage)
        assertNotNull(merged.erroredAt)
    }

    @Test
    fun `lastSyncAt is carried forward when a syncing event has no completedAt`() {
        val existing = SourceSyncStatus(sourceId = "s", state = "synced", lastSyncAt = "2026-06-09T00:00:00Z")
        val b = broadcast("""{"sourceId":"s","state":"syncing"}""")
        val merged = mergeSyncStatus(existing, b, "s", now)

        assertEquals("2026-06-09T00:00:00Z", merged.lastSyncAt)
    }

    @Test
    fun `unitName and deviceId fall back to the existing value`() {
        val existing = SourceSyncStatus(sourceId = "s", state = "syncing", unitName = "emails", deviceId = "dev-1")
        val b = broadcast("""{"sourceId":"s","state":"syncing"}""")
        val merged = mergeSyncStatus(existing, b, "s", now)

        assertEquals("emails", merged.unitName)
        assertEquals("dev-1", merged.deviceId)
    }

    @Test
    fun `null state decodes to idle canonical`() {
        val b = broadcast("""{"sourceId":"s"}""")
        assertEquals("idle", b.canonicalState)
    }

    @Test
    fun `auth-expiring broadcast carries the consent deadline through`() {
        val b = broadcast(
            """{"sourceId":"s","state":"auth-expiring","consentExpiresAt":"2026-07-15T00:00:00Z"}""",
        )
        val merged = mergeSyncStatus(null, b, "s", now)

        assertEquals("auth-expiring", merged.state)
        assertEquals("2026-07-15T00:00:00Z", merged.consentExpiresAt)
    }

    @Test
    fun `a progress event without a deadline does not blank a known consent deadline`() {
        val existing = SourceSyncStatus(
            sourceId = "s",
            state = "auth-expiring",
            consentExpiresAt = "2026-07-15T00:00:00Z",
        )
        // A plain "syncing"/progress broadcast omits consentExpiresAt; it must be carried forward.
        val b = broadcast("""{"sourceId":"s","state":"syncing"}""")
        val merged = mergeSyncStatus(existing, b, "s", now)

        assertEquals("syncing", merged.state)
        assertEquals("2026-07-15T00:00:00Z", merged.consentExpiresAt)
    }

    @Test
    fun `consent deadline is null when never reported`() {
        val b = broadcast("""{"sourceId":"s","state":"synced","completedAt":1717000000000}""")
        val merged = mergeSyncStatus(null, b, "s", now)

        assertNull(merged.consentExpiresAt)
    }

    // A broadcast relays the collector's raw lifecycle state, which cannot express a
    // state the gateway derives. A stalled source keeps completing syncs on its normal
    // interval, so letting "completed" flatten the overlay would blank the warning every
    // few minutes and leave it visible only right after a full status fetch.
    @Test
    fun `a completed broadcast does not erase a derived stale overlay`() {
        val existing = SourceSyncStatus(
            sourceId = "s",
            state = "stale",
            staleHint = "Open the app to resume syncing.",
        )
        val merged = mergeSyncStatus(existing, broadcast("""{"sourceId":"s","state":"completed"}"""), "s", now)

        assertEquals("stale", merged.state)
        assertEquals("Open the app to resume syncing.", merged.staleHint)
    }

    @Test
    fun `a completed broadcast does not erase a derived auth-expiring overlay`() {
        val existing = SourceSyncStatus(sourceId = "s", state = "auth-expiring")
        val merged = mergeSyncStatus(existing, broadcast("""{"sourceId":"s","state":"completed"}"""), "s", now)

        assertEquals("auth-expiring", merged.state)
    }

    // The overlay is held, not pinned: a real failure still takes precedence, and a
    // full status fetch re-derives from scratch.
    @Test
    fun `an error broadcast still overrides a stale overlay`() {
        val existing = SourceSyncStatus(sourceId = "s", state = "stale", staleHint = "Open the app.")
        val merged = mergeSyncStatus(
            existing,
            broadcast("""{"sourceId":"s","state":"error","errorMessage":"boom"}"""),
            "s",
            now,
        )

        assertEquals("error", merged.state)
    }

    private val info = SourceNotice(kind = "coverage-partial", severity = "info", title = "Only recent history is reachable")
    private val warning = SourceNotice(kind = "sync-issue", severity = "warning", title = "One folder could not be read")

    @Test
    fun `a progress tick keeps the notices of the last fetch`() {
        val existing = SourceSyncStatus(sourceId = "s", state = "syncing", notices = listOf(warning))
        val merged = mergeSyncStatus(existing, broadcast("""{"sourceId":"s","state":"syncing","progress":{"processed":3}}"""), "s", now)
        assertEquals(listOf(warning), merged.notices)
    }

    @Test
    fun `a state change drops the fetched notices so the state fallback covers the gap`() {
        val existing = SourceSyncStatus(sourceId = "s", state = "synced", notices = listOf(info))
        val merged = mergeSyncStatus(
            existing,
            broadcast("""{"sourceId":"s","state":"error","errorMessage":"Disk unavailable"}"""),
            "s",
            now,
        )
        assertNull(merged.notices)
        assertEquals("The last sync failed", merged.displayNotices.single().title)
    }

    @Test
    fun `a report from another device drops a single-device status's notices`() {
        val existing = SourceSyncStatus(sourceId = "s", deviceId = "a", state = "synced", notices = listOf(info))
        val merged = mergeSyncStatus(existing, broadcast("""{"sourceId":"s","deviceId":"b","state":"synced"}"""), "s", now)
        assertNull(merged.notices)
    }

    @Test
    fun `a broadcast keeps every member and merges only the broadcasting device`() {
        val existing = SourceSyncStatus(
            sourceId = "s",
            state = "synced",
            members = listOf(
                SourceSyncStatus(sourceId = "s", deviceId = "a", state = "synced", notices = listOf(info)),
                SourceSyncStatus(sourceId = "s", deviceId = "b", state = "synced", notices = listOf(warning)),
            ),
        )
        val merged = mergeSyncStatus(
            existing,
            broadcast("""{"sourceId":"s","deviceId":"b","state":"syncing"}"""),
            "s",
            now,
        )
        val members = merged.members!!
        assertEquals(listOf("a", "b"), members.map { it.deviceId })
        assertEquals("synced", members[0].state)
        assertEquals(listOf(info), members[0].notices)
        assertEquals("syncing", members[1].state)
        assertNull("b's state moved, so its fetched notices no longer apply", members[1].notices)
    }

    @Test
    fun `a shared source stays syncing while any member syncs`() {
        val existing = SourceSyncStatus(
            sourceId = "s",
            state = "syncing",
            members = listOf(
                SourceSyncStatus(sourceId = "s", deviceId = "a", state = "syncing"),
                SourceSyncStatus(sourceId = "s", deviceId = "b", state = "syncing"),
            ),
        )
        val oneDone = mergeSyncStatus(
            existing,
            broadcast("""{"sourceId":"s","deviceId":"b","state":"completed","completedAt":1717000000000}"""),
            "s",
            now,
        )
        assertEquals("syncing", oneDone.state)
        val bothDone = mergeSyncStatus(
            oneDone,
            broadcast("""{"sourceId":"s","deviceId":"a","state":"completed","completedAt":1717000000000}"""),
            "s",
            now,
        )
        assertEquals("synced", bothDone.state)
    }

    @Test
    fun `a shared source takes the latest report once nothing syncs`() {
        val existing = SourceSyncStatus(
            sourceId = "s",
            state = "synced",
            members = listOf(SourceSyncStatus(sourceId = "s", deviceId = "a", state = "synced")),
        )
        val merged = mergeSyncStatus(
            existing,
            broadcast("""{"sourceId":"s","deviceId":"a","state":"error","errorMessage":"Disk unavailable"}"""),
            "s",
            now,
        )
        assertEquals("error", merged.state)
        assertEquals("error", merged.members!!.single().state)
    }
}
