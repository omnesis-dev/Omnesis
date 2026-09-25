// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import java.time.Instant
import dev.omnesis.android.designsystem.components.DeleteDocumentDialog
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.briefs.BriefsListContent
import dev.omnesis.android.ui.briefs.BriefsFeedState
import dev.omnesis.android.ui.briefs.BriefDetailSheet
import dev.omnesis.android.ui.briefs.BriefDismissSheet
import dev.omnesis.android.transport.dto.BriefRecordDto
import dev.omnesis.android.transport.dto.BriefCitationDto
import dev.omnesis.android.transport.dto.BriefDismissReasonDto
import dev.omnesis.android.transport.dto.BriefReadStateDto
import dev.omnesis.android.transport.dto.BriefKindDto
import dev.omnesis.android.transport.dto.BriefsMenuEntry
import dev.omnesis.android.ui.home.MenuRevealContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.designsystem.components.FileTypeIcon
import dev.omnesis.android.designsystem.components.FileTypePill
import dev.omnesis.android.designsystem.components.ProviderIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.DocumentDetail
import dev.omnesis.android.transport.dto.PeopleStats
import dev.omnesis.android.transport.dto.PersonAlias
import dev.omnesis.android.transport.dto.PersonDetail
import dev.omnesis.android.transport.dto.PersonSummary
import dev.omnesis.android.transport.dto.RecentDocument
import dev.omnesis.android.transport.dto.RecentItemsResponse
import dev.omnesis.android.transport.dto.SearchResultItem
import dev.omnesis.android.ui.people.PeopleContent
import dev.omnesis.android.ui.people.PeopleViewModel
import dev.omnesis.android.ui.people.PersonDetailContent
import dev.omnesis.android.ui.people.PersonDetailViewModel
import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentPlanItem
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.ConversationSummary
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.ui.agent.AgentChatState
import dev.omnesis.android.ui.agent.AgentCitation
import dev.omnesis.android.ui.agent.AgentCitationEntry
import dev.omnesis.android.ui.agent.AgentContent
import dev.omnesis.android.ui.agent.AgentCoordinator
import dev.omnesis.android.ui.agent.AgentPart
import dev.omnesis.android.ui.agent.AgentToolCall
import dev.omnesis.android.ui.agent.AgentTurn
import dev.omnesis.android.ui.agent.CitationsDrawer
import dev.omnesis.android.ui.document.DocumentDetailContent
import dev.omnesis.android.ui.home.MainMenuDrawer
import dev.omnesis.android.ui.models.ModelsContent
import dev.omnesis.android.ui.models.sampleModelsOverview
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import dev.omnesis.android.ui.pairing.PairingContent
import dev.omnesis.android.ui.pairing.PairingViewModel
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.search.SearchContent
import dev.omnesis.android.ui.search.SearchViewModel
import dev.omnesis.android.ui.settings.AboutSection
import dev.omnesis.android.ui.settings.AppearanceMode
import dev.omnesis.android.ui.settings.SettingsContent
import dev.omnesis.android.ui.settings.SettingsViewModel
import dev.omnesis.android.ui.settings.sampleAppVersion
import dev.omnesis.android.ui.sources.SourceDetailContent
import dev.omnesis.android.ui.sources.SourceDetailUi
import dev.omnesis.android.ui.sources.SourceHostDeviceUi
import dev.omnesis.android.ui.sources.SourceRecentContent
import dev.omnesis.android.ui.sources.SourceRowUi
import dev.omnesis.android.ui.sources.SourcesContent
import dev.omnesis.android.ui.sources.SourcesOverview
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

// Fixed "now" for the frozen test clock — past the latest fixture so relative labels are stable.

/**
 * Renders each Phase-1 screen state to a PNG (Robolectric + Roborazzi) so the layout
 * can be reviewed before shipping — the Android analogue of the iOS snapshot loop.
 * All sample data is invented (privacy rule), never sourced from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreensScreenshotTest {

    private val connected = ConnectionState.Connected("d1", "Studio Northstar", listOf("read", "write"))

    private val sampleResults = listOf(
        SearchResultItem(
            documentId = "doc-1", sourceId = "notes:local", documentType = "note",
            title = "Q4 budget review", sourceCreatedAt = "2026-01-02T10:00:00Z",
            author = "Maya Reeves", chunkText = "Projected spend is tracking under plan for the quarter.",
            score = 0.91,
        ),
        SearchResultItem(
            documentId = "doc-2", sourceId = "files:local", documentType = "file",
            title = "Marathon training plan", sourceCreatedAt = "2026-01-05T08:30:00Z",
            author = null, chunkText = "Week 6 adds a tempo run and a long run of 18 km.",
            score = 0.74,
        ),
    )

    private val sampleDoc = DocumentDetail(
        id = "doc-1", providerId = "local:default", sourceId = "notes:local", externalId = "ext-1",
        title = "Q4 budget review",
        content = "Projected spend is tracking under plan for the quarter. Headcount is flat; " +
            "infra costs down 8% after the storage cleanup. Revenue forecast unchanged.",
        contentHash = "sha256:abc", sourceCreatedAt = "2026-01-02T10:00:00Z",
    )

    private fun capture(name: String, dark: Boolean, content: @androidx.compose.runtime.Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    @Test
    fun delete_document_dialog_dark() = capture("delete_document_dialog_dark", dark = true) {
        DeleteDocumentDialog(
            title = "Delete \u201cQ4 budget review\u201d?",
            onDismiss = {},
            onDelete = {},
        )
    }

    @Test
    fun pairing_filled_light() = capture("pairing_filled_light", dark = false) {
        PairingContent(
            state = PairingViewModel.State(
                mode = PairingViewModel.Mode.Manual,
                gatewayUrl = "https://gateway.example.com",
                pairingCode = "AB-CD-EF",
            ),
            onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
            onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
        )
    }

    @Test
    fun pairing_error_dark() = capture("pairing_error_dark", dark = true) {
        PairingContent(
            state = PairingViewModel.State(
                mode = PairingViewModel.Mode.Manual,
                gatewayUrl = "https://gateway.example.com", pairingCode = "WRONG",
                error = "Can't reach the gateway. Make sure it's running and reachable from this device.",
            ),
            onBack = {}, onShowScanner = {}, onShowManual = {}, onQrCode = {},
            onUrlChange = {}, onCodeChange = {}, onFingerprintChange = {}, onToggleAdvanced = {}, onPair = {},
        )
    }

    @Test
    fun search_results_light() = capture("search_results_light", dark = false) {
        SearchContent(
            state = SearchViewModel.State(query = "budget", status = SearchViewModel.Status.Results(sampleResults, 12.5)),
            connection = connected,
            onOpenMenu = {}, onQueryChange = {}, onSearch = {}, onOpenDocument = {},
        )
    }

    @Test
    fun search_idle_dark() = capture("search_idle_dark", dark = true) {
        SearchContent(
            state = SearchViewModel.State(),
            connection = ConnectionState.Connecting,
            onOpenMenu = {}, onQueryChange = {}, onSearch = {}, onOpenDocument = {},
        )
    }

    @Test
    fun document_content_light() = capture("document_content_light", dark = false) {
        DocumentDetailContent(state = Loadable.Content(sampleDoc), onBack = {}, onRetry = {})
    }

    private val sampleConversations = listOf(
        ConversationSummary(sessionId = "s1", title = "Q4 budget recap", messageCount = 4, pinned = true),
        ConversationSummary(sessionId = "s2", title = "Marathon plan check", messageCount = 8, unread = true),
        ConversationSummary(sessionId = "s3", title = "Tenancy agreement questions for the new flat lease review", messageCount = 2),
        ConversationSummary(sessionId = "s4", title = "What is 2 + 2?", messageCount = 1, unread = true),
    )

    /**
     * Enough history to run off the bottom of the menu. The action bar's fade only does
     * anything once rows pass behind it, so the short list above cannot show whether the
     * ramp reaches the bottom edge or stops at the buttons' waistline.
     */
    private val overflowingConversations = sampleConversations + (5..24).map {
        ConversationSummary(sessionId = "s$it", title = "Conversation number $it", messageCount = 3)
    }

    /**
     * The whole composition: the menu underneath, the app moved aside with its corners
     * rounded and its strip still standing on the trailing edge. The drawer-only goldens
     * below cannot show the layering, and a still cannot drag — so the travel is frozen
     * with `progressOverride`, which is also the only way the open state renders at all
     * here (the settle animation does not advance under a Robolectric render).
     */
    @Test
    fun menu_reveal_open_dark() = capture("menu_reveal_open_dark", dark = true) {
        MenuRevealSample(progress = 1f)
    }

    @Test
    fun menu_reveal_open_light() = capture("menu_reveal_open_light", dark = false) {
        MenuRevealSample(progress = 1f)
    }

    /** Part-way through the travel — where the scrim ramp and corner radius are judged. */
    @Test
    fun menu_reveal_mid_drag_dark() = capture("menu_reveal_mid_drag_dark", dark = true) {
        MenuRevealSample(progress = 0.45f)
    }

    @Test
    fun menu_reveal_mid_drag_light() = capture("menu_reveal_mid_drag_light", dark = false) {
        MenuRevealSample(progress = 0.45f)
    }

    /** Closed: the app fills the screen with no corners, no wash, nothing behind it. */
    @Test
    fun menu_reveal_closed_dark() = capture("menu_reveal_closed_dark", dark = true) {
        MenuRevealSample(progress = 0f)
    }

    @androidx.compose.runtime.Composable
    private fun MenuRevealSample(progress: Float) {
        MenuRevealContainer(
            isOpen = progress >= 1f,
            onOpenChange = {},
            progressOverride = progress,
            menu = {
                MainMenuDrawer(
                    currentRoute = "agent",
                    conversations = sampleConversations,
                    conversationsLoading = false,
                    onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
                    onDeleteConversation = {}, onOpenSettings = {},
                )
            },
        ) {
            // A stand-in for a section: the reveal is about the layering, not about which
            // screen happens to be underneath the finger.
            androidx.compose.foundation.layout.Box(
                androidx.compose.ui.Modifier
                    .fillMaxSize()
                    .background(OmTheme.colors.bgPrimary),
            ) {
                Text(
                    "Ask Omnesis about your corpus",
                    style = MaterialTheme.typography.titleMedium,
                    color = OmTheme.colors.textPrimary,
                    modifier = androidx.compose.ui.Modifier
                        .align(androidx.compose.ui.Alignment.Center),
                )
            }
        }
    }

    // --- Briefs ---------------------------------------------------------------

    /**
     * Invented fixtures, per the privacy rule — never seeded from the user's corpus.
     * One loop brief (clears as "Done"), one info brief (clears as "Got it"), one long
     * enough to prove the row truncates rather than growing.
     */
    private val sampleBriefs = listOf(
        BriefRecordDto(
            id = "b1",
            kind = BriefKindDto.LOOP,
            state = BriefReadStateDto.UNREAD,
            title = "Reply to Maya Reeves about the cabin weekend",
            description = "She proposed dates three days ago and asked which weekend works.",
            createdAt = "2026-05-15T11:00:00Z",
            eventAt = "2026-05-18T09:00:00Z",
            body = "The available options are **Saturday morning** and Sunday afternoon.\n\n- Check the weather\n- Confirm transport",
            citations = listOf(
                BriefCitationDto(
                    docId = "doc-brief-1",
                    title = "Cabin weekend planning notes",
                    providerId = "fictional",
                    sourceId = "notes:example",
                ),
            ),
        ),
        BriefRecordDto(
            id = "b2",
            kind = BriefKindDto.INFO,
            state = BriefReadStateDto.READ,
            title = "Design review with David Lin",
            description = "Video call at 3:00 PM. Last time you agreed to bring the updated onboarding flow.",
            createdAt = "2026-05-15T12:30:00Z",
        ),
        BriefRecordDto(
            id = "b3",
            kind = BriefKindDto.LOOP,
            state = BriefReadStateDto.UNREAD,
            title = "Invoice #204 from Stellar Sound is still unpaid and now two weeks past its due date",
            description = "Due last Friday. No matching bank transaction has shown up yet, and the " +
                "vendor has sent one reminder.",
            createdAt = "2026-05-13T09:00:00Z",
        ),
    )

    private val briefsFeed = BriefsFeedState().replacing(sampleBriefs)
    private val briefsNow: Instant = Instant.parse("2026-05-15T13:00:00Z")

    @Test
    fun briefs_populated_dark() = capture("briefs_populated_dark", dark = true) {
        BriefsSample(briefsFeed)
    }

    @Test
    fun briefs_populated_light() = capture("briefs_populated_light", dark = false) {
        BriefsSample(briefsFeed)
    }

    @Test
    fun briefs_needs_background_agent_dark() = capture("briefs_needs_background_agent_dark", dark = true) {
        BriefsSample(briefsFeed, needsBackgroundAgent = true)
    }

    @Test
    fun briefs_needs_background_agent_light() = capture("briefs_needs_background_agent_light", dark = false) {
        BriefsSample(briefsFeed, needsBackgroundAgent = true)
    }

    /** The goal state: briefs exist only when there is something to say. */
    @Test
    fun briefs_empty_dark() = capture("briefs_empty_dark", dark = true) {
        BriefsSample(BriefsFeedState(), paging = CursorPagingState())
    }

    @Test
    fun briefs_empty_light() = capture("briefs_empty_light", dark = false) {
        BriefsSample(BriefsFeedState(), paging = CursorPagingState())
    }

    @Test
    fun briefs_loading_dark() = capture("briefs_loading_dark", dark = true) {
        BriefsSample(BriefsFeedState(), loading = true)
    }

    /**
     * A brief mid-dictation: its row is the recording strip, with the transcript streaming
     * in where the description was. Recording this golden at all also proves the mic's
     * pulse is frozen under inspection mode — an ungated infinite animation does not just
     * animate here, it hangs the capture forever and writes no PNGs.
     */
    @Test
    fun briefs_dictating_dark() = capture("briefs_dictating_dark", dark = true) {
        BriefsSample(briefsFeed, dictatingBriefId = "b1", dictationText = "Tell her the weekend of the")
    }

    /** The first moment, before the recogniser has heard anything. */
    @Test
    fun briefs_dictating_empty_dark() = capture("briefs_dictating_empty_dark", dark = true) {
        BriefsSample(briefsFeed, dictatingBriefId = "b1", dictationText = "")
    }

    @Test
    fun briefs_swipe_actions_light() = capture("briefs_swipe_actions_light", dark = false) {
        BriefsSample(briefsFeed, revealedActionsBriefId = "b1")
    }

    @Test
    fun briefs_swipe_actions_dark() = capture("briefs_swipe_actions_dark", dark = true) {
        BriefsSample(briefsFeed, revealedActionsBriefId = "b1")
    }

    @Test
    fun brief_detail_light() = capture("brief_detail_light", dark = false) {
        BriefDetailSheet(
            brief = sampleBriefs.first(),
            openingThread = false,
            onAsk = {}, onDismiss = { _, _ -> }, onMoreOptions = {}, onDismissRequest = {},
        )
    }

    @Test
    fun brief_detail_dark() = capture("brief_detail_dark", dark = true) {
        BriefDetailSheet(
            brief = sampleBriefs.first(),
            openingThread = false,
            onAsk = {}, onDismiss = { _, _ -> }, onMoreOptions = {}, onDismissRequest = {},
        )
    }

    @Test
    fun brief_dismiss_snooze_light() = capture("brief_dismiss_snooze_light", dark = false) {
        BriefDismissSheet(
            brief = sampleBriefs.first(),
            initialReason = BriefDismissReasonDto.SNOOZED,
            onConfirm = { _, _, _ -> }, onDismissRequest = {},
        )
    }

    @Test
    fun brief_dismiss_snooze_dark() = capture("brief_dismiss_snooze_dark", dark = true) {
        BriefDismissSheet(
            brief = sampleBriefs.first(),
            initialReason = BriefDismissReasonDto.SNOOZED,
            onConfirm = { _, _, _ -> }, onDismissRequest = {},
        )
    }

    @androidx.compose.runtime.Composable
    private fun BriefsSample(
        feed: BriefsFeedState,
        loading: Boolean = false,
        paging: CursorPagingState = CursorPagingState(),
        dictatingBriefId: String? = null,
        dictationText: String = "",
        revealedActionsBriefId: String? = null,
        needsBackgroundAgent: Boolean = false,
    ) {
        androidx.compose.foundation.layout.Box(
            androidx.compose.ui.Modifier
                .fillMaxSize()
                .background(OmTheme.colors.bgPrimary),
        ) {
            BriefsListContent(
                feed = feed,
                loading = loading,
                loadError = null,
                paging = paging,
                onOpen = {}, onQuickClear = {}, onAsk = {}, onMoreOptions = {},
                onRetry = {}, onRefresh = {},
                dictatingBriefId = dictatingBriefId,
                dictationText = dictationText,
                revealedActionsBriefId = revealedActionsBriefId,
                needsBackgroundAgent = needsBackgroundAgent,
                now = briefsNow,
            )
        }
    }

    @Test
    fun main_menu_drawer_agent_dark() = capture("main_menu_drawer_agent_dark", dark = true) {
        MainMenuDrawer(
            currentRoute = "agent",
            conversations = sampleConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
        )
    }

    /** The menu with Briefs offered by an experimental gateway, including its unread badge. */
    @Test
    fun main_menu_drawer_briefs_dark() = capture("main_menu_drawer_briefs_dark", dark = true) {
        MainMenuDrawer(
            currentRoute = "briefs",
            conversations = sampleConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
            briefsMenuEntry = BriefsMenuEntry.AVAILABLE,
            briefsUnreadCount = 3,
        )
    }

    @Test
    fun main_menu_drawer_briefs_warning_dark() = capture("main_menu_drawer_briefs_warning_dark", dark = true) {
        MainMenuDrawer(
            currentRoute = "briefs",
            conversations = sampleConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
            briefsMenuEntry = BriefsMenuEntry.NEEDS_ATTENTION,
            briefsUnreadCount = 3,
        )
    }

    @Test
    fun main_menu_drawer_briefs_warning_light() = capture("main_menu_drawer_briefs_warning_light", dark = false) {
        MainMenuDrawer(
            currentRoute = "briefs",
            conversations = sampleConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
            briefsMenuEntry = BriefsMenuEntry.NEEDS_ATTENTION,
            briefsUnreadCount = 3,
        )
    }

    @Test
    fun main_menu_drawer_sources_dark() = capture("main_menu_drawer_sources_dark", dark = true) {
        MainMenuDrawer(
            currentRoute = "sources",
            conversations = sampleConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
        )
    }

    @Test
    fun main_menu_drawer_empty_dark() = capture("main_menu_drawer_empty_dark", dark = true) {
        MainMenuDrawer(
            currentRoute = "agent",
            conversations = emptyList(),
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
        )
    }

    @Test
    fun main_menu_drawer_agent_light() = capture("main_menu_drawer_agent_light", dark = false) {
        MainMenuDrawer(
            currentRoute = "agent",
            conversations = sampleConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
        )
    }

    /**
     * Decisions waiting: Privacy carries a count pill, the way Briefs carries its unread
     * count. This is the state that makes the row worth glancing at.
     */
    @Test
    fun main_menu_drawer_privacy_pending_light() =
        capture("main_menu_drawer_privacy_pending_light", dark = false) {
            MainMenuDrawer(
                currentRoute = "agent",
                conversations = sampleConversations,
                conversationsLoading = false,
                onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
                onDeleteConversation = {}, onOpenSettings = {},
                privacyPendingCount = 2,
            )
        }

    @Test
    fun main_menu_drawer_privacy_pending_dark() =
        capture("main_menu_drawer_privacy_pending_dark", dark = true) {
            MainMenuDrawer(
                currentRoute = "privacy",
                conversations = sampleConversations,
                conversationsLoading = false,
                onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
                onDeleteConversation = {}, onOpenSettings = {},
                privacyPendingCount = 12,
            )
        }

    // Experimental mode on: the gated rows appear in the continuous menu.
    @Test
    fun main_menu_drawer_experimental_dark() = capture("main_menu_drawer_experimental_dark", dark = true) {
        MainMenuDrawer(
            currentRoute = "agent",
            conversations = sampleConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
            experimental = true,
        )
    }

    // The list running off the bottom: the only state in which the action bar's fade is
    // visible at all.
    @Test
    fun main_menu_drawer_overflowing_dark() = capture("main_menu_drawer_overflowing_dark", dark = true) {
        MainMenuDrawer(
            currentRoute = "agent",
            conversations = overflowingConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
        )
    }

    @Test
    fun main_menu_drawer_overflowing_light() = capture("main_menu_drawer_overflowing_light", dark = false) {
        MainMenuDrawer(
            currentRoute = "agent",
            conversations = overflowingConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
        )
    }

    @Test
    fun main_menu_drawer_queue_warning_light() = capture("main_menu_drawer_queue_warning_light", dark = false) {
        MainMenuDrawer(
            currentRoute = "agent",
            conversations = sampleConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
            queuedNotesNeedAttention = true,
            experimental = true,
        )
    }

    @Test
    fun main_menu_drawer_queue_warning_dark() = capture("main_menu_drawer_queue_warning_dark", dark = true) {
        MainMenuDrawer(
            currentRoute = "agent",
            conversations = sampleConversations,
            conversationsLoading = false,
            onNewConversation = {}, onNavigate = {}, onResumeConversation = {},
            onDeleteConversation = {}, onOpenSettings = {},
            queuedNotesNeedAttention = true,
            experimental = true,
        )
    }

    @Test
    fun sources_content_light() = capture("sources_content_light", dark = false) {
        SourcesContent(
            state = Loadable.Content(sampleSources()),
            connection = connected,
            onOpenMenu = {}, onRetry = {}, onOpenSource = {},
        )
    }

    @Test
    fun sources_content_dark() = capture("sources_content_dark", dark = true) {
        SourcesContent(
            state = Loadable.Content(sampleSources()),
            connection = connected,
            onOpenMenu = {}, onRetry = {}, onOpenSource = {},
        )
    }

    @Test
    fun source_detail_light() = capture("source_detail_light", dark = false) {
        SourceDetailContent(state = Loadable.Content(sampleDetail()), onBack = {}, onRetry = {}, onOpenRecent = {})
    }

    @Test
    fun source_recent_light() = capture("source_recent_light", dark = false) {
        SourceRecentContent(title = "Notes", state = Loadable.Content(sampleRecent()), onBack = {}, onRetry = {}, onOpenDocument = {})
    }

    private fun sampleSources() = SourcesContent(
        overview = SourcesOverview(
            sourceCount = 3, totalDocs = 1280, totalChunks = 5840, diskSize = "42.1 MB",
            embeddingModel = "nomic-embed-text-v1.5", indexLabel = "Up to date",
        ),
        sources = listOf(
            SourceRowUi(
                "gmail:maya@example.com", "Gmail", "maya@example.com", SourceIconModel(fallbackInitial = "G"),
                "842 emails", "synced", 100.0, "studio-northstar", "Re: Q4 budget review", null, null,
            ),
            SourceRowUi(
                "files:local", "Files", "local", SourceIconModel(fallbackInitial = "F"),
                "318 files", "syncing", 64.0, "studio-northstar", null, 64.0, "Indexing page 7…",
            ),
            SourceRowUi(
                "notes:local", "Notes", "local", SourceIconModel(fallbackInitial = "N"),
                "120 notes", "synced", 100.0, "studio-northstar", "Marathon training plan", null, null,
            ),
        ),
    )

    private fun sampleDetail() = SourceDetailUi(
        sourceId = "gmail:maya@example.com", label = "Gmail", accountId = "maya@example.com",
        icon = SourceIconModel(fallbackInitial = "G"), type = "gmail",
        hostDevices = listOf(SourceHostDeviceUi("dev-host-0001", "studio-northstar")),
        syncState = "synced", lastSyncAt = "2026-01-06T09:00:00Z",
        percentIndexed = 100.0, progressPercent = null, progressMessage = null,
    )

    private fun sampleRecent() = RecentItemsResponse.Documents(
        listOf(
            RecentDocument(id = "d1", sourceId = "notes:local", title = "Q4 budget review", documentType = "note", contentPreview = "Projected spend is tracking under plan.", sourceCreatedAt = "2026-01-02T10:00:00Z"),
            RecentDocument(id = "d2", sourceId = "notes:local", title = "Marathon training plan", documentType = "note", contentPreview = "Week 6 adds a tempo run.", sourceCreatedAt = "2026-01-05T08:30:00Z"),
        ),
    )

    @Test
    fun people_content_light() = capture("people_content_light", dark = false) {
        PeopleContent(
            state = PeopleViewModel.State(
                people = Loadable.Content(samplePeople()),
                stats = PeopleStats(pendingMergeCandidates = 133, mergeRules = 415),
            ),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> },
        )
    }

    @Test
    fun people_content_dark() = capture("people_content_dark", dark = true) {
        PeopleContent(
            state = PeopleViewModel.State(
                people = Loadable.Content(samplePeople()),
                stats = PeopleStats(pendingMergeCandidates = 133, mergeRules = 415),
            ),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> },
        )
    }

    @Test
    fun person_detail_light() = capture("person_detail_light", dark = false) {
        PersonDetailContent(state = Loadable.Content(samplePersonDetail()), onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {})
    }

    // --- Agent (Phase 4) ---

    private val agentCatalog = SourceCatalog()

    private fun agentRef() = AgentDocRef(documentId = "d1", sourceId = "notes:local", title = "Q4 budget review")

    private fun agentState(busy: Boolean = false, plan: Boolean = false): AgentCoordinator.UiState {
        val ref = agentRef()
        val turns = listOf(
            AgentTurn.User("u1", "What did we decide about the Q4 budget?"),
            AgentTurn.Assistant(
                id = "a1",
                parts = listOf(
                    AgentPart.Thinking("Searching the corpus for budget notes…"),
                    AgentPart.Tool(
                        AgentToolCall(
                            toolCallId = "t1", tool = "search_documents", argsSummary = "Q4 budget", argsKnown = true,
                            result = AgentToolResult.SearchResults(query = "Q4 budget", results = listOf(ref)),
                            tailDismissed = true,
                        ),
                    ),
                    AgentPart.Text("You agreed to hold spend **flat** and revisit headcount in January. Key points:\n\n- Infra costs down 8%\n- Revenue forecast unchanged\n\nThe source note is below:"),
                    AgentPart.Tool(
                        AgentToolCall(
                            toolCallId = "t2", tool = "fetch_document", argsSummary = "d1", argsKnown = true,
                            result = AgentToolResult.DocumentResult(ref = ref),
                        ),
                    ),
                ),
                citationCount = 1,
            ),
        )
        return AgentCoordinator.UiState(
            chat = AgentChatState(
                turns = turns, busy = busy,
                planItems = if (plan) listOf(
                    AgentPlanItem("p1", "Search budget notes", "done"),
                    AgentPlanItem("p2", "Summarise the decision", "in_progress"),
                    AgentPlanItem("p3", "Cite the source", "pending"),
                ) else emptyList(),
            ),
            sessionId = "s1", title = "Q4 budget review", model = "claude (haiku)", hasClient = true,
        )
    }

    @Test
    fun agent_transcript_light() = capture("agent_transcript_light", dark = false) {
        AgentContent(
            state = agentState(), catalog = agentCatalog,
            onOpenMenu = {}, onSend = { _, _ -> }, onStop = {}, onRetry = {}, onNewConversation = {},
            onFlushEphemeral = {}, onOpenDocument = {},
        )
    }

    @Test
    fun agent_transcript_busy_plan_dark() = capture("agent_transcript_busy_plan_dark", dark = true) {
        AgentContent(
            state = agentState(busy = true, plan = true), catalog = agentCatalog,
            onOpenMenu = {}, onSend = { _, _ -> }, onStop = {}, onRetry = {}, onNewConversation = {},
            onFlushEphemeral = {}, onOpenDocument = {},
        )
    }

    @Test
    fun agent_empty_light() = capture("agent_empty_light", dark = false) {
        AgentContent(
            state = AgentCoordinator.UiState(hasClient = true), catalog = agentCatalog,
            onOpenMenu = {}, onSend = { _, _ -> }, onStop = {}, onRetry = {}, onNewConversation = {},
            onFlushEphemeral = {}, onOpenDocument = {},
        )
    }

    @Test
    fun agent_citations_sheet_light() = capture("agent_citations_sheet_light", dark = false) {
        CitationsDrawer(
            open = true,
            citations = listOf(
                AgentCitation(
                    documentId = "d1", ref = agentRef(),
                    entries = listOf(
                        AgentCitationEntry("t1", "a1", quote = "hold spend flat through Q4", note = "the core decision", quoteAuthor = "Maya Reeves", quoteIsSelf = false),
                    ),
                ),
                AgentCitation(documentId = "d2", ref = AgentDocRef(documentId = "d2", sourceId = "files:local", title = "Infra cost breakdown"), docNote = "8% reduction after storage cleanup"),
            ),
            catalog = agentCatalog,
            onClose = {}, onOpenDocument = {},
            progressOverride = 1f,
        )
    }

    // --- Models (Phase 5) ---

    @Test
    fun models_light() = capture("models_light", dark = false) {
        ModelsContent(Loadable.Content(sampleModelsOverview()), connected, onBack = {}, onRetry = {})
    }

    @Test
    fun models_background_agent_picker_light() = capture("models_background_agent_picker_light", dark = false) {
        ModelsContent(
            state = Loadable.Content(sampleModelsOverview()),
            connection = connected,
            pickerRole = "background-agent",
            onBack = {},
            onRetry = {},
        )
    }

    @Test
    fun models_background_agent_picker_dark() = capture("models_background_agent_picker_dark", dark = true) {
        ModelsContent(
            state = Loadable.Content(sampleModelsOverview()),
            connection = connected,
            pickerRole = "background-agent",
            onBack = {},
            onRetry = {},
        )
    }

    @Test
    fun settings_light() = capture("settings_light", dark = false) {
        SettingsContent(
            gateway = SettingsViewModel.GatewayInfo("Studio Northstar", "https://gateway.example.com", "dev-abc123", listOf("read", "admin")),
            connection = connected,
            mode = AppearanceMode.SYSTEM,
            appVersion = sampleAppVersion(),
            onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {},
        )
    }

    // The About section sits at the foot of a screen far taller than the
    // captured viewport, so it gets its own render rather than never being
    // looked at.
    // A Column, because that is what the section sits in on the real screen:
    // captureRoboImage stacks a bare pair of siblings and the card would cover
    // its own heading.
    @Test
    fun settings_about_light() = capture("settings_about_light", dark = false) {
        Column(
            Modifier
                .background(OmTheme.colors.bgPrimary)
                .padding(OmSpacing.lg),
        ) { AboutSection(sampleAppVersion()) }
    }

    @Test
    fun settings_about_dark() = capture("settings_about_dark", dark = true) {
        Column(
            Modifier
                .background(OmTheme.colors.bgPrimary)
                .padding(OmSpacing.lg),
        ) { AboutSection(sampleAppVersion()) }
    }

    @Test
    fun settings_dark() = capture("settings_dark", dark = true) {
        SettingsContent(
            gateway = SettingsViewModel.GatewayInfo("Studio Northstar", "https://gateway.tailnet.ts.net:7600", "dev-abc123", listOf("read", "admin")),
            connection = ConnectionState.Failed("timeout"),
            mode = AppearanceMode.DARK,
            appVersion = sampleAppVersion(),
            onClose = {}, onSetAppearance = {}, onSaveUrl = { null }, onUnpair = {},
        )
    }

    private fun samplePeople() = listOf(
        PersonSummary(id = "self", canonicalName = "You", isSelf = true, aliasCount = 3, documentCount = 0, lastSeen = "2026-01-08T12:00:00Z"),
        PersonSummary(id = "p1", canonicalName = "Maya Reeves", aliasCount = 2, documentCount = 142, lastSeen = "2026-01-07T09:00:00Z", interactionScoreRecent = 0.82),
        PersonSummary(id = "p2", canonicalName = "Jamie Lopez", aliasCount = 1, documentCount = 38, lastSeen = "2026-01-02T18:30:00Z", interactionScoreRecent = 0.41),
        PersonSummary(id = "p3", canonicalName = "David Lin", aliasCount = 4, documentCount = 12, lastSeen = "2025-12-20T08:00:00Z", interactionScoreRecent = 0.15),
    )

    // --- Design atoms: provider icons, file-type pills, gateway error view ---

    @Test
    fun provider_icons_dark() = capture("provider_icons_dark", dark = true) { ProviderIconGallery() }

    @Test
    fun provider_icons_light() = capture("provider_icons_light", dark = false) { ProviderIconGallery() }

    @Test
    fun file_type_pills_dark() = capture("file_type_pills_dark", dark = true) { FileTypeGallery() }

    @Test
    fun file_type_pills_light() = capture("file_type_pills_light", dark = false) { FileTypeGallery() }

    @Test
    fun gateway_error_unreachable_dark() = capture("gateway_error_unreachable_dark", dark = true) {
        dev.omnesis.android.ui.common.GatewayErrorView(
            context = "load triggers",
            error = dev.omnesis.android.transport.GatewayException.Network(Exception("offline")),
            onRetry = {}, onOpenSettings = {},
        )
    }

    @Test
    fun gateway_error_certificate_dark() = capture("gateway_error_certificate_dark", dark = true) {
        dev.omnesis.android.ui.common.GatewayErrorView(
            context = "start the agent",
            error = dev.omnesis.android.transport.GatewayException.Network(java.security.cert.CertificateException("mismatch")),
            onRetry = {}, onOpenSettings = {},
        )
    }

    @Test
    fun gateway_error_certificate_light() = capture("gateway_error_certificate_light", dark = false) {
        dev.omnesis.android.ui.common.GatewayErrorView(
            context = "start the agent",
            error = dev.omnesis.android.transport.GatewayException.Network(java.security.cert.CertificateException("mismatch")),
            onRetry = {}, onOpenSettings = {},
        )
    }

    @Test
    fun gateway_error_unauthorized_light() = capture("gateway_error_unauthorized_light", dark = false) {
        dev.omnesis.android.ui.common.GatewayErrorView(
            context = "load people",
            error = dev.omnesis.android.transport.GatewayException.Unauthorized(),
            onRetry = {}, onOpenSettings = {},
        )
    }

    @Test
    fun gateway_error_no_model_dark() = capture("gateway_error_no_model_dark", dark = true) {
        dev.omnesis.android.ui.common.GatewayErrorView(
            context = "start the agent",
            error = dev.omnesis.android.transport.GatewayException.ServerError(
                503,
                "Agent disabled. Set inference.assignments.agent in omnesis.json (e.g. \"anthropic/claude-sonnet-4-6\") to enable it.",
            ),
            onRetry = {}, onOpenSettings = {}, onOpenModels = {},
        )
    }

    @Test
    fun gateway_error_agent_dark() = capture("gateway_error_agent_dark", dark = true) {
        dev.omnesis.android.ui.common.GatewayErrorView(
            context = "start the agent",
            error = dev.omnesis.android.transport.GatewayException.ServerError(
                503, "Agent harness disabled. Set agent.backend to \"anthropic\" in omnesis.json.",
            ),
            onRetry = {}, onOpenSettings = {}, onOpenModels = {},
        )
    }

    @Test
    fun gateway_error_server_dark() = capture("gateway_error_server_dark", dark = true) {
        dev.omnesis.android.ui.common.GatewayErrorView(
            context = "load triggers",
            error = dev.omnesis.android.transport.GatewayException.ServerError(
                500, "Service temporarily unavailable. Try again in a few seconds.",
            ),
            onRetry = {}, onOpenSettings = {},
        )
    }

    @androidx.compose.runtime.Composable
    private fun ProviderIconGallery() {
        val c = OmTheme.colors
        Column(
            modifier = Modifier.background(c.bgPrimary).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            listOf("anthropic", "openai", "codex", "google", "mistral", "groq", "cerebras", "together", "fireworks", "deepseek", "nvidia", "xai", "meta", "moonshot", "openrouter", "ollama", "local", "none").forEach { id ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ProviderIcon(providerId = id, size = 18.dp)
                    Text(id, color = c.textPrimary)
                }
            }
        }
    }

    @androidx.compose.runtime.Composable
    private fun FileTypeGallery() {
        val c = OmTheme.colors
        val samples = listOf(
            "application/pdf" to "report.pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to "notes.docx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to "budget.xlsx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation" to "deck.pptx",
            "image/png" to "screenshot.png",
            "application/zip" to "archive.zip",
            "text/calendar" to "invite.ics",
            "message/rfc822" to "thread.eml",
            "application/json" to "config.json",
            "audio/mpeg" to "song.mp3",
            "video/mp4" to "clip.mp4",
            "text/plain" to "note.txt",
            null to "unknown.xyz",
        )
        Column(
            modifier = Modifier.background(c.bgPrimary).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            samples.forEach { (mime, name) ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    FileTypeIcon(mimeType = mime, filename = name, size = 18.dp)
                    Text(name ?: "—", color = c.textPrimary)
                    FileTypePill(mimeType = mime, filename = name)
                }
            }
        }
    }

    private fun samplePersonDetail() = PersonDetailViewModel.Content(
        person = PersonDetail(
            id = "p1", canonicalName = "Maya Reeves", isSelf = false,
            firstSeen = "2025-03-01T10:00:00Z", lastSeen = "2026-01-07T09:00:00Z",
            aliases = listOf(
                PersonAlias(id = "a1", aliasType = "email", alias = "maya@example.com"),
                PersonAlias(id = "a2", aliasType = "phone", alias = "+1 (555) 010-0142"),
            ),
            inboundCount = 84, outboundCount = 57, interactionScore = 0.612, interactionScoreRecent = 0.820,
        ),
        docs = listOf(
            PersonDetailViewModel.DocRow("d1", "Q4 budget review", "Gmail", SourceIconModel(fallbackInitial = "G"), listOf("sender")),
            PersonDetailViewModel.DocRow("d2", "Re: vendor evaluation", "Gmail", SourceIconModel(fallbackInitial = "G"), listOf("recipient", "mentioned")),
        ),
        documentsPaging = dev.omnesis.android.ui.common.CursorPagingState(nextCursor = "30"),
    )
}
