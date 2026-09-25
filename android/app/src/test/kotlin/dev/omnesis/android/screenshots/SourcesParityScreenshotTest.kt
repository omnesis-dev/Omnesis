// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.RecentDocument
import dev.omnesis.android.transport.dto.RecentItemsResponse
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.CursorPagingState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.components.NoticeGroup
import dev.omnesis.android.designsystem.components.NoticeSeverity
import dev.omnesis.android.designsystem.components.NoticeSheetBody
import dev.omnesis.android.designsystem.components.NoticeUi
import dev.omnesis.android.ui.sources.SourceDetailContent
import dev.omnesis.android.ui.sources.SourceDetailUi
import dev.omnesis.android.ui.sources.SourceHostDeviceUi
import dev.omnesis.android.ui.sources.SourceRecentContent
import dev.omnesis.android.ui.sources.SourceRowUi
import dev.omnesis.android.ui.sources.SourcesContent
import dev.omnesis.android.ui.sources.SourcesOverview
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Pixel-parity snapshots for the Sources area (list + detail + recent), rebuilt against the
 * iOS reference fixtures 01/02/02b/02c/03/04/05/40/41/42. All sample data is invented
 * (privacy rule) — never sourced from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SourcesParityScreenshotTest {

    private val connected = ConnectionState.Connected("d1", "Studio Northstar", listOf("read", "write"))

    private fun capture(name: String, dark: Boolean, content: @androidx.compose.runtime.Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    @Test fun source_removal_confirmation_light() = capture("source_removal_confirmation_light", false) {
        dev.omnesis.android.ui.sources.RemoveSourceDialog("Notes", {}, {})
    }
    @Test fun source_removal_confirmation_dark() = capture("source_removal_confirmation_dark", true) {
        dev.omnesis.android.ui.sources.RemoveSourceDialog("Notes", {}, {})
    }
    @Test fun source_stop_changed_membership_light() = capture("source_stop_changed_membership_light", false) {
        dev.omnesis.android.designsystem.components.StopContributingDialog(onConfirm = {}, onDismiss = {})
    }
    @Test fun source_stop_changed_membership_dark() = capture("source_stop_changed_membership_dark", true) {
        dev.omnesis.android.designsystem.components.StopContributingDialog(onConfirm = {}, onDismiss = {})
    }
    @Test fun source_stop_pending_light() = capture("source_stop_pending_light", false) {
        androidx.compose.material3.Surface(color = dev.omnesis.android.designsystem.theme.OmTheme.colors.bgPrimary) {
            dev.omnesis.android.feature.health.ui.HealthSettingsSectionContent(
                dev.omnesis.android.feature.health.ui.HealthViewModel.UiState(
                    enabled = false,
                    membershipPending = "Stop pending — uploads are off on this phone. The gateway will detach or pause when reachable; this phone's partition may be deleted.",
                ), {}, {}, {}, { _, _ -> }, {},
            )
        }
    }
    @Test fun source_stop_pending_dark() = capture("source_stop_pending_dark", true) {
        androidx.compose.material3.Surface(color = dev.omnesis.android.designsystem.theme.OmTheme.colors.bgPrimary) {
            dev.omnesis.android.feature.health.ui.HealthSettingsSectionContent(
                dev.omnesis.android.feature.health.ui.HealthViewModel.UiState(
                    enabled = false,
                    membershipPending = "Stop pending — uploads are off on this phone. The gateway will detach or pause when reachable; this phone's partition may be deleted.",
                ), {}, {}, {}, { _, _ -> }, {},
            )
        }
    }

    @Test fun source_removed_light() = capture("source_removed_light", false) {
        SourceDetailContent(Loadable.Error(dev.omnesis.android.ui.sources.SourceNoLongerAvailable()), {}, {}, {})
    }
    @Test fun source_removed_dark() = capture("source_removed_dark", true) {
        SourceDetailContent(Loadable.Error(dev.omnesis.android.ui.sources.SourceNoLongerAvailable()), {}, {}, {})
    }

    @Test fun sources_pending_removal_light() = capture("sources_pending_removal_light", false) {
        SourcesContent(Loadable.Content(populated().copy(
            overview = overview().copy(sourceCount = 0),
            sources = emptyList(),
            pendingRemovals = listOf(dev.omnesis.android.transport.dto.PendingSourceRemoval("notes:local", "notes", "local")),
        )), connected, onOpenMenu = {}, onRetry = {}, onOpenSource = {})
    }
    @Test fun sources_pending_removal_dark() = capture("sources_pending_removal_dark", true) {
        SourcesContent(Loadable.Content(populated().copy(
            overview = overview().copy(sourceCount = 0),
            sources = emptyList(),
            pendingRemovals = listOf(dev.omnesis.android.transport.dto.PendingSourceRemoval("notes:local", "notes", "local")),
        )), connected, onOpenMenu = {}, onRetry = {}, onOpenSource = {})
    }

    // --- Sample data (invented) ---

    private fun overview() = SourcesOverview(
        sourceCount = 5, totalDocs = 165_100, totalChunks = 426_100, diskSize = "4 GB",
        embeddingModel = "nomic-embed-text-v1.5.Q8_0.gguf", indexLabel = "Indexing",
        enabled = true, totalIndexed = 163_500, diskBytes = 4_000_000_000L,
    )

    private fun rows() = listOf(
        SourceRowUi(
            sourceId = "apple-health:user@example.com", label = "Apple Health", accountId = "user@example.com",
            icon = SourceIconModel(fallbackInitial = "H"), countLabel = "128,000 docs",
            syncState = "synced", percentIndexed = 98.0, hostDevice = "iPhone",
            lastActivity = null, progressPercent = null, progressMessage = null,
            paused = false, count = 128_000, unit = "docs", activityAgo = null,
        ),
        SourceRowUi(
            sourceId = "apple-notes:user@example.com", label = "Apple Notes", accountId = "user@example.com",
            icon = SourceIconModel(fallbackInitial = "N"), countLabel = "4 notes",
            syncState = "synced", percentIndexed = null, hostDevice = "studio-desktop",
            lastActivity = "Standup notes — Mar 9", progressPercent = null, progressMessage = null,
            paused = false, count = 4, unit = "notes", activityAgo = "20m ago",
        ),
        SourceRowUi(
            sourceId = "gmail:user@example.com", label = "Gmail", accountId = "user@example.com",
            icon = SourceIconModel(fallbackInitial = "G"), countLabel = "509 emails",
            syncState = "syncing", percentIndexed = 100.0, hostDevice = "studio-desktop",
            lastActivity = "Welcome to your weekly summary", progressPercent = 50.0,
            progressMessage = "Page 6 of 12", paused = false, count = 509, unit = "emails",
            activityAgo = "1m ago",
        ),
        SourceRowUi(
            sourceId = "strava:1234567", label = "Strava", accountId = "1234567",
            icon = SourceIconModel(fallbackInitial = "S"), countLabel = "10 activities",
            syncState = "idle", percentIndexed = null, hostDevice = "studio-desktop",
            lastActivity = null, progressPercent = null, progressMessage = null,
            paused = true, count = 10, unit = "activities", activityAgo = null,
        ),
        SourceRowUi(
            sourceId = "whatsapp-messages:+15550100000", label = "WhatsApp", accountId = "+15550100000",
            icon = SourceIconModel(fallbackInitial = "W"), countLabel = "17,421 messages",
            syncState = "error", percentIndexed = 100.0, hostDevice = "studio-desktop",
            lastActivity = null, progressPercent = null, progressMessage = null,
            paused = false, count = 17_421, unit = "messages", activityAgo = null,
            noticeGroups = listOf(NoticeGroup("studio-desktop", listOf(failedNotice))),
        ),
        // Forward-looking consent expiry (#927): amber "expiring" pill, and a warning
        // notice beside the host instead of a line of text.
        SourceRowUi(
            sourceId = "bank:acct-0042", label = "Bank", accountId = "acct-0042",
            icon = SourceIconModel(fallbackInitial = "B"), countLabel = "1,204 transactions",
            syncState = "auth-expiring", percentIndexed = 100.0, hostDevice = "studio-desktop",
            lastActivity = null, progressPercent = null, progressMessage = null,
            paused = false, count = 1_204, unit = "transactions", activityAgo = null,
            noticeGroups = listOf(NoticeGroup("studio-desktop", listOf(expiringNotice))),
        ),
        // A source two computers contribute to: the row names the device count and shows
        // the worst notice; the sheet lists each device's notices under its name.
        SourceRowUi(
            sourceId = "files:shared", label = "Files", accountId = "shared",
            icon = SourceIconModel(fallbackInitial = "F"), countLabel = "2,310 files",
            syncState = "synced", percentIndexed = 100.0, hostDevice = "2 devices",
            lastActivity = null, progressPercent = null, progressMessage = null,
            paused = false, count = 2_310, unit = "files", activityAgo = null,
            noticeGroups = memberNoticeGroups(),
        ),
    )

    // --- Notices (invented) ---

    private val failedNotice = NoticeUi(
        NoticeSeverity.ERROR, "The last sync failed",
        detail = "The connection was refused.",
        steps = listOf("Check that the app is running on this computer.", "Sync again."),
        since = "2026-01-05T12:00:00Z",
    )

    private val needsAuthNotice = NoticeUi(
        NoticeSeverity.ERROR, "Needs sign-in",
        detail = "The connection's access was revoked.",
        steps = listOf("Reconnect the account from the portal."),
    )

    private val expiringNotice = NoticeUi(NoticeSeverity.WARNING, "Connection expires on Jul 15, 2026")

    private val staleNotice = NoticeUi(
        NoticeSeverity.WARNING, "No new data is arriving",
        detail = "Taskbook isn't running on this machine, so it can't pull new tasks.",
        steps = listOf("Open Taskbook.", "Set it to open at login."),
        since = "2026-01-04T12:00:00Z",
    )

    private val coverageNotice = NoticeUi(
        NoticeSeverity.INFO, "Only recent history is reachable",
        detail = "The provider supplies the last 90 days on this device.",
    )

    private val disputeNotice = NoticeUi(
        NoticeSeverity.INFO, "Some items were restored here",
        detail = "This device still has 3 items another device deleted. They stay until this device deletes them too.",
    )

    private val folderNotice = NoticeUi(
        NoticeSeverity.WARNING, "One folder could not be read",
        detail = "Deletion detection is paused for that folder.",
        steps = listOf("Check the folder's permissions.", "Sync again."),
        since = "2026-01-05T12:00:00Z",
    )

    private fun memberNoticeGroups() = listOf(
        NoticeGroup("studio-mac", listOf(coverageNotice)),
        NoticeGroup("travel-laptop", listOf(folderNotice, disputeNotice)),
    )

    private fun populated(refreshError: Throwable? = null) =
        SourcesContent(overview(), rows(), refreshError = refreshError)

    // --- List states (01 / 02 / 02b / 02c) ---

    @Test
    fun sources_populated_dark() = capture("sources_populated_dark", dark = true) {
        SourcesContent(Loadable.Content(populated()), connected, onOpenMenu = {}, onRetry = {}, onOpenSource = {})
    }

    @Test
    fun sources_populated_light() = capture("sources_populated_light", dark = false) {
        SourcesContent(Loadable.Content(populated()), connected, onOpenMenu = {}, onRetry = {}, onOpenSource = {})
    }

    @Test
    fun sources_empty_dark() = capture("sources_empty_dark", dark = true) {
        SourcesContent(
            Loadable.Content(SourcesContent(overview().copy(sourceCount = 0), emptyList())),
            connected, onOpenMenu = {}, onRetry = {}, onOpenSource = {},
        )
    }

    @Test
    fun sources_first_load_error_dark() = capture("sources_first_load_error_dark", dark = true) {
        SourcesContent(
            Loadable.Error(GatewayException.Network(Exception("offline"))),
            connected, onOpenMenu = {}, onRetry = {}, onOpenSource = {},
        )
    }

    @Test
    fun sources_inline_banner_dark() = capture("sources_inline_banner_dark", dark = true) {
        SourcesContent(
            Loadable.Content(populated(refreshError = GatewayException.Network(Exception("offline")))),
            connected, onOpenMenu = {}, onRetry = {}, onOpenSource = {},
        )
    }

    // --- Detail states (03 / 04 / 05) ---

    private fun detailSynced() = SourceDetailUi(
        sourceId = "apple-notes:user@example.com", label = "Apple Notes", accountId = "user@example.com",
        icon = SourceIconModel(fallbackInitial = "N"), type = "apple-notes",
        hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-desktop")),
        syncState = "synced", lastSyncAt = "2026-01-06T08:55:00Z",
        percentIndexed = 100.0, progressPercent = null, progressMessage = null,
    )

    private fun detailMultipleHosts() = SourceDetailUi(
        sourceId = "agent-sessions:local", label = "Agent Sessions", accountId = "local",
        icon = SourceIconModel(fallbackInitial = "A"), type = "agent-sessions",
        hostDevices = listOf(
            SourceHostDeviceUi("dev-studio", "studio-mac"),
            SourceHostDeviceUi("dev-laptop", "travel-laptop"),
            SourceHostDeviceUi("dev-server", "home-server"),
        ),
        syncState = "synced", lastSyncAt = "2026-01-06T08:55:00Z",
        percentIndexed = 100.0, progressPercent = null, progressMessage = null,
    )

    private fun detailSyncing() = SourceDetailUi(
        sourceId = "gmail:user@example.com", label = "Gmail", accountId = "user@example.com",
        icon = SourceIconModel(fallbackInitial = "G"), type = "gmail",
        hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-desktop")),
        syncState = "syncing", lastSyncAt = "2026-01-06T08:57:00Z",
        percentIndexed = 100.0, progressPercent = 48.0, progressMessage = "Page 6 of 12",
        unit = "emails", progressTotal = 500, progressDone = 240,
    )

    private fun detailError() = SourceDetailUi(
        sourceId = "whatsapp-messages:+15550100000", label = "WhatsApp", accountId = "+15550100000",
        icon = SourceIconModel(fallbackInitial = "W"), type = "whatsapp-messages",
        hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-desktop", listOf(failedNotice))),
        syncState = "error", lastSyncAt = "2026-01-06T08:00:00Z",
        percentIndexed = null, progressPercent = null, progressMessage = null,
    )

    private fun detailNeedsAuth() = SourceDetailUi(
        sourceId = "notion-pages:user@example.com", label = "Notion", accountId = "user@example.com",
        icon = SourceIconModel(fallbackInitial = "N"), type = "notion-pages",
        hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-desktop", listOf(needsAuthNotice))),
        syncState = "needs-auth", lastSyncAt = "2026-01-06T08:00:00Z",
        percentIndexed = null, progressPercent = null, progressMessage = null,
    )

    // Forward-looking consent expiry (#927): amber pill, and the gateway's warning
    // notice beside the host device.
    private fun detailExpiring() = SourceDetailUi(
        sourceId = "bank:acct-0042", label = "Bank", accountId = "acct-0042",
        icon = SourceIconModel(fallbackInitial = "B"), type = "bank",
        hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-desktop", listOf(expiringNotice))),
        syncState = "auth-expiring", lastSyncAt = "2026-01-06T08:55:00Z",
        percentIndexed = 100.0, progressPercent = null, progressMessage = null,
        unit = "transactions",
    )

    // A stalled local feed: the source syncs fine, but the app maintaining the file it
    // reads isn't running. The warning notice sits beside the host device.
    private fun detailStale() = SourceDetailUi(
        sourceId = "taskbook:local", label = "Taskbook", accountId = "local",
        icon = SourceIconModel(fallbackInitial = "T"), type = "taskbook",
        hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-desktop", listOf(staleNotice))),
        syncState = "stale", lastSyncAt = "2026-01-06T08:55:00Z",
        percentIndexed = 100.0, progressPercent = null, progressMessage = null,
        unit = "tasks",
    )

    // A source three computers contribute to: each device's notices sit beside it.
    private fun detailMemberNotices() = SourceDetailUi(
        sourceId = "files:shared", label = "Files", accountId = "shared",
        icon = SourceIconModel(fallbackInitial = "F"), type = "files",
        hostDevices = listOf(
            SourceHostDeviceUi("dev-studio", "studio-mac", listOf(coverageNotice)),
            SourceHostDeviceUi("dev-travel", "travel-laptop", listOf(folderNotice, disputeNotice)),
            SourceHostDeviceUi("dev-server", "home-server"),
        ),
        syncState = "synced", lastSyncAt = "2026-01-06T08:55:00Z",
        percentIndexed = 100.0, progressPercent = null, progressMessage = null,
        unit = "files",
    )

    @Test
    fun source_detail_member_notices_dark() = capture("source_detail_member_notices_dark", dark = true) {
        SourceDetailContent(Loadable.Content(detailMemberNotices()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_member_notices_light() = capture("source_detail_member_notices_light", dark = false) {
        SourceDetailContent(Loadable.Content(detailMemberNotices()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    // The sheet a device's icon opens, rendered on the surface the ModalBottomSheet supplies.
    @Composable
    private fun SheetSurface(content: @Composable () -> Unit) {
        Surface(color = OmTheme.colors.bgPrimary) {
            Box(Modifier.fillMaxWidth().padding(top = 24.dp)) { content() }
        }
    }

    @Test
    fun source_notice_sheet_device_dark() = capture("source_notice_sheet_device_dark", dark = true) {
        SheetSurface { NoticeSheetBody("travel-laptop", listOf(NoticeGroup(null, listOf(folderNotice, disputeNotice)))) }
    }

    @Test
    fun source_notice_sheet_device_light() = capture("source_notice_sheet_device_light", dark = false) {
        SheetSurface { NoticeSheetBody("travel-laptop", listOf(NoticeGroup(null, listOf(folderNotice, disputeNotice)))) }
    }

    @Test
    fun sources_notice_sheet_list_dark() = capture("sources_notice_sheet_list_dark", dark = true) {
        SheetSurface { NoticeSheetBody("Files", memberNoticeGroups(), deviceHeadings = true) }
    }

    @Test
    fun sources_notice_sheet_list_light() = capture("sources_notice_sheet_list_light", dark = false) {
        SheetSurface { NoticeSheetBody("Files", memberNoticeGroups(), deviceHeadings = true) }
    }

    @Test
    fun source_detail_stale_dark() = capture("source_detail_stale_dark", dark = true) {
        SourceDetailContent(Loadable.Content(detailStale()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_stale_light() = capture("source_detail_stale_light", dark = false) {
        SourceDetailContent(Loadable.Content(detailStale()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_expiring_dark() = capture("source_detail_expiring_dark", dark = true) {
        SourceDetailContent(Loadable.Content(detailExpiring()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_expiring_light() = capture("source_detail_expiring_light", dark = false) {
        SourceDetailContent(Loadable.Content(detailExpiring()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_needs_auth_dark() = capture("source_detail_needs_auth_dark", dark = true) {
        SourceDetailContent(Loadable.Content(detailNeedsAuth()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_synced_dark() = capture("source_detail_synced_dark", dark = true) {
        SourceDetailContent(Loadable.Content(detailSynced()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_synced_light() = capture("source_detail_synced_light", dark = false) {
        SourceDetailContent(Loadable.Content(detailSynced()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_multiple_hosts_dark() = capture("source_detail_multiple_hosts_dark", dark = true) {
        SourceDetailContent(Loadable.Content(detailMultipleHosts()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_multiple_hosts_light() = capture("source_detail_multiple_hosts_light", dark = false) {
        SourceDetailContent(Loadable.Content(detailMultipleHosts()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_syncing_dark() = capture("source_detail_syncing_dark", dark = true) {
        SourceDetailContent(Loadable.Content(detailSyncing()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_detail_error_dark() = capture("source_detail_error_dark", dark = true) {
        SourceDetailContent(Loadable.Content(detailError()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    // --- Recent states (40 / 41 / 42) ---

    private val gmailIcon: (String) -> SourceIconModel = { SourceIconModel(fallbackInitial = "G") }

    private fun recentDocs() = RecentItemsResponse.Documents(
        listOf(
            RecentDocument(
                id = "d1", sourceId = "gmail:user@example.com", title = "Re: Northwind invoice for March",
                documentType = "email", contentPreview = "Your invoice for the period of Mar 1–31 is now available.",
                sourceCreatedAt = "2026-01-05T08:30:00Z",
            ),
            RecentDocument(
                id = "d2", sourceId = "gmail:user@example.com", title = "Welcome to your weekly summary",
                documentType = "email", contentPreview = "This week you sent 47 emails and received 312.",
                sourceCreatedAt = "2026-01-05T08:00:00Z",
            ),
        ),
    )

    private fun recentAnalytics() = RecentItemsResponse.Analytics(
        table = "strava_activities",
        displayName = "Strava activities",
        columns = listOf("activity_id", "started_at", "distance_km", "active"),
        rows = listOf(
            listOf(
                JsonPrimitive("run-001"),
                JsonPrimitive("2026-01-05T08:30:00Z"),
                JsonPrimitive(8.4),
                JsonPrimitive(true),
            ),
            listOf(
                JsonPrimitive("ride-002"),
                JsonPrimitive("2026-01-03T14:10:00Z"),
                JsonPrimitive(24.75),
                JsonPrimitive(false),
            ),
            listOf(
                JsonPrimitive("walk-003"),
                JsonPrimitive("2026-01-02T12:00:00Z"),
                JsonPrimitive(3),
                JsonPrimitive(true),
            ),
        ),
    )

    @Test
    fun source_recent_documents_dark() = capture("source_recent_documents_dark", dark = true) {
        SourceRecentContent("Gmail", Loadable.Content(recentDocs()), onBack = {}, onRetry = {}, onOpenDocument = {}, iconFor = gmailIcon)
    }

    @Test
    fun source_recent_documents_light() = capture("source_recent_documents_light", dark = false) {
        SourceRecentContent("Gmail", Loadable.Content(recentDocs()), onBack = {}, onRetry = {}, onOpenDocument = {}, iconFor = gmailIcon)
    }

    @Test
    fun source_recent_analytics_dark() = capture("source_recent_analytics_dark", dark = true) {
        SourceRecentContent(
            "Strava",
            Loadable.Content(recentAnalytics()),
            onBack = {}, onRetry = {}, onOpenDocument = {},
        )
    }

    @Test
    fun source_recent_analytics_light() = capture("source_recent_analytics_light", dark = false) {
        SourceRecentContent(
            "Strava",
            Loadable.Content(recentAnalytics()),
            onBack = {}, onRetry = {}, onOpenDocument = {},
        )
    }

    @Test
    fun source_recent_paging_dark() = capture("source_recent_paging_dark", dark = true) {
        SourceRecentContent(
            "Strava",
            Loadable.Content(recentAnalytics().copy(rows = recentAnalytics().rows.take(1))),
            onBack = {},
            onRetry = {},
            onOpenDocument = {},
            paging = CursorPagingState(nextCursor = "next-page"),
        )
    }

    @Test
    fun source_recent_paging_light() = capture("source_recent_paging_light", dark = false) {
        SourceRecentContent(
            "Strava",
            Loadable.Content(recentAnalytics().copy(rows = recentAnalytics().rows.take(1))),
            onBack = {},
            onRetry = {},
            onOpenDocument = {},
            paging = CursorPagingState(nextCursor = "next-page"),
        )
    }

    @Test
    fun source_recent_empty_pageable_dark() = capture("source_recent_empty_pageable_dark", dark = true) {
        SourceRecentContent(
            "Notes",
            Loadable.Content(RecentItemsResponse.Documents()),
            onBack = {},
            onRetry = {},
            onOpenDocument = {},
            paging = CursorPagingState(nextCursor = "next-page"),
        )
    }

    @Test
    fun source_recent_empty_pageable_light() = capture("source_recent_empty_pageable_light", dark = false) {
        SourceRecentContent(
            "Notes",
            Loadable.Content(RecentItemsResponse.Documents()),
            onBack = {},
            onRetry = {},
            onOpenDocument = {},
            paging = CursorPagingState(nextCursor = "next-page"),
        )
    }

    @Test
    fun source_recent_empty_dark() = capture("source_recent_empty_dark", dark = true) {
        SourceRecentContent("Files", Loadable.Content(RecentItemsResponse.Empty()), onBack = {}, onRetry = {}, onOpenDocument = {})
    }

}
