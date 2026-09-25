// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

class SourceSyncStatusRowTest {
    private val now = Instant.parse("2026-09-03T10:00:00Z")

    @Test
    fun `persisted success shows its last successful update`() {
        val summary = sourceSyncStatusSummary(
            state = "synced",
            lastSyncAt = "2026-09-03T08:00:00Z",
            now = now,
        )

        assertEquals("Last synced 2h ago", summary.text)
        assertEquals(SyncStatusTone.SUCCESS, summary.tone)
    }

    @Test
    fun `live remote run carries the gateway progress message`() {
        val summary = sourceSyncStatusSummary(
            state = "syncing",
            progressMessage = "Processing recent activity",
            now = now,
        )

        assertEquals("Processing recent activity", summary.text)
        assertEquals(SyncStatusTone.NEUTRAL, summary.tone)
    }

    @Test
    fun `failing and stalled states keep the last-sync wording, never the failure text`() {
        for (state in listOf("error", "needs-auth", "rate-limited", "stale", "auth-expiring")) {
            val summary = sourceSyncStatusSummary(state = state, lastSyncAt = "2026-09-03T08:00:00Z", now = now)
            assertEquals(state, "Last synced 2h ago", summary.text)
            assertEquals(state, SyncStatusTone.NEUTRAL, summary.tone)
        }
        assertEquals("Not synced yet", sourceSyncStatusSummary(state = "error", now = now).text)
    }

    @Test
    fun `phone-local permission states stay actionable`() {
        val degraded = sourceSyncStatusSummary(state = "permission-degraded", now = now)
        assertEquals("Permissions need attention", degraded.text)
        assertEquals(SyncStatusTone.WARNING, degraded.tone)
    }
}

class SourceNoticesFormatTest {
    private val now = Instant.parse("2026-09-03T10:00:00Z")
    private fun notice(severity: NoticeSeverity) = NoticeUi(severity, "t")

    @Test
    fun `descriptions count each severity present`() {
        assertEquals(
            "2 warnings for studio-mac",
            noticesDescription(listOf(notice(NoticeSeverity.WARNING), notice(NoticeSeverity.WARNING)), "studio-mac"),
        )
        assertEquals(
            "1 error, 1 warning and 2 notices for Gmail",
            noticesDescription(
                listOf(
                    notice(NoticeSeverity.INFO), notice(NoticeSeverity.ERROR),
                    notice(NoticeSeverity.WARNING), notice(NoticeSeverity.INFO),
                ),
                "Gmail",
            ),
        )
    }

    @Test
    fun `since reads relative, then as a date`() {
        assertEquals("Since 3h ago", noticeSinceLabel("2026-09-03T07:00:00Z", now))
        assertEquals("Since Jul 1", noticeSinceLabel("2026-07-01T12:00:00Z", now))
        assertEquals(null, noticeSinceLabel("not-a-date", now))
    }

    @Test
    fun `the worst severity wins`() {
        assertEquals(
            NoticeSeverity.ERROR,
            worstSeverity(listOf(notice(NoticeSeverity.INFO), notice(NoticeSeverity.ERROR), notice(NoticeSeverity.WARNING))),
        )
        assertEquals(null, worstSeverity(emptyList()))
    }
}
