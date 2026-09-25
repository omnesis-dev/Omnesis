// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import dev.omnesis.android.designsystem.components.NoticeGroup
import dev.omnesis.android.designsystem.components.NoticeSeverity
import dev.omnesis.android.designsystem.components.NoticeUi
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.components.worstSeverity
import dev.omnesis.android.setup.notices.toNoticeUi
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.NoticeLevel
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import dev.omnesis.android.transport.dto.SourceNotice
import dev.omnesis.android.transport.dto.SourceSyncStatus
import dev.omnesis.android.ui.common.Loadable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** How the gateway's notices land beside the device they belong to. */
class SourceNoticesMappingTest {

    private val info = SourceNotice(kind = "coverage-partial", severity = "info", title = "Only recent history is reachable")
    private val dispute = SourceNotice(kind = "replica-dispute", severity = "info", title = "Some items were restored here")
    private val issue = SourceNotice(kind = "sync-issue", severity = "warning", title = "One folder could not be read")
    private val failed = SourceNotice(kind = "error", severity = "error", title = "The last sync failed")

    private fun member(deviceId: String, vararg notices: SourceNotice) =
        SourceSyncStatus(sourceId = "s", deviceId = deviceId, state = "synced", notices = notices.toList())

    @Test
    fun `members place their notices beside their own device`() {
        val status = SourceSyncStatus(
            sourceId = "s",
            state = "synced",
            members = listOf(member("studio", info), member("travel", issue, dispute), member("server")),
        )
        val placed = attributeNotices(status, listOf("studio", "travel", "server"))
        assertEquals(listOf(info), placed.byDevice["studio"])
        assertEquals(listOf(issue, dispute), placed.byDevice["travel"])
        assertNull(placed.byDevice["server"])
        assertEquals(emptyList<SourceNotice>(), placed.unattributed)
    }

    @Test
    fun `a member on a device the record does not list stays visible`() {
        val status = SourceSyncStatus(sourceId = "s", state = "synced", members = listOf(member("elsewhere", issue)))
        val placed = attributeNotices(status, listOf("studio"))
        assertEquals(emptyMap<String, List<SourceNotice>>(), placed.byDevice)
        assertEquals(listOf(issue), placed.unattributed)
    }

    @Test
    fun `a single-device source puts the aggregate's notices on its host`() {
        val status = SourceSyncStatus(sourceId = "s", state = "error", notices = listOf(failed))
        assertEquals(listOf(failed), attributeNotices(status, listOf("studio")).byDevice["studio"])
    }

    @Test
    fun `an aggregate naming its device picks that host among several`() {
        val status = SourceSyncStatus(sourceId = "s", deviceId = "travel", state = "error", notices = listOf(failed))
        val placed = attributeNotices(status, listOf("studio", "travel"))
        assertEquals(listOf(failed), placed.byDevice["travel"])
        assertEquals(emptyList<SourceNotice>(), placed.unattributed)
    }

    @Test
    fun `an aggregate with no device and several hosts is claimed by none`() {
        val status = SourceSyncStatus(sourceId = "s", state = "error", notices = listOf(failed))
        val placed = attributeNotices(status, listOf("studio", "travel"))
        assertEquals(emptyMap<String, List<SourceNotice>>(), placed.byDevice)
        assertEquals(listOf(failed), placed.unattributed)
    }

    @Test
    fun `an older gateway's error message becomes a notice on the host`() {
        val status = SourceSyncStatus(sourceId = "s", state = "error", errorMessage = "Disk unavailable")
        val notice = attributeNotices(status, listOf("studio")).byDevice["studio"]!!.single()
        assertEquals("Disk unavailable", notice.detail)
        assertEquals(NoticeLevel.ERROR, notice.level)
    }

    @Test
    fun `list rows group notices by device name`() {
        val status = SourceSyncStatus(
            sourceId = "s",
            state = "synced",
            members = listOf(member("studio", info), member("travel-device-0001", issue), member("server")),
        )
        val groups = noticeGroups(status) { mapOf("studio" to "studio-mac")[it] }
        assertEquals(
            listOf(
                NoticeGroup("studio-mac", listOf(info.toNoticeUi())),
                NoticeGroup("travel-devic…", listOf(issue.toNoticeUi())),
            ),
            groups,
        )
        assertEquals(NoticeSeverity.WARNING, worstSeverity(groups.flatMap { it.notices }))
    }

    @Test
    fun `a row names the device count when several devices contribute`() {
        val shared = SourceSyncStatus(sourceId = "s", state = "synced", members = listOf(member("a"), member("b")))
        assertEquals("2 devices", rowDeviceLabel(shared, "studio-mac"))
        val single = SourceSyncStatus(sourceId = "s", state = "synced", members = listOf(member("a")))
        assertEquals("studio-mac", rowDeviceLabel(single, "studio-mac"))
        assertEquals("studio-mac", rowDeviceLabel(SourceSyncStatus(sourceId = "s"), "studio-mac"))
        assertEquals(null, rowDeviceLabel(null, null))
    }

    @Test
    fun `the detail only takes a re-fetched status for its own source`() {
        assertTrue(isStatusFor("s", SourceSyncStatus(sourceId = "s")))
        assertFalse(isStatusFor("s", SourceSyncStatus(sourceId = "other")))
    }

    @Test
    fun `a live rebuild of the list keeps the refresh-failure banner`() {
        val error = IllegalStateException("offline")
        val overview = SourcesOverview(
            sourceCount = 0, totalDocs = null, totalChunks = null, diskSize = null,
            embeddingModel = null, indexLabel = "Indexer off",
        )
        val shown = Loadable.Content(SourcesContent(overview, emptyList(), refreshError = error))
        val rebuilt = rebuiltContent(SourcesContent(overview, emptyList()), shown)
        assertEquals(error, (rebuilt as Loadable.Content).value.refreshError)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SourceNoticesUiTest {
    @get:Rule val compose = createComposeRule()

    private val issue = NoticeUi(
        NoticeSeverity.WARNING,
        "One folder could not be read",
        detail = "Deletion detection is paused for that folder.",
        steps = listOf("Check the folder's permissions."),
    )

    private fun detail() = SourceDetailUi(
        sourceId = "files:local", label = "Files", accountId = "local",
        icon = SourceIconModel(fallbackInitial = "F"), type = "files",
        hostDevices = listOf(
            SourceHostDeviceUi("travel", "travel-laptop", notices = listOf(issue)),
            SourceHostDeviceUi("studio", "studio-mac"),
        ),
        syncState = "synced", lastSyncAt = null, percentIndexed = null,
        progressPercent = null, progressMessage = null,
    )

    private fun show() = compose.setContent {
        OmnesisTheme(darkTheme = false) {
            SourceDetailContent(Loadable.Content(detail()), onBack = {}, onRetry = {}, onOpenRecent = {})
        }
    }

    @Test
    fun `tapping a device's icon opens its notices and no text shows before`() {
        show()
        compose.onNodeWithText("One folder could not be read").assertDoesNotExist()
        compose.onNodeWithContentDescription("1 warning for travel-laptop").performClick()
        compose.onNodeWithText("One folder could not be read").assertExists()
        compose.onNodeWithText("Deletion detection is paused for that folder.").assertExists()
        compose.onNodeWithText("Check the folder's permissions.").assertExists()
    }

    @Test
    fun `the control is one 48dp button that does not make its line taller`() {
        show()
        val button = compose.onNodeWithContentDescription("1 warning for travel-laptop")
        val target = button.getUnclippedBoundsInRoot()
        assertTrue("target ${target.width} x ${target.height}", target.width >= 48.dp && target.height >= 48.dp)
        button
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
            .assert(SemanticsMatcher("labelled Show details") { it.config.getOrNull(SemanticsActions.OnClick)?.label == "Show details" })
        // travel-laptop (with the control) sits above studio-mac (without): the gap
        // between them is one 24dp line, not a 48dp one.
        val first = compose.onNodeWithText("travel-laptop").getUnclippedBoundsInRoot().top
        val second = compose.onNodeWithText("studio-mac").getUnclippedBoundsInRoot().top
        assertTrue("line grew to ${second - first}", second - first < 30.dp)
    }

    @Test
    fun `the control answers a touch outside its glyphs`() {
        show()
        // 4dp inside the 48dp target's top edge: well above the 16dp glyph.
        compose.onNodeWithContentDescription("1 warning for travel-laptop").performTouchInput {
            click(Offset(centerX, 4.dp.toPx()))
        }
        compose.onNodeWithText("One folder could not be read").assertExists()
    }
}
