// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Loop
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentConversationTerminalFailure
import dev.omnesis.android.transport.dto.AgentDocLoopRef
import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentLoopDetail
import dev.omnesis.android.transport.dto.AgentLoopLedgerEntry
import dev.omnesis.android.transport.dto.AgentLoopSummary
import dev.omnesis.android.transport.dto.AgentPersonSummary
import dev.omnesis.android.transport.dto.AgentPlanItem
import dev.omnesis.android.transport.dto.AgentSqlSource
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.AgentTrailEvent
import dev.omnesis.android.transport.dto.AgentTrailEventDoc
import dev.omnesis.android.transport.dto.AgentTrailEventPerson
import dev.omnesis.android.transport.dto.AgentTrailEventRelated
import dev.omnesis.android.transport.dto.AgentTrailRecord
import dev.omnesis.android.transport.dto.AgentTrailRecordKeyField
import dev.omnesis.android.transport.dto.AgentUsage
import dev.omnesis.android.transport.dto.BriefOriginSnapshot
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.ConversationSummary
import dev.omnesis.android.transport.dto.DeepResearchPlanItem
import dev.omnesis.android.transport.dto.DeepResearchVerification
import dev.omnesis.android.transport.dto.WatchFiringOriginSnapshot
import dev.omnesis.android.ui.agent.AgentBatchEphemeralCards
import dev.omnesis.android.ui.agent.AgentChatState
import dev.omnesis.android.ui.agent.AgentChildTurn
import dev.omnesis.android.ui.agent.AgentCitation
import dev.omnesis.android.ui.agent.AgentCitationEntry
import dev.omnesis.android.ui.agent.AgentComposer
import dev.omnesis.android.ui.agent.AgentContent
import dev.omnesis.android.ui.agent.AgentCoordinator
import dev.omnesis.android.ui.agent.AgentDocAnnotations
import dev.omnesis.android.ui.agent.AgentEphemeralDocumentCard
import dev.omnesis.android.ui.agent.AgentEphemeralActionCard
import dev.omnesis.android.ui.agent.AgentEphemeralLoopCard
import dev.omnesis.android.ui.agent.AgentEphemeralLoopsSearchCard
import dev.omnesis.android.ui.agent.AgentEphemeralPeopleCard
import dev.omnesis.android.ui.agent.AgentEphemeralSearchCard
import dev.omnesis.android.ui.agent.AgentEphemeralSqlCard
import dev.omnesis.android.ui.agent.AgentEphemeralTemporalCard
import dev.omnesis.android.ui.agent.AgentEphemeralTrailCard
import dev.omnesis.android.ui.agent.AgentEphemeralUrlLookupCard
import dev.omnesis.android.ui.agent.AgentEventTrailSummary
import dev.omnesis.android.ui.agent.AgentPart
import dev.omnesis.android.ui.agent.AgentPlanPanel
import dev.omnesis.android.ui.agent.AgentQuoteEntry
import dev.omnesis.android.ui.agent.AgentReportArtifact
import dev.omnesis.android.ui.agent.AgentResearchDoc
import dev.omnesis.android.ui.agent.AgentResearchPanel
import dev.omnesis.android.ui.agent.AgentSubAgentCard
import dev.omnesis.android.ui.agent.AgentSubagentCard
import dev.omnesis.android.ui.agent.AgentToolCall
import dev.omnesis.android.ui.agent.AgentToolChild
import dev.omnesis.android.ui.agent.AgentToolResultErrorView
import dev.omnesis.android.ui.agent.AgentTrailAnnotations
import dev.omnesis.android.ui.agent.AgentTurn
import dev.omnesis.android.ui.agent.AgentTurnFailure
import dev.omnesis.android.ui.agent.AgentUnknownPartNotice
import dev.omnesis.android.ui.agent.AgentWatchCard
import dev.omnesis.android.ui.agent.AssistantTurn
import dev.omnesis.android.ui.agent.CitationsDrawer
import dev.omnesis.android.ui.agent.ReportArtifact
import dev.omnesis.android.ui.agent.ResearchWorkspace
import dev.omnesis.android.ui.agent.SlashCommand
import dev.omnesis.android.ui.agent.TrailTimeline
import dev.omnesis.android.ui.agent.UserBubble
import dev.omnesis.android.ui.common.CursorPagingState
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Pixel-parity screenshots for the Agent chat surface — transcript shell, user/assistant
 * bubbles, composer (idle/listening/busy), and the pinned plan panel — matching the iOS
 * reference fixtures (71/84/70/72/93/90/94/95). Renders each meaningful state to a PNG via
 * Robolectric + Roborazzi for review against iOS before shipping. All fixture data is
 * invented (privacy rule), never sourced from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug --tests "*AgentParityScreenshotTest"
 *     ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentParityScreenshotTest {

    private val catalog = SourceCatalog()

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            // Render as if in a preview so inspection-gated infinite animations (e.g. the
            // citing-pill pulse) freeze — an unbounded animation never idles and hangs the
            // native capture otherwise.
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private fun richTurns(): List<AgentTurn> {
        val ref = AgentDocRef(documentId = "d1", sourceId = "notes:local", title = "Birthday gift ideas")
        return listOf(
            AgentTurn.User("u1", "Help me figure out a birthday gift for Maya — she's turning 30 next week."),
            AgentTurn.Assistant(
                id = "a1",
                parts = listOf(
                    AgentPart.Text("Let me pull up your message history and recent purchases for both of you."),
                    AgentPart.Tool(
                        AgentToolCall(
                            toolCallId = "t1", tool = "run_sql", argsSummary = "SELECT * FROM purchases", argsKnown = true,
                            result = null,
                        ),
                    ),
                ),
            ),
        )
    }

    private fun richState() = AgentCoordinator.UiState(
        chat = AgentChatState(turns = richTurns(), busy = true),
        sessionId = "s1",
        title = "Birthday gift",
        model = "claude (haiku)",
        hasClient = true,
        conversations = listOf(
            ConversationSummary(sessionId = "s1", title = "Birthday gift"),
        ),
    )

    private fun stopErrorState() = richState().copy(
        chat = richState().chat.copy(
            lastTurnError =
                "Stop failed: Can't reach the gateway. Make sure it's running and " +
                    "reachable from this device.",
        ),
    )

    private fun agentContent(
        state: AgentCoordinator.UiState,
    ): @Composable () -> Unit = {
        AgentContent(
            state = state,
            catalog = catalog,
            onOpenMenu = {}, onSend = { _, _ -> }, onStop = {}, onRetry = {}, onNewConversation = {},
            onFlushEphemeral = {}, onOpenDocument = {}, onOpenWatch = {},
        )
    }

    // --- Full-shell states ---

    @Test
    // The landing: no session yet, because one is minted lazily on the first send. The
    // new-conversation button is absent — this already is one.
    fun agent_empty_dark() = capture("agent_parity_empty_dark", dark = true) {
        agentContent(AgentCoordinator.UiState(hasClient = true))()
    }

    // First-send transition while POST /agent/sessions is still in flight: no session identity
    // exists yet, but the optimistic user bubble and busy wait indicator already own the transcript.
    private fun firstSendMintingState() = AgentCoordinator.UiState(
        chat = AgentChatState(
            turns = listOf(
                AgentTurn.User(
                    "u-pending-example",
                    "What decisions came out of the quarterly planning review?",
                ),
            ),
            busy = true,
        ),
        title = "What decisions came out of the quarterly planning review?",
        hasClient = true,
    )

    @Test
    fun agent_first_send_minting_dark() = capture("agent_parity_first_send_minting_dark", dark = true) {
        agentContent(firstSendMintingState())()
    }

    @Test
    fun agent_first_send_minting_light() = capture("agent_parity_first_send_minting_light", dark = false) {
        agentContent(firstSendMintingState())()
    }

    // --- Anchored threads ---
    // Nothing has been said in either of these yet, so the card is the whole screen: the
    // gateway hid the folded run transcript that seeded the thread, leaving no visible turns.

    private fun briefOriginState() = AgentCoordinator.UiState(
        sessionId = "s_brief",
        hasClient = true,
        conversationOrigin = ConversationOrigin(
            kind = "brief",
            brief = BriefOriginSnapshot(
                title = "Two invoices quote the same reference",
                description = "Studio Northstar billed reference **NS-8841** twice, nine days apart.",
                body = "The first landed on 12 March for GBP 1,240 and the second on 21 March " +
                    "for the same amount. Neither mentions the other.",
            ),
            seedMessageCount = 2,
        ),
    )

    private fun watchFiringOriginState() = AgentCoordinator.UiState(
        sessionId = "s_watch",
        hasClient = true,
        conversationOrigin = ConversationOrigin(
            kind = "watch_firing",
            watchId = "watch_example",
            watch = WatchFiringOriginSnapshot(
                name = "a deposit clears",
                condition = "a supplier changes their bank details partway through a thread",
                firedAt = 1_767_225_600_000,
            ),
            seedMessageCount = 1,
        ),
    )

    @Test
    fun agent_brief_origin_dark() = capture("agent_parity_brief_origin_dark", dark = true) {
        agentContent(briefOriginState())()
    }

    @Test
    fun agent_brief_origin_light() = capture("agent_parity_brief_origin_light", dark = false) {
        agentContent(briefOriginState())()
    }

    @Test
    fun agent_watch_firing_origin_dark() = capture("agent_parity_watch_firing_origin_dark", dark = true) {
        agentContent(watchFiringOriginState())()
    }

    @Test
    fun agent_watch_firing_origin_light() = capture("agent_parity_watch_firing_origin_light", dark = false) {
        agentContent(watchFiringOriginState())()
    }

    @Test
    fun agent_transcript_busy_dark() = capture("agent_parity_transcript_busy_dark", dark = true) {
        agentContent(richState())()
    }

    private fun pagedTranscriptState() = richState().copy(
        chat = richState().chat.copy(busy = false),
        transcriptPaging = CursorPagingState(nextCursor = "older-page"),
    )

    @Test
    fun agent_transcript_paging_dark() = capture("agent_parity_transcript_paging_dark", dark = true) {
        agentContent(pagedTranscriptState())()
    }

    @Test
    fun agent_transcript_paging_light() = capture("agent_parity_transcript_paging_light", dark = false) {
        agentContent(pagedTranscriptState())()
    }

    // Resumed conversation whose transcript is still loading: the surface switched to the target
    // immediately (title adopted) and shows the breathing skeleton until the messages land.
    private fun loadingState() = AgentCoordinator.UiState(
        sessionId = "s1",
        title = "Trip planning",
        transcriptLoading = true,
        hasClient = true,
    )

    @Test
    fun agent_transcript_loading_dark() = capture("agent_parity_transcript_loading_dark", dark = true) {
        agentContent(loadingState())()
    }

    @Test
    fun agent_transcript_loading_light() = capture("agent_parity_transcript_loading_light", dark = false) {
        agentContent(loadingState())()
    }

    // Live thinking: an in-flight turn whose trailing part is a thinking block
    // (no stopReason). Renders the animated "Thinking" indicator. Mirrors the
    // iOS PNG 79-agent-thinking-live.
    private fun thinkingState(stopReason: String?, parts: List<AgentPart>) = AgentCoordinator.UiState(
        chat = AgentChatState(
            turns = listOf(
                AgentTurn.User("u1", "Who handled the Q4 audit?"),
                AgentTurn.Assistant(id = "a1", parts = parts, stopReason = stopReason),
            ),
            busy = stopReason == null,
        ),
        sessionId = "s1",
        title = "Q4 audit",
        model = "deepseek",
        hasClient = true,
    )

    private fun thinkingLiveParts() = listOf(
        AgentPart.Thinking(
            "The user wants the Q4 audit vendor. Let me search the engagement letter, then cross-check the invoice dates.",
        ),
    )

    private fun thinkingDoneParts() = listOf(
        AgentPart.Thinking("Let me search the engagement letter first."),
        AgentPart.Text("The Q4 audit was handled by **Studio Northstar**."),
    )

    @Test
    fun agent_thinking_live_dark() = capture("agent_parity_thinking_live_dark", dark = true) {
        agentContent(thinkingState(stopReason = null, parts = thinkingLiveParts()))()
    }

    @Test
    fun agent_thinking_live_light() = capture("agent_parity_thinking_live_light", dark = false) {
        agentContent(thinkingState(stopReason = null, parts = thinkingLiveParts()))()
    }

    // Completed turn that reasoned first: the thinking block is no longer live
    // and has collapsed to nothing, so only the answer remains.
    @Test
    fun agent_thinking_done_dark() = capture("agent_parity_thinking_done_dark", dark = true) {
        agentContent(thinkingState(stopReason = "end_turn", parts = thinkingDoneParts()))()
    }

    // Mid-citation: an assistant turn whose trailing part is a pending `annotate` call,
    // surfacing the inline "Citing N documents" pill (run of 3). Mirrors iOS PNG mid-cite.
    @Test
    fun agent_transcript_mid_citation_dark() = capture("agent_parity_mid_citation_dark", dark = true) {
        val turns = listOf(
            AgentTurn.User("u1", "Summarize the Q4 budget decision and cite the source."),
            AgentTurn.Assistant(
                id = "a1",
                parts = listOf(
                    AgentPart.Text("You agreed to hold spend flat and revisit headcount in **January**."),
                    AgentPart.Tool(AgentToolCall(toolCallId = "an1", tool = "annotate", argsKnown = true, result = null)),
                    AgentPart.Tool(AgentToolCall(toolCallId = "an2", tool = "annotate", argsKnown = true, result = null)),
                    AgentPart.Tool(AgentToolCall(toolCallId = "an3", tool = "annotate", argsKnown = true, result = null)),
                ),
            ),
        )
        agentContent(
            AgentCoordinator.UiState(
                chat = AgentChatState(turns = turns, busy = true),
                sessionId = "s1", hasClient = true,
            ),
        )()
    }

    // Fatal-error state: the gateway error view pinned above the composer (PNG agent-fatal).
    @Test
    fun agent_fatal_error_dark() = capture("agent_parity_fatal_error_dark", dark = true) {
        agentContent(
            AgentCoordinator.UiState(
                sessionId = "s1",
                hasClient = true,
                fatalError = dev.omnesis.android.transport.GatewayException.Network(Exception("offline")),
            ),
        )()
    }

    @Test
    fun agent_stop_error_dark() = capture("agent_parity_stop_error_dark", dark = true) {
        agentContent(stopErrorState())()
    }

    @Test
    fun agent_stop_error_light() = capture("agent_parity_stop_error_light", dark = false) {
        agentContent(stopErrorState())()
    }

    @Test
    fun agent_context_window_reached_dark() =
        capture("agent_parity_context_window_reached_dark", dark = true) {
            agentContent(contextWindowExceededState())()
        }

    @Test
    fun agent_context_window_reached_light() =
        capture("agent_parity_context_window_reached_light", dark = false) {
            agentContent(contextWindowExceededState())()
        }

    @Test
    fun agent_output_truncated_dark() =
        capture("agent_parity_output_truncated_dark", dark = true) {
            agentContent(outputTruncatedState())()
        }

    @Test
    fun agent_output_truncated_light() =
        capture("agent_parity_output_truncated_light", dark = false) {
            agentContent(outputTruncatedState())()
        }

    @Test
    fun agent_provider_failure_dark() =
        capture("agent_parity_provider_failure_dark", dark = true) {
            agentContent(providerFailureState())()
        }

    @Test
    fun agent_provider_failure_light() =
        capture("agent_parity_provider_failure_light", dark = false) {
            agentContent(providerFailureState())()
        }

    @Test
    fun agent_reopened_stopped_dark() =
        capture("agent_parity_reopened_stopped_dark", dark = true) {
            agentContent(reopenedStoppedState())()
        }

    @Test
    fun agent_reopened_stopped_light() =
        capture("agent_parity_reopened_stopped_light", dark = false) {
            agentContent(reopenedStoppedState())()
        }

    @Test
    fun agent_transcript_with_plan_dark() = capture("agent_parity_plan_in_context_dark", dark = true) {
        agentContent(
            richState().copy(
                chat = richState().chat.copy(
                    planItems = listOf(
                        AgentPlanItem("p1", "Search Maya's messages", "done"),
                        AgentPlanItem("p2", "Check purchase history for duplicates", "in_progress"),
                        AgentPlanItem("p3", "Summarize candidates", "pending"),
                    ),
                ),
            ),
        )()
    }

    private fun contextWindowExceededState() =
        AgentCoordinator.UiState(
            chat = AgentChatState(
                turns = listOf(
                    AgentTurn.User(
                        "u-context",
                        "Can you connect this to the earlier planning notes?",
                    ),
                    AgentTurn.Assistant(
                        id = "a-context",
                        parts = listOf(
                            AgentPart.Text(
                                "The earlier notes establish three priorities",
                            ),
                        ),
                        stopReason = "error",
                    ),
                ),
            ),
            sessionId = "s-context",
            model = "fictional-model",
            backend = "openai-compatible",
            hasClient = true,
            terminalFailure = AgentConversationTerminalFailure(
                code = "context_window_exceeded",
                message =
                    "This conversation no longer fits in the selected model's " +
                        "context window. Start a new conversation to continue.",
                backend = "openai-compatible",
                model = "fictional-model",
                failedAt = "2026-07-29T12:00:00.000Z",
            ),
        )

    private fun outputTruncatedState() =
        AgentCoordinator.UiState(
            chat = AgentChatState(
                turns = listOf(
                    AgentTurn.User(
                        "u-truncated",
                        "Summarize the complete planning history.",
                    ),
                    AgentTurn.Assistant(
                        id = "a-truncated",
                        parts = listOf(
                            AgentPart.Text(
                                "The planning history begins with three priorities and",
                            ),
                        ),
                        stopReason = "max_tokens",
                        failure = AgentTurnFailure(
                            message = "The model reached its output limit before completing " +
                                "this response.",
                            code = "output_truncated",
                        ),
                    ),
                ),
            ),
            sessionId = "s-truncated",
            model = "fictional-model",
            backend = "openai-compatible",
            hasClient = true,
        )

    // A turn the model provider refused: the humanized sentence plus the quiet machine-readable
    // line — the failure code and the provider's own disposition — the operator quotes when
    // reporting it. All fixtures invented.
    private fun providerFailureState() =
        AgentCoordinator.UiState(
            chat = AgentChatState(
                turns = listOf(
                    AgentTurn.User(
                        "u-provider-failure",
                        "Draft the agenda for the quarterly review.",
                    ),
                    AgentTurn.Assistant(
                        id = "a-provider-failure",
                        failure = AgentTurnFailure(
                            message = "The model provider does not have the assigned model — " +
                                "check the model assignment (HTTP 404).",
                            code = "http_api_error",
                            providerDetail = "HTTP 404 · NOT_FOUND · param=model",
                        ),
                    ),
                ),
            ),
            sessionId = "s-provider-failure",
            model = "fictional-model",
            backend = "openai-compatible",
            hasClient = true,
        )

    // A reply the user stopped, reopened later: the partial answer stays, and the only trace of
    // the stop is one quiet italic line — no warning icon, no danger chip. Fixtures invented.
    private fun reopenedStoppedState() =
        AgentCoordinator.UiState(
            chat = AgentChatState(
                turns = listOf(
                    AgentTurn.User(
                        "u-reopened-stopped",
                        "Summarize the quarterly invoices.",
                    ),
                    AgentTurn.Assistant(
                        id = "a-reopened-stopped",
                        parts = listOf(
                            AgentPart.Text(
                                "The two invoices from the quarterly folder are dated March 3 and",
                            ),
                        ),
                        stopReason = "canceled",
                        stopped = "You stopped this reply.",
                    ),
                ),
            ),
            sessionId = "s-reopened-stopped",
            model = "fictional-model",
            backend = "openai-compatible",
            hasClient = true,
        )

    // --- Citations drawer (PNG 89/100/103/108): right-side drawer, sticky tabs, Citations tab.
    //     Captured with progressOverride = 1f so the open end-state renders in a single frame
    //     (no live slide animation). Fixtures are invented (privacy rule).

    private fun voucherCitations(): List<AgentCitation> = listOf(
        AgentCitation(
            documentId = "c1",
            ref = docRef("c1", "Riverside Estate — booking confirmation"),
            entries = listOf(
                AgentCitationEntry(
                    toolCallId = "t1", messageId = "m1",
                    quote = "Ceremony lawn reserved for 4pm, final balance due 14 days prior.",
                    note = null, quoteAuthor = null,
                ),
            ),
        ),
        AgentCitation(
            documentId = "c2",
            ref = AgentDocRef(documentId = "c2", sourceId = "whatsapp:demo", title = "Catering thread — Stellar Sound"),
            docNote = "Confirms the headcount the agent used for the quote.",
            entries = listOf(
                AgentCitationEntry(
                    toolCallId = "t2", messageId = "m2",
                    quote = "We're locked at 80 guests — send the deposit when you can.",
                    note = null, quoteAuthor = "Maya Reeves",
                ),
            ),
        ),
        AgentCitation(
            documentId = "c3",
            ref = docRef("c3", "Final headcount spreadsheet"),
        ),
    )

    private fun citationsDrawer(
        citations: List<AgentCitation>,
        open: Boolean = true,
        progressOverride: Float? = 1f,
    ): @Composable () -> Unit = {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)) {
            CitationsDrawer(
                open = open,
                citations = citations,
                catalog = catalog,
                onClose = {}, onOpenDocument = {},
                progressOverride = progressOverride,
            )
        }
    }

    // Open drawer — the unified Timeline (events + sticky tabs peeking at the panel's
    // leading edge, header "N events · K sources"). Matches iOS PNG 100.
    @Test
    fun citations_drawer_populated_dark() = capture("agent_parity_citations_drawer_dark", dark = true) {
        citationsDrawer(budgetCitations())()
    }

    @Test
    fun citations_drawer_populated_light() = capture("agent_parity_citations_drawer_light", dark = false) {
        citationsDrawer(budgetCitations())()
    }

    @Test
    fun citations_drawer_empty_dark() = capture("agent_parity_citations_drawer_empty_dark", dark = true) {
        citationsDrawer(emptyList())()
    }

    // Closed drawer — the peek layer: sticky tabs anchored to each event row's Y + the "+N"
    // overflow pill at the bottom. Dark uses source-brand tab fills; light uses white tabs
    // with a soft shadow. Matches iOS PNG 103.
    @Test
    fun citations_drawer_closed_tabs_dark() = capture("agent_parity_citations_drawer_closed_dark", dark = true) {
        citationsDrawer(budgetCitations(), open = false, progressOverride = 0f)()
    }

    @Test
    fun citations_drawer_closed_tabs_light() = capture("agent_parity_citations_drawer_closed_light", dark = false) {
        citationsDrawer(budgetCitations(), open = false, progressOverride = 0f)()
    }

    // Timeline inside the drawer with the budget fixture. Matches iOS PNG 100.
    @Test
    fun citations_drawer_timeline_tab_dark() = capture("agent_parity_citations_drawer_timeline_dark", dark = true) {
        citationsDrawer(budgetCitations())()
    }

    // --- Trail timeline renderer in isolation (PNG 106 empty, 108 self-bubble) ---

    private fun trailHost(content: @Composable () -> Unit): @Composable () -> Unit = {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)) { content() }
    }

    @Test
    fun trail_timeline_empty_dark() = capture("agent_parity_trail_timeline_empty_dark", dark = true) {
        trailHost {
            TrailTimeline(
                events = emptyList(),
                annotations = AgentTrailAnnotations.empty,
                catalog = catalog,
                onOpenDocument = {},
            )
        }()
    }

    @Test
    fun trail_timeline_self_bubble_dark() = capture("agent_parity_trail_timeline_self_bubble_dark", dark = true) {
        // A conversation event whose annotations mix an incoming quote (left bgTertiary bubble)
        // and the user's own reply (right accent-tinted self bubble). Invented (privacy rule).
        val convoDoc = AgentTrailEventDoc(
            documentId = "convo-1",
            title = "Q4 budget thread",
            sourceId = "whatsapp:demo",
            documentType = "conversation",
        )
        val events = listOf(
            AgentTrailEvent(
                eventId = "convo-evt-1",
                at = "2026-05-14T16:40:00.000Z",
                kind = "seed",
                doc = convoDoc.copy(documentId = "convo-a", title = "Maya Reeves — 2026-05-14"),
                people = listOf(
                    AgentTrailEventPerson("p-self", "You", "participant", isSelf = true),
                    AgentTrailEventPerson("p-maya", "Maya Reeves", "participant"),
                ),
            ),
            AgentTrailEvent(
                eventId = "convo-evt-2",
                at = "2026-05-16T17:29:00.000Z",
                kind = "message",
                doc = convoDoc.copy(documentId = "convo-b", title = "Maya Reeves — 2026-05-16"),
                people = listOf(
                    AgentTrailEventPerson("p-self", "You", "participant", isSelf = true),
                    AgentTrailEventPerson("p-maya", "Maya Reeves", "participant"),
                ),
            ),
        )
        val annotations = AgentTrailAnnotations(
            mapOf(
                "convo-a" to AgentDocAnnotations(
                    quotes = listOf(
                        AgentQuoteEntry(
                            quote = "Can you resend the budget link? I can't find it.",
                            quoteAuthor = "Maya", quoteIsSelf = false,
                        ),
                    ),
                ),
                "convo-b" to AgentDocAnnotations(
                    quotes = listOf(
                        AgentQuoteEntry(quote = "Just sent it over.", quoteAuthor = "You", quoteIsSelf = true),
                    ),
                ),
            ),
        )
        trailHost {
            TrailTimeline(events = events, annotations = annotations, catalog = catalog, onOpenDocument = {})
        }()
    }

    // The trail-timeline renderer over a rich multi-day, multi-source fixture: an attachment
    // nested under its parent event, a related-edge line, per-source accent spines, and projected
    // annotations. Exercises the renderer's full event shape directly — the drawer's own timeline
    // is now built purely from citations, so this is where the attachment / related / multi-source
    // rendering keeps its visual coverage.
    @Test
    fun trail_timeline_rich_dark() = capture("agent_parity_trail_timeline_rich_dark", dark = true) {
        trailHost {
            TrailTimeline(
                events = budgetTrail(),
                annotations = AgentTrailAnnotations.from(budgetCitations()),
                catalog = catalog,
                onOpenDocument = {},
            )
        }()
    }

    // --- Record citations (#757): doc-only, record-only, deduped doc+record ---
    // The fictional `demo-fitness` Morning-run workout (5.2 km) the portal + iOS renderers use.

    private fun workoutRecord(boundDoc: String?) = AgentTrailRecord(
        recordKey = "health_workout|wk-1",
        table = "health_workout",
        tableDisplayName = "Workouts",
        title = "Morning run",
        keyFields = listOf(
            AgentTrailRecordKeyField("Distance", "5.2 km"),
            AgentTrailRecordKeyField("Duration", "31 min"),
            AgentTrailRecordKeyField("Avg HR", "148 bpm"),
        ),
        semanticTime = "2026-05-02T07:14:00.000Z",
        sourceId = "demo-fitness:device",
        sourceType = "demo-fitness",
        boundDocumentId = boundDoc,
    )

    @Test
    fun trail_timeline_record_only_dark() = capture("agent_parity_trail_timeline_record_only_dark", dark = true) {
        // A doc-only event interleaved with a record-only event (no `doc`, no tap target — the
        // record binds no document). The record sits chronologically by its semantic time.
        val events = listOf(
            AgentTrailEvent(
                eventId = "doc-plan",
                at = "2026-05-01T09:00:00.000Z",
                kind = "document",
                doc = AgentTrailEventDoc(documentId = "doc-plan", title = "Training plan — week 18", sourceId = "notes:local", documentType = "note"),
            ),
            AgentTrailEvent(
                eventId = "rec:health_workout|wk-1",
                at = "2026-05-02T07:14:00.000Z",
                kind = "record",
                record = workoutRecord(boundDoc = null),
            ),
        )
        trailHost {
            TrailTimeline(events = events, annotations = AgentTrailAnnotations.empty, catalog = catalog, onOpenDocument = {})
        }()
    }

    @Test
    fun trail_timeline_doc_plus_record_dark() = capture("agent_parity_trail_timeline_doc_plus_record_dark", dark = true) {
        // A document and its same-entity row collapsed into ONE event: the doc heads the row and
        // carries navigation, the record's declared key columns append inline (title not repeated).
        val events = listOf(
            AgentTrailEvent(
                eventId = "doc-run",
                at = "2026-05-02T07:14:00.000Z",
                kind = "document",
                doc = AgentTrailEventDoc(documentId = "doc-run", title = "Morning run", sourceId = "demo-fitness:device", documentType = "event"),
                record = workoutRecord(boundDoc = "doc-run"),
            ),
        )
        trailHost {
            TrailTimeline(events = events, annotations = AgentTrailAnnotations.empty, catalog = catalog, onOpenDocument = {})
        }()
    }

    @Test
    fun trail_timeline_mixed_records_dark() = capture("agent_parity_trail_timeline_mixed_records_dark", dark = true) {
        // Doc-only, deduped doc+record, and a record-only row with an edge-case null key value —
        // all three shapes in one timeline. Light-mode sanity is covered by the matching test.
        trailHost { TrailTimeline(events = mixedRecordEvents(), annotations = AgentTrailAnnotations.empty, catalog = catalog, onOpenDocument = {}) }()
    }

    @Test
    fun trail_timeline_mixed_records_light() = capture("agent_parity_trail_timeline_mixed_records_light", dark = false) {
        trailHost { TrailTimeline(events = mixedRecordEvents(), annotations = AgentTrailAnnotations.empty, catalog = catalog, onOpenDocument = {}) }()
    }

    private fun mixedRecordEvents() = listOf(
        AgentTrailEvent(
            eventId = "doc-plan",
            at = "2026-05-01T09:00:00.000Z",
            kind = "document",
            doc = AgentTrailEventDoc(documentId = "doc-plan", title = "Training plan — week 18", sourceId = "notes:local", documentType = "note"),
        ),
        AgentTrailEvent(
            eventId = "doc-run",
            at = "2026-05-02T07:14:00.000Z",
            kind = "document",
            doc = AgentTrailEventDoc(documentId = "doc-run", title = "Morning run", sourceId = "demo-fitness:device", documentType = "event"),
            record = workoutRecord(boundDoc = "doc-run"),
        ),
        AgentTrailEvent(
            eventId = "rec:health_workout|wk-2",
            at = "2026-05-04T18:02:00.000Z",
            kind = "record",
            record = AgentTrailRecord(
                recordKey = "health_workout|wk-2",
                table = "health_workout",
                tableDisplayName = "Workouts",
                title = "Evening ride",
                keyFields = listOf(
                    AgentTrailRecordKeyField("Distance", "18.6 km"),
                    AgentTrailRecordKeyField("Notes", null), // explicit null → em-dash
                ),
                semanticTime = "2026-05-04T18:02:00.000Z",
                sourceId = "demo-fitness:device",
                sourceType = "demo-fitness",
                boundDocumentId = null,
            ),
        ),
    )

    // --- Sub-agent card (#748): running, done, and both terminal failure shapes ---
    //
    // The live researcher row the parent's fan-out opens: who is working, the sources it
    // has reached, its reported usage, and — on a bad ending — what killed it. All fixture
    // data is invented (privacy rule), never sourced from the corpus.

    private fun runningSubagentCard() = AgentSubagentCard(
        subagentId = "s.sub.a1",
        specialist = "history-sweep",
        task = "Find prior decisions about the Q4 budget across email and chat",
        childTurns = listOf(
            AgentChildTurn(
                id = "cm",
                parts = listOf(
                    AgentPart.Tool(
                        AgentToolCall(
                            toolCallId = "ct1", tool = "search_documents",
                            argsSummary = "Q4 budget decision", argsKnown = true, result = null,
                        ),
                    ),
                ),
            ),
        ),
        stepCount = 1,
        status = null, // running
    )

    private fun completeSubagentCard() = AgentSubagentCard(
        subagentId = "s.sub.a2",
        specialist = "source-digest",
        task = "Summarize what the budget PDF and the sign-off thread agreed",
        childTurns = listOf(
            AgentChildTurn(
                id = "cm2",
                parts = listOf(
                    AgentPart.Tool(
                        AgentToolCall(
                            toolCallId = "ct2", tool = "trace_connections", argsKnown = true,
                            result = AgentToolResult.EventTrailBuilt(
                                events = listOf(
                                    trailEvent("t1", "Q4 budget review — finalised"),
                                    trailEvent("t2", "Budget sign-off thread"),
                                ),
                            ),
                            durationMs = 42.0,
                        ),
                    ),
                ),
            ),
        ),
        stepCount = 3,
        tokens = 1240,
        status = "complete",
        summary = "Spend is locked for the quarter; sign-off is on record in the thread.",
    )

    private fun partialSubagentCard() = AgentSubagentCard(
        subagentId = "s.sub.a3",
        specialist = "history-sweep",
        title = "Project approval history",
        task = "Trace the fictional project's approval history",
        docs = listOf(AgentResearchDoc("doc-project-note", "Project status", "demo-notes:local")),
        stepCount = 2,
        tokens = 16_384,
        status = "failed",
        summary = "Partial evidence collected before the worker reached its output limit:\n- Project status: The milestone was approved.",
        retainedCitationCount = 1,
        failureCode = "output_truncated",
    )

    // A worker the provider refused outright: no retained evidence, and a disposition to quote.
    private fun providerFailedSubagentCard() = AgentSubagentCard(
        subagentId = "s.sub.a4",
        specialist = "history-sweep",
        title = "Vendor contract sweep",
        task = "Trace the fictional vendor's contract history",
        stepCount = 1,
        tokens = 320,
        status = "failed",
        summary = "The provider refused the request: the configured model is not available to " +
            "this account, so the reader stopped before it reached any documents.",
        failureCode = "http_api_error",
        failureProviderDetail = "HTTP 404 · NOT_FOUND · param=model",
    )

    // The shape a busy Deep Research reader takes on a phone: a sentence-long title, a
    // six-figure token count, and documents from nine sources at once — about as wide as
    // the badged icon row goes before it wraps. Everything on the header but the title is
    // fixed-width, so this is the case that proves the working dots, the status, the token
    // counter and the whole source row survive a title that cannot fit.
    private fun wideRunningSubagentCard() = AgentSubagentCard(
        subagentId = "s.sub.wide",
        specialist = "history-sweep",
        title = "Warranty and service history across purchase receipts and repair tickets",
        task = "Trace every appliance with its cover dates",
        docs = listOf(
            AgentResearchDoc("w1", "Extended cover confirmation", "gmail:demo"),
            AgentResearchDoc("w2", "Repair ticket 4471", "gmail:demo"),
            AgentResearchDoc("w3", "Purchase receipt", "google-drive:demo"),
            AgentResearchDoc("w4", "Engineer visit thread", "whatsapp:demo"),
            AgentResearchDoc("w5", "Cover renewal reminder", "notes:local"),
            AgentResearchDoc("w6", "Service plan statement", "outlook:demo"),
            AgentResearchDoc("w7", "Boiler service record", "notion:demo"),
            AgentResearchDoc("w8", "Warranty card scan", "apple-notes:local"),
            AgentResearchDoc("w9", "Parts invoice", "dropbox:demo"),
            AgentResearchDoc("w10", "Cover terms PDF", "slack:demo"),
        ),
        stepCount = 9,
        tokens = 128_400,
        status = null, // running: the wave dots share the row with the status + counter
    )

    private fun subagentCardHost(content: @Composable () -> Unit): @Composable () -> Unit = {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(16.dp)) {
            content()
        }
    }

    @Test
    fun agent_subagent_card_dark() = capture("agent_parity_subagent_dark", dark = true) {
        subagentCardHost {
            Column(
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AgentSubAgentCard(runningSubagentCard())
                AgentSubAgentCard(wideRunningSubagentCard())
                AgentSubAgentCard(completeSubagentCard())
                AgentSubAgentCard(partialSubagentCard())
                AgentSubAgentCard(providerFailedSubagentCard())
            }
        }()
    }

    @Test
    fun agent_subagent_card_light() = capture("agent_parity_subagent_light", dark = false) {
        subagentCardHost {
            Column(
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AgentSubAgentCard(runningSubagentCard())
                AgentSubAgentCard(wideRunningSubagentCard())
                AgentSubAgentCard(completeSubagentCard())
                AgentSubAgentCard(partialSubagentCard())
                AgentSubAgentCard(providerFailedSubagentCard())
            }
        }()
    }

    // --- Research working-set surface (#748): live multi-researcher + finishing/collapse ---
    //
    // The bespoke multi-panel band that appears during a live Deep Research run — "N
    // researchers side by side", each panel accumulating its source-tinted documents live.
    // Parity with the portal `ResearchWorkspace` and the iOS `ResearchWorkspaceView`. The
    // gating/collapse + per-researcher dedup is unit-tested (snapshots can't drive the
    // event stream); these PNGs verify the rendering is legible, source-tinted, distinct
    // from the citation drawer, and not squashed. The live-pulse + status spinners are
    // inspection-gated so the native capture never hangs. All fixtures invented (privacy).

    private fun livePanels(): List<AgentResearchPanel> = listOf(
        AgentResearchPanel(
            subagentId = "s.sub.a",
            specialist = "history-sweep",
            title = "Budget history",
            task = "Find prior decisions about the Q4 budget across email and chat",
            docs = listOf(
                AgentResearchDoc("d1", "Your Q4 budget review is now finalised", "gmail:demo"),
                AgentResearchDoc("d2", "Budget sign-off — Maya", "whatsapp:demo"),
                AgentResearchDoc("d3", "q4-budget-summary-2025-final.pdf", "gmail:demo"),
            ),
            stepCount = 4,
            tokens = 2380,
            status = null, // running
            summary = null,
        ),
        AgentResearchPanel(
            subagentId = "s.sub.b",
            specialist = "source-digest",
            title = "Spend digest",
            task = "Summarize the latest spend tracker and headcount plan",
            docs = listOf(
                AgentResearchDoc("d4", "Final headcount spreadsheet", "google-drive:demo"),
                AgentResearchDoc("d5", "Q1 forecast — working draft", "google-drive:demo"),
            ),
            stepCount = 2,
            tokens = 1120,
            status = null,
            summary = null,
        ),
        AgentResearchPanel(
            subagentId = "s.sub.c",
            specialist = "citation-verifier",
            title = "Verify figures",
            task = "Re-check the quoted figures against their sources",
            docs = emptyList(),
            stepCount = 0,
            tokens = 0,
            status = null,
            summary = null,
        ),
    )

    private fun finishingPanels(): List<AgentResearchPanel> = listOf(
        livePanels()[0].copy(status = "complete", summary = "Spend is locked for the quarter; sign-off is on record."),
        livePanels()[1].copy(status = "complete", summary = "Headcount plan unchanged; forecast still a draft."),
        livePanels()[2].copy(
            status = "complete",
            stepCount = 3,
            tokens = 640,
            docs = listOf(AgentResearchDoc("d3", "q4-budget-summary-2025-final.pdf", "gmail:demo")),
            summary = "All three quoted figures matched their cited sources.",
        ),
    )

    private fun workspaceHost(panels: List<AgentResearchPanel>): @Composable () -> Unit = {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary), contentAlignment = Alignment.BottomCenter) {
            ResearchWorkspace(panels = panels)
        }
    }

    @Test
    fun agent_research_workspace_live_dark() = capture("agent_parity_research_workspace_live_dark", dark = true) {
        workspaceHost(livePanels())()
    }

    @Test
    fun agent_research_workspace_live_light() = capture("agent_parity_research_workspace_live_light", dark = false) {
        workspaceHost(livePanels())()
    }

    @Test
    fun agent_research_workspace_finishing_dark() = capture("agent_parity_research_workspace_finishing_dark", dark = true) {
        workspaceHost(finishingPanels())()
    }

    // One researcher with MANY docs: the per-panel doc list must scroll WITHIN the
    // panel and the band must stay a fixed bottom rail — never grow into a
    // full-screen overlay that buries the conversation (#890). The host is full
    // height so a regression (an unbounded panel) would visibly eat the screen.
    private fun manyDocsPanels(): List<AgentResearchPanel> = listOf(
        AgentResearchPanel(
            subagentId = "s.sub.many",
            specialist = "history-sweep",
            title = "Race history",
            task = "Find every document touching running races and 10k events",
            docs = (1..16).map { i ->
                AgentResearchDoc(
                    "dm$i",
                    "Race document #$i — registration / result / photos",
                    listOf("gmail:demo", "google-drive:demo", "whatsapp:demo")[i % 3],
                )
            },
            stepCount = 18,
            tokens = 941_300,
            status = null,
            summary = null,
        ),
        livePanels()[1],
    )

    @Test
    fun agent_research_workspace_many_docs_dark() = capture("agent_parity_research_workspace_many_docs_dark", dark = true) {
        workspaceHost(manyDocsPanels())()
    }

    // --- Verified-report artifact (#748): verified / partial / absent-degrades-to-prose ---
    //
    // The polished end-of-run enrichment below a Deep Research report bubble — the Android
    // twin of the portal `ReportArtifact` and the iOS `ReportArtifactView`. Parity bar: a
    // verification badge driven by the REAL quote tally (verified=green / partial=amber /
    // none=neutral), the honest stoppedReason, numbered inline source-tinted citation
    // markers (in-app doc-page deep-link), a tree-token footer. The absent case proves the
    // graceful degrade — an assistant turn with no `reportArtifact` shows only prose. The
    // badge/target/folding are unit-tested; these PNGs verify the rendering is legible and
    // honest. All fixtures invented (privacy).

    private fun reportCitations(): List<AgentCitation> = listOf(
        AgentCitation("doc-deck", AgentDocRef(documentId = "doc-deck", sourceId = "gmail:demo", title = "Q4 budget review — finalised")),
        AgentCitation("doc-thread", AgentDocRef(documentId = "doc-thread", sourceId = "whatsapp:demo", title = "Budget sign-off thread")),
        AgentCitation("doc-sheet", AgentDocRef(documentId = "doc-sheet", sourceId = "google-drive:demo", title = "q4-budget-summary-2025-final.pdf")),
        // Near-black bank brand accent (enable-banking, #111111): its numbered badge
        // used to vanish against the dark card — guards the neutral-row / theme-accent
        // treatment that makes dark-brand sources read consistently.
        AgentCitation("doc-stmt", AgentDocRef(documentId = "doc-stmt", sourceId = "enable-banking-accounts:self", title = "Operating account — Q4 statement")),
    )

    private fun verifiedArtifact() = AgentReportArtifact(
        stoppedReason = "answer_complete",
        plan = listOf(
            DeepResearchPlanItem("history-sweep", "Find prior decisions about the Q4 budget"),
            DeepResearchPlanItem("source-digest", "Summarize the spend tracker"),
        ),
        treeUsage = AgentUsage(inputTokens = 18400, outputTokens = 5200),
        verification = DeepResearchVerification(quotesChecked = 6, quotesVerified = 6),
    )

    private fun partialArtifact() = AgentReportArtifact(
        stoppedReason = "budget_exhausted",
        plan = emptyList(),
        treeUsage = AgentUsage(inputTokens = 31000, outputTokens = 8800),
        verification = DeepResearchVerification(quotesChecked = 6, quotesVerified = 3),
    )

    private fun reportTurn(artifact: AgentReportArtifact?) = AgentTurn.Assistant(
        id = "a1",
        parts = listOf(
            AgentPart.Text(
                "## Q4 budget\nThe quarter's total spend was approved and signed off; the tracker and the sign-off thread agree on the final figure.",
            ),
        ),
        stopReason = "end_turn",
        reportArtifact = artifact,
    )

    private fun reportHost(content: @Composable () -> Unit): @Composable () -> Unit = {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(16.dp)) {
            content()
        }
    }

    @Test
    fun agent_report_artifact_verified_dark() = capture("agent_parity_report_artifact_verified_dark", dark = true) {
        reportHost {
            ReportArtifact(verifiedArtifact(), reportCitations(), catalog, onOpenDocument = {})
        }()
    }

    @Test
    fun agent_report_artifact_verified_light() = capture("agent_parity_report_artifact_verified_light", dark = false) {
        reportHost {
            ReportArtifact(verifiedArtifact(), reportCitations(), catalog, onOpenDocument = {})
        }()
    }

    @Test
    fun agent_report_artifact_partial_dark() = capture("agent_parity_report_artifact_partial_dark", dark = true) {
        reportHost {
            ReportArtifact(partialArtifact(), reportCitations(), catalog, onOpenDocument = {})
        }()
    }

    // The full bubble with the artifact folded in — the in-context render.
    @Test
    fun agent_report_artifact_in_bubble_dark() = capture("agent_parity_report_artifact_in_bubble_dark", dark = true) {
        reportHost {
            AssistantTurn(
                reportTurn(verifiedArtifact()),
                catalog = catalog,
                onFlushEphemeral = {},
                onOpenDocument = {},
                citations = reportCitations(),
            )
        }()
    }

    // Absent artifact: an older / resumed Deep Research run shows ONLY the streamed prose —
    // proves the strictly-additive graceful degrade.
    @Test
    fun agent_report_artifact_absent_degrades_to_prose_dark() = capture("agent_parity_report_artifact_absent_dark", dark = true) {
        reportHost {
            AssistantTurn(
                reportTurn(artifact = null),
                catalog = catalog,
                onFlushEphemeral = {},
                onOpenDocument = {},
                citations = reportCitations(),
            )
        }()
    }

    // --- User bubble in isolation (PNG 84) ---

    @Test
    fun agent_user_bubble_dark() = capture("agent_parity_user_bubble_dark", dark = true) {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(16.dp)) {
            UserBubble("How has my heart rate been compared to last month?")
        }
    }

    // --- Plan panel in isolation (PNG 90) ---

    @Test
    fun agent_plan_mid_progress_dark() = capture("agent_parity_plan_panel_dark", dark = true) {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(vertical = 24.dp)) {
            AgentPlanPanel(
                listOf(
                    AgentPlanItem("p1", "Search Maya's messages", "done"),
                    AgentPlanItem("p2", "Check purchase history for duplicates", "in_progress"),
                    AgentPlanItem("p3", "Summarize candidates", "pending"),
                ),
            )
        }
    }

    // --- Composer states in isolation: idle (empty), with text (send), busy (stop) ---

    @Test
    fun agent_composer_idle_dark() = capture("agent_parity_composer_idle_dark", dark = true) {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary), contentAlignment = Alignment.BottomCenter) {
            AgentComposer(busy = false, enabled = true, onSend = { _, _ -> }, onStop = {})
        }
    }

    @Test
    fun agent_composer_with_text_dark() = capture("agent_parity_composer_with_text_dark", dark = true) {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary), contentAlignment = Alignment.BottomCenter) {
            AgentComposer(
                busy = false, enabled = true, onSend = { _, _ -> }, onStop = {},
                initialText = "What did Maya email me about",
            )
        }
    }

    @Test
    fun agent_composer_busy_dark() = capture("agent_parity_composer_busy_dark", dark = true) {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary), contentAlignment = Alignment.BottomCenter) {
            AgentComposer(busy = true, enabled = true, onSend = { _, _ -> }, onStop = {})
        }
    }

    // --- `/`→Deep Research pill (#748): slash typeahead open + armed pill ---
    //
    // Parity with portal iter-7 / iOS iter-11. Two states: (1) the typeahead menu
    // open (the `/` query lists the seeded "Deep Research (beta)" command), and (2) the
    // armed per-message pill (top-left glyph + label + `×`, prompt placeholder
    // below). The arm/clear interaction itself is unit-tested (snapshots can't
    // catch the tap sequence); these PNGs verify the legible rendering.

    // Keep experimental mode off to prove the Deep Research command remains
    // visible on a stable gateway.
    @Test
    fun agent_composer_slash_menu_dark() = capture("agent_parity_composer_slash_menu_dark", dark = true) {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary), contentAlignment = Alignment.BottomCenter) {
            AgentComposer(busy = false, enabled = true, onSend = { _, _ -> }, onStop = {}, initialText = "/", experimental = false)
        }
    }

    @Test
    fun agent_composer_slash_menu_light() = capture("agent_parity_composer_slash_menu_light", dark = false) {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary), contentAlignment = Alignment.BottomCenter) {
            AgentComposer(busy = false, enabled = true, onSend = { _, _ -> }, onStop = {}, initialText = "/deep", experimental = false)
        }
    }

    @Test
    fun agent_composer_armed_pill_dark() = capture("agent_parity_composer_armed_pill_dark", dark = true) {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary), contentAlignment = Alignment.BottomCenter) {
            AgentComposer(
                busy = false, enabled = true, onSend = { _, _ -> }, onStop = {},
                initialArmedCommand = SlashCommand.byId("deep-research"),
            )
        }
    }

    @Test
    fun agent_composer_armed_pill_light() = capture("agent_parity_composer_armed_pill_light", dark = false) {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary), contentAlignment = Alignment.BottomCenter) {
            AgentComposer(
                busy = false, enabled = true, onSend = { _, _ -> }, onStop = {},
                initialArmedCommand = SlashCommand.byId("deep-research"),
            )
        }
    }

    // --- Ephemeral tool-result slots (PNG 76/77/77c/78/78b/78e) ---
    //
    // The rolling-slot cards are frozen on a concrete slot index so the captured
    // frame shows a visible item rather than the parked (empty) state. All fixtures
    // are invented (privacy rule).

    private fun slotHost(content: @Composable () -> Unit): @Composable () -> Unit = {
        Box(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(16.dp)) {
            content()
        }
    }

    private fun args(vararg pairs: Pair<String, String>): JsonObject = buildJsonObject {
        pairs.forEach { (k, v) -> put(k, JsonPrimitive(v)) }
    }

    private fun docRef(id: String, title: String) =
        AgentDocRef(documentId = id, sourceId = "notes:local", title = title)

    @Test
    fun agent_ephemeral_search_slot_dark() = capture("agent_parity_ephemeral_search_dark", dark = true) {
        slotHost {
            AgentEphemeralSearchCard(
                call = AgentToolCall(
                    toolCallId = "s1", tool = "search_documents",
                    args = args("query" to "wedding venue catering contract"),
                    argsKnown = true,
                    result = AgentToolResult.SearchResults(
                        query = "wedding venue catering contract",
                        results = listOf(
                            docRef("d1", "Riverside Estate — booking confirmation"),
                            docRef("d2", "Catering quote v2 — Stellar Sound"),
                            docRef("d3", "Final headcount spreadsheet"),
                        ),
                    ),
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialIndex = 1, freeze = true,
            )
        }()
    }

    private fun temporalCard(): @Composable () -> Unit = {
        AgentEphemeralTemporalCard(
            call = AgentToolCall(
                toolCallId = "time-1",
                tool = "temporal_query",
                argsSummary = "2026-06-01 … 2026-06-30",
                argsKnown = true,
                result = AgentToolResult.Structured(
                    resultType = "temporal.results",
                    data = buildJsonObject {
                        put(
                            "items",
                            buildJsonArray {
                                addJsonObject {
                                    put("id", "projection:event-1")
                                    put("origin", "projection")
                                }
                                addJsonObject {
                                    put("id", "annotation:deadline-1")
                                    put("origin", "annotation")
                                }
                            },
                        )
                    },
                ),
            ),
            onFlushEphemeral = {},
            freeze = true,
        )
    }

    @Test
    fun agent_ephemeral_temporal_query_dark() =
        capture("agent_parity_ephemeral_temporal_query_dark", dark = true) {
            slotHost(temporalCard())()
        }

    @Test
    fun agent_ephemeral_temporal_query_light() =
        capture("agent_parity_ephemeral_temporal_query_light", dark = false) {
            slotHost(temporalCard())()
        }

    @Test
    fun agent_ephemeral_sql_row_slot_dark() = capture("agent_parity_ephemeral_sql_row_dark", dark = true) {
        slotHost {
            AgentEphemeralSqlCard(
                call = AgentToolCall(
                    toolCallId = "q1", tool = "run_sql",
                    args = args("sql" to "SELECT period, avg_heart_rate, min_hr, max_hr FROM vitals GROUP BY period"),
                    argsKnown = true,
                    result = AgentToolResult.SqlRows(
                        sql = "SELECT period, avg_heart_rate, min_hr, max_hr FROM vitals GROUP BY period",
                        columns = listOf("period", "avg_heart_rate", "min_hr", "max_hr"),
                        rows = listOf(
                            sqlRow("This Month", 87.4, 46, 185),
                            sqlRow("Last Month", 84.1, 44, 179),
                        ),
                        rowCount = 2,
                        sources = listOf(AgentSqlSource(sourceId = "health:local", displayName = "Vitals")),
                        subjects = listOf("Vitals"),
                    ),
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialSqlIndex = 1, initialRowIndex = 0, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_sql_wide_table_dark() = capture("agent_parity_ephemeral_sql_wide_dark", dark = true) {
        slotHost {
            AgentEphemeralSqlCard(
                call = AgentToolCall(
                    toolCallId = "q2", tool = "run_sql",
                    args = args("sql" to "SELECT session, dist_km, dur_min, pace_min, hr_avg, calories FROM activities"),
                    argsKnown = true,
                    result = AgentToolResult.SqlRows(
                        sql = "SELECT session, dist_km, dur_min, pace_min, hr_avg, calories FROM activities",
                        columns = listOf("session", "dist_km", "dur_min", "pace_min", "hr_avg", "calories"),
                        rows = listOf(
                            sqlRow("Tempo run", 8.2, 41, 5.0, 162, 540),
                            sqlRow("Long run", 18.0, 95, 5.3, 154, 1180),
                        ),
                        rowCount = 2,
                        sources = listOf(AgentSqlSource(sourceId = "health:local", displayName = "Activities")),
                        subjects = listOf("Activities"),
                    ),
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialSqlIndex = 1, initialRowIndex = 0, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_sql_query_only_dark() = capture("agent_parity_ephemeral_sql_query_dark", dark = true) {
        slotHost {
            AgentEphemeralSqlCard(
                call = AgentToolCall(
                    toolCallId = "q3", tool = "run_sql",
                    args = args("sql" to "SELECT period, avg_heart_rate FROM vitals GROUP BY period ORDER BY period"),
                    argsKnown = true,
                    result = null,
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialSqlIndex = 0, freeze = true,
            )
        }()
    }

    private fun finishedParallelSqlTurn() = AgentTurn.Assistant(
        id = "sql-finished",
        parts = (1..4).map { index ->
            AgentPart.Tool(
                AgentToolCall(
                    toolCallId = "sql-$index",
                    tool = "run_sql",
                    args = args("sql" to "SELECT $index"),
                    argsKnown = true,
                    result = AgentToolResult.SqlRows(sql = "SELECT $index"),
                ),
            )
        } + AgentPart.Text("All four checks agree."),
        stopReason = "end_turn",
    )

    @Test
    fun agent_finished_parallel_sql_dark() = capture("agent_parity_finished_parallel_sql_dark", dark = true) {
        slotHost {
            AssistantTurn(
                turn = finishedParallelSqlTurn(),
                catalog = catalog,
                onFlushEphemeral = {},
                onOpenDocument = {},
            )
        }()
    }

    @Test
    fun agent_finished_parallel_sql_light() = capture("agent_parity_finished_parallel_sql_light", dark = false) {
        slotHost {
            AssistantTurn(
                turn = finishedParallelSqlTurn(),
                catalog = catalog,
                onFlushEphemeral = {},
                onOpenDocument = {},
            )
        }()
    }

    @Test
    fun agent_ephemeral_document_slot_dark() = capture("agent_parity_ephemeral_document_dark", dark = true) {
        slotHost {
            AgentEphemeralDocumentCard(
                call = AgentToolCall(
                    toolCallId = "f1", tool = "fetch_document",
                    args = args("documentId" to "d1"),
                    argsKnown = true,
                    result = AgentToolResult.DocumentResult(
                        ref = docRef("d1", "Riverside Estate — booking confirmation and venue terms"),
                        document = AgentToolResult.DocumentResult.DocBody(
                            content = "Thanks for your booking.\n\n- Ceremony lawn reserved 4pm\n- Sound system, dance floor, two HF mics\n- Final balance due 14 days prior",
                        ),
                    ),
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialIndex = 1, freeze = true,
            )
        }()
    }

    // --- batch retrieval (search_many / fetch_many): one per-child card each ---

    @Composable
    private fun searchManyCard() {
        slotHost {
            AgentBatchEphemeralCards(
                call = AgentToolCall(
                    toolCallId = "sm1", tool = "search_many", argsKnown = true,
                    result = AgentToolResult.SearchBatch(),
                    children = listOf(
                        AgentToolChild(
                            index = 0, tool = "search_documents", argsSummary = "wedding venue contract",
                            result = AgentToolResult.SearchResults(
                                results = listOf(docRef("d1", "Riverside Estate — booking confirmation")),
                            ),
                        ),
                        AgentToolChild(
                            index = 1, tool = "search_documents", argsSummary = "catering quote",
                            result = AgentToolResult.SearchResults(
                                results = listOf(docRef("d2", "Catering quote v2 — Stellar Sound")),
                            ),
                        ),
                        // A still-running child renders its header + spinner concurrently.
                        AgentToolChild(index = 2, tool = "search_documents", argsSummary = "guest headcount", result = null),
                    ),
                ),
                catalog = catalog, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_search_many_dark() =
        capture("agent_parity_ephemeral_search_many_dark", dark = true) { searchManyCard() }

    @Test
    fun agent_ephemeral_search_many_light() =
        capture("agent_parity_ephemeral_search_many_light", dark = false) { searchManyCard() }

    @Composable
    private fun fetchManyCard() {
        slotHost {
            AgentBatchEphemeralCards(
                call = AgentToolCall(
                    toolCallId = "fm1", tool = "fetch_many", argsKnown = true,
                    result = AgentToolResult.DocumentBatch(),
                    children = listOf(
                        AgentToolChild(
                            index = 0, tool = "fetch_document",
                            result = AgentToolResult.DocumentResult(
                                ref = docRef("d1", "Riverside Estate — booking confirmation and venue terms"),
                                document = AgentToolResult.DocumentResult.DocBody(
                                    content = "Thanks for your booking.\n- Ceremony lawn reserved 4pm\n- Final balance due 14 days prior",
                                ),
                            ),
                        ),
                        AgentToolChild(
                            index = 1, tool = "fetch_document",
                            result = AgentToolResult.DocumentResult(
                                ref = docRef("d2", "Catering quote v2 — Stellar Sound"),
                                document = AgentToolResult.DocumentResult.DocBody(
                                    content = "Plated dinner for 80 guests.\nDeposit 30% on signing.",
                                ),
                            ),
                        ),
                    ),
                ),
                catalog = catalog, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_fetch_many_dark() =
        capture("agent_parity_ephemeral_fetch_many_dark", dark = true) { fetchManyCard() }

    @Test
    fun agent_ephemeral_fetch_many_light() =
        capture("agent_parity_ephemeral_fetch_many_light", dark = false) { fetchManyCard() }

    // --- batch retrieval on a NON-Codex backend (Anthropic / DeepSeek http): no
    // `agent.tool.child.*` progress, so `children` is empty and the cards are reconstructed
    // from the durable batch result (settled) or the pending args (running). ---

    /** Three invented queries the batch fans out over. */
    private fun searchManyQueriesArgs(): JsonObject = buildJsonObject {
        put(
            "queries",
            buildJsonArray {
                addJsonObject { put("query", "wedding venue contract") }
                addJsonObject { put("query", "catering quote") }
                addJsonObject { put("query", "guest headcount") }
            },
        )
    }

    /**
     * Non-Codex settled: empty [AgentToolCall.children] + a [AgentToolResult.SearchBatch] of 3
     * items → 3 SETTLED per-child cards, one per query, each showing its top hit.
     */
    @Composable
    private fun searchManyResultOnlyCard() {
        slotHost {
            AgentBatchEphemeralCards(
                call = AgentToolCall(
                    toolCallId = "smr1", tool = "search_many", argsKnown = true,
                    args = searchManyQueriesArgs(),
                    result = AgentToolResult.SearchBatch(
                        items = listOf(
                            AgentToolResult.SearchResults(
                                results = listOf(docRef("d1", "Riverside Estate — booking confirmation")),
                            ),
                            AgentToolResult.SearchResults(
                                results = listOf(docRef("d2", "Catering quote v2 — Stellar Sound")),
                            ),
                            AgentToolResult.SearchResults(
                                results = listOf(docRef("d3", "Guest list — 80 confirmed")),
                            ),
                        ),
                    ),
                    // children deliberately empty — the Anthropic / DeepSeek path.
                ),
                catalog = catalog, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_search_many_result_only_dark() =
        capture("agent_parity_ephemeral_search_many_result_only_dark", dark = true) { searchManyResultOnlyCard() }

    @Test
    fun agent_ephemeral_search_many_result_only_light() =
        capture("agent_parity_ephemeral_search_many_result_only_light", dark = false) { searchManyResultOnlyCard() }

    /**
     * Non-Codex running: empty [AgentToolCall.children] + no result yet + args with 3 queries → 3
     * PENDING per-child cards, each a header (query) + spinner, so the turn looks alive during the
     * tool call.
     */
    @Composable
    private fun searchManyPendingArgsCard() {
        slotHost {
            AgentBatchEphemeralCards(
                call = AgentToolCall(
                    toolCallId = "smp1", tool = "search_many", argsKnown = true,
                    args = searchManyQueriesArgs(),
                    result = null,
                    // children empty + result null: N live spinner cards while the batch runs.
                ),
                catalog = catalog, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_search_many_pending_dark() =
        capture("agent_parity_ephemeral_search_many_pending_dark", dark = true) { searchManyPendingArgsCard() }

    @Test
    fun agent_ephemeral_search_many_pending_light() =
        capture("agent_parity_ephemeral_search_many_pending_light", dark = false) { searchManyPendingArgsCard() }

    @Test
    fun agent_ephemeral_people_slot_dark() = capture("agent_parity_ephemeral_people_dark", dark = true) {
        slotHost {
            AgentEphemeralPeopleCard(
                call = AgentToolCall(
                    toolCallId = "p1", tool = "lookup_people",
                    args = args("query" to "Maya Reeves"),
                    argsKnown = true,
                    result = AgentToolResult.PersonResults(
                        query = "Maya Reeves",
                        results = listOf(
                            AgentPersonSummary(canonicalId = "c1", displayName = "Maya Reeves", aliases = listOf("maya@example.com")),
                            AgentPersonSummary(canonicalId = "c2", displayName = "Maya R. Lopez", aliases = listOf("+1 (555) 010-0142")),
                        ),
                    ),
                ),
                onFlushEphemeral = {},
                initialIndex = 0, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_people_pending_dark() = capture("agent_parity_ephemeral_people_pending_dark", dark = true) {
        slotHost {
            AgentEphemeralPeopleCard(
                call = AgentToolCall(
                    toolCallId = "p2", tool = "lookup_people",
                    args = args("query" to "Jamie Lopez"),
                    argsKnown = true, result = null,
                ),
                onFlushEphemeral = {}, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_url_hit_dark() = capture("agent_parity_ephemeral_url_hit_dark", dark = true) {
        slotHost {
            AgentEphemeralUrlLookupCard(
                call = AgentToolCall(
                    toolCallId = "u1", tool = "lookup_document_by_url",
                    args = args("url" to "https://docs.example.com/document/d/1abcDEF/edit"),
                    argsKnown = true,
                    result = AgentToolResult.DocumentByUrl(
                        url = "https://docs.example.com/document/d/1abcDEF/edit",
                        ref = docRef("d4", "Q4 launch plan — board pre-read"),
                    ),
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialIndex = 0, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_url_miss_dark() = capture("agent_parity_ephemeral_url_miss_dark", dark = true) {
        slotHost {
            AgentEphemeralUrlLookupCard(
                call = AgentToolCall(
                    toolCallId = "u2", tool = "lookup_document_by_url",
                    args = args("url" to "https://example.com/something-not-in-the-corpus"),
                    argsKnown = true,
                    result = AgentToolResult.DocumentByUrl(url = "https://example.com/something-not-in-the-corpus", ref = null),
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialIndex = 0, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_trail_slot_dark() = capture("agent_parity_ephemeral_trail_dark", dark = true) {
        slotHost {
            AgentEphemeralTrailCard(
                call = AgentToolCall(
                    toolCallId = "e1", tool = "trace_connections", argsKnown = true,
                    result = AgentToolResult.EventTrailBuilt(
                        events = listOf(
                            trailEvent("t1", "Booking thread — Riverside Estate"),
                            trailEvent("t2", "Catering quote v2 — Stellar Sound"),
                            trailEvent("t3", "Final headcount spreadsheet"),
                        ),
                    ),
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialIndex = 1, freeze = true,
            )
        }()
    }

    // --- Loops (experimental): doc-row chip, search_loops, fetch_loop ---
    //
    // The Cognition Steward's read-only surfaces. All fixture data is invented (privacy rule).

    private fun docRefWithLoops(id: String, title: String, loops: Int) = AgentDocRef(
        documentId = id,
        sourceId = "notes:local",
        title = title,
        openLoops = List(loops) { i ->
            AgentDocLoopRef(loopId = "loop-$id-$i", title = "Loop $i", state = "open")
        },
    )

    @Test
    fun agent_ephemeral_search_loops_chip_dark() =
        capture("agent_parity_ephemeral_search_loops_chip_dark", dark = true) { searchWithLoopChips() }

    @Test
    fun agent_ephemeral_search_loops_chip_light() =
        capture("agent_parity_ephemeral_search_loops_chip_light", dark = false) { searchWithLoopChips() }

    // A search_documents card whose visible result row carries open loops, so the
    // "🔗 N" chip renders inline on SlotDocRow.
    @Composable
    private fun searchWithLoopChips() {
        slotHost {
            AgentEphemeralSearchCard(
                call = AgentToolCall(
                    toolCallId = "sl0", tool = "search_documents",
                    args = args("query" to "deposit refund"),
                    argsKnown = true,
                    result = AgentToolResult.SearchResults(
                        query = "deposit refund",
                        results = listOf(
                            docRefWithLoops("d1", "Refund request — Riverside Estate", loops = 2),
                            docRef("d2", "Booking confirmation"),
                        ),
                    ),
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialIndex = 0, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_loops_search_dark() =
        capture("agent_parity_ephemeral_loops_search_dark", dark = true) { loopsSearchCard() }

    @Test
    fun agent_ephemeral_loops_search_light() =
        capture("agent_parity_ephemeral_loops_search_light", dark = false) { loopsSearchCard() }

    @Composable
    private fun loopsSearchCard() {
        slotHost {
            AgentEphemeralLoopsSearchCard(
                call = AgentToolCall(
                    toolCallId = "ls1", tool = "search_loops",
                    args = args("query" to "deposit refund"),
                    argsKnown = true,
                    result = AgentToolResult.LoopsSearched(
                        query = "deposit refund",
                        loops = listOf(
                            AgentLoopSummary(loopId = "l1", title = "Chase Riverside Estate deposit refund", state = "open", importance = 0.8),
                            AgentLoopSummary(loopId = "l2", title = "Confirm caterer final headcount", state = "snoozed", importance = 0.4),
                            AgentLoopSummary(loopId = "l3", title = "Reply to David Lin about the venue walk-through", state = "open"),
                        ),
                    ),
                ),
                onFlushEphemeral = {},
                initialIndex = 0, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_fetch_loop_dark() =
        capture("agent_parity_ephemeral_fetch_loop_dark", dark = true) { fetchLoopCard() }

    @Test
    fun agent_ephemeral_fetch_loop_light() =
        capture("agent_parity_ephemeral_fetch_loop_light", dark = false) { fetchLoopCard() }

    @Test
    fun agent_ephemeral_list_loops_dark() =
        capture("agent_parity_ephemeral_list_loops_dark", dark = true) { listLoopsCard() }

    @Test
    fun agent_ephemeral_list_loops_light() =
        capture("agent_parity_ephemeral_list_loops_light", dark = false) { listLoopsCard() }

    @Test
    fun agent_ephemeral_list_loops_pending_dark() =
        capture("agent_parity_ephemeral_list_loops_pending_dark", dark = true) {
            listLoopsCard(result = null)
        }

    @Test
    fun agent_ephemeral_list_loops_pending_light() =
        capture("agent_parity_ephemeral_list_loops_pending_light", dark = false) {
            listLoopsCard(result = null)
        }

    @Test
    fun agent_ephemeral_list_loops_error_dark() =
        capture("agent_parity_ephemeral_list_loops_error_dark", dark = true) {
            listLoopsCard(result = AgentToolResult.ErrorResult("unavailable", "Could not list loops"))
        }

    @Test
    fun agent_ephemeral_list_loops_error_light() =
        capture("agent_parity_ephemeral_list_loops_error_light", dark = false) {
            listLoopsCard(result = AgentToolResult.ErrorResult("unavailable", "Could not list loops"))
        }

    @Composable
    private fun listLoopsCard(
        result: AgentToolResult? = AgentToolResult.Structured(
            resultType = "loops.listed",
            data = buildJsonObject {},
        ),
    ) {
        slotHost {
            AgentEphemeralActionCard(
                call = AgentToolCall(
                    toolCallId = "ll1",
                    tool = "list_loops",
                    argsKnown = true,
                    result = result,
                ),
                label = "List loops",
                glyph = Icons.Outlined.Loop,
                onFlushEphemeral = {},
                freeze = true,
            )
        }()
    }

    @Composable
    private fun fetchLoopCard() {
        slotHost {
            AgentEphemeralLoopCard(
                call = AgentToolCall(
                    toolCallId = "fl1", tool = "fetch_loop",
                    args = args("loopId" to "l1"),
                    argsKnown = true,
                    result = AgentToolResult.LoopFetched(
                        loop = AgentLoopDetail(
                            loopId = "l1",
                            title = "Chase Riverside Estate deposit refund",
                            state = "open",
                            importance = 0.8,
                            deadline = "2026-07-20",
                            actors = listOf("Maya Reeves"),
                            involved = listOf("David Lin"),
                            docIds = listOf("d1", "d2"),
                            ledger = listOf(
                                AgentLoopLedgerEntry(at = 1_716_000_000_000L, note = "Opened after the booking thread mentioned a refundable deposit."),
                                AgentLoopLedgerEntry(at = 1_716_400_000_000L, note = "Maya emailed the venue to request the refund."),
                                AgentLoopLedgerEntry(at = 1_716_900_000_000L, note = "Still awaiting a reply — snoozed one week."),
                            ),
                        ),
                    ),
                ),
                onFlushEphemeral = {},
                initialIndex = 2, freeze = true,
            )
        }()
    }

    @Test
    fun agent_ephemeral_fetch_loop_empty_dark() =
        capture("agent_parity_ephemeral_fetch_loop_empty_dark", dark = true) {
            slotHost {
                AgentEphemeralLoopCard(
                    call = AgentToolCall(
                        toolCallId = "fl2", tool = "fetch_loop",
                        args = args("loopId" to "l-missing"),
                        argsKnown = true,
                        result = AgentToolResult.LoopFetched(loop = null),
                    ),
                    onFlushEphemeral = {},
                    initialIndex = 0, freeze = true,
                )
            }()
        }

    // --- Non-ephemeral switchboard pieces (PNG 79/81/81c) ---

    @Test
    fun agent_event_trail_summary_dark() = capture("agent_parity_trail_summary_dark", dark = true) {
        slotHost { AgentEventTrailSummary(eventCount = 12, truncated = false) }()
    }

    @Test
    fun agent_tool_error_single_dark() = capture("agent_parity_tool_error_dark", dark = true) {
        slotHost {
            AgentToolResultErrorView(
                code = "sql_failed",
                message = "Parser Error: syntax error at or near \"FORM\"",
            )
        }()
    }

    @Test
    fun agent_tool_error_multiline_dark() = capture("agent_parity_tool_error_multi_dark", dark = true) {
        slotHost {
            AgentToolResultErrorView(
                code = "sql_failed",
                message = "Binder Error: Referenced column \"metric_slug\" not found in FROM clause!\nLINE 9:   AND metric_slug = 'heart_rate'\nCandidate bindings: \"metric\", \"slug\"",
            )
        }()
    }

    @Test
    fun agent_tool_unknown_notice_dark() = capture("agent_parity_tool_unknown_dark", dark = true) {
        slotHost { AgentUnknownPartNotice(label = "tool result", kind = "trigger.upserted") }()
    }

    // --- Watch card states (PNG 88/89/90/91/92) ---

    @Test
    fun agent_watch_card_created_dark() = capture("agent_parity_watch_created_dark", dark = true) {
        slotHost {
            AgentWatchCard(
                AgentToolCall(
                    toolCallId = "tu1", tool = "watch_create", argsKnown = true,
                    result = AgentToolResult.WatchUpserted(
                        watchId = "wat_a", name = "Invoice watcher", action = "created",
                        enabled = true,
                        summary = "Notify when a new invoice email arrives in your inbox",
                    ),
                    durationMs = 120.0,
                ),
            )
        }()
    }

    @Test
    fun agent_watch_card_updated_dark() = capture("agent_parity_watch_updated_dark", dark = true) {
        slotHost {
            AgentWatchCard(
                AgentToolCall(
                    toolCallId = "tu2", tool = "watch_create", argsKnown = true,
                    result = AgentToolResult.WatchUpserted(
                        watchId = "wat_b", name = "Morning briefing", action = "updated",
                        enabled = true, summary = null,
                    ),
                    durationMs = 95.0,
                ),
            )
        }()
    }


    @Test
    fun agent_watch_card_pending_dark() = capture("agent_parity_watch_pending_dark", dark = true) {
        slotHost {
            AgentWatchCard(
                AgentToolCall(
                    toolCallId = "tu4", tool = "watch_create", argsKnown = true, result = null,
                ),
            )
        }()
    }

    @Test
    fun agent_watch_card_error_dark() = capture("agent_parity_watch_error_dark", dark = true) {
        slotHost {
            AgentWatchCard(
                AgentToolCall(
                    toolCallId = "tu5", tool = "watch_create", argsKnown = true,
                    result = AgentToolResult.ErrorResult(
                        code = "non_ios_actions",
                        message = "a watch may notify your phone or wake an agent; nothing else",
                    ),
                    durationMs = 8.0,
                ),
            )
        }()
    }

    @Test
    fun agent_watch_card_created_light() = capture("agent_parity_watch_created_light", dark = false) {
        slotHost {
            AgentWatchCard(
                AgentToolCall(
                    toolCallId = "tu1l", tool = "watch_create", argsKnown = true,
                    result = AgentToolResult.WatchUpserted(
                        watchId = "wat_a", name = "Invoice watcher", action = "created",
                        enabled = true,
                        summary = "Notify when a new invoice email arrives in your inbox",
                    ),
                ),
            )
        }()
    }

    // --- Light-mode coverage for the two-tone header + table contrast ---

    @Test
    fun agent_ephemeral_search_slot_light() = capture("agent_parity_ephemeral_search_light", dark = false) {
        slotHost {
            AgentEphemeralSearchCard(
                call = AgentToolCall(
                    toolCallId = "s1l", tool = "search_documents",
                    args = args("query" to "wedding venue catering contract"),
                    argsKnown = true,
                    result = AgentToolResult.SearchResults(
                        query = "wedding venue catering contract",
                        results = listOf(docRef("d1", "Riverside Estate — booking confirmation")),
                    ),
                ),
                catalog = catalog, onFlushEphemeral = {},
                initialIndex = 0, freeze = true,
            )
        }()
    }

    @Test
    fun agent_tool_error_single_light() = capture("agent_parity_tool_error_light", dark = false) {
        slotHost {
            AgentToolResultErrorView(code = "sql_failed", message = "Parser Error: syntax error at or near \"FORM\"")
        }()
    }

    private fun sqlRow(vararg cells: Any): List<JsonElement> = cells.map { c ->
        when (c) {
            is String -> JsonPrimitive(c)
            is Int -> JsonPrimitive(c)
            is Double -> JsonPrimitive(c)
            else -> JsonPrimitive(c.toString())
        }
    }

    private fun trailEvent(id: String, title: String) = AgentTrailEvent(
        eventId = id, kind = "message",
        doc = AgentTrailEventDoc(documentId = id, title = title, sourceId = "notes:local"),
    )

    // --- Timeline-tab fixture: a Q4-budget review thread across email + chat + a PDF.
    //     Multi-source, an attachment, a related line, and annotations. Invented (privacy rule).

    private fun budgetTrail(): List<AgentTrailEvent> = listOf(
        AgentTrailEvent(
            eventId = "e1",
            at = "2025-12-06T10:08:00.000Z",
            kind = "seed",
            doc = AgentTrailEventDoc(
                documentId = "b1",
                title = "Your Q4 budget review is now finalised",
                sourceId = "gmail:demo",
                documentType = "email",
            ),
            people = listOf(AgentTrailEventPerson("p-self", "You", "recipient", isSelf = true)),
            attachments = listOf(
                AgentTrailEvent(
                    eventId = "e1-att",
                    at = "2025-12-06T10:08:00.000Z",
                    kind = "attachment",
                    doc = AgentTrailEventDoc(
                        documentId = "b1-att",
                        title = "q4-budget-summary-2025-final.pdf",
                        sourceId = "gmail:demo",
                        documentType = "attachment",
                        mimeType = "application/pdf",
                    ),
                ),
            ),
        ),
        AgentTrailEvent(
            eventId = "e2",
            at = "2025-12-06T10:09:00.000Z",
            kind = "message",
            doc = AgentTrailEventDoc(
                documentId = "b2",
                title = "Budget sign-off — Maya",
                sourceId = "whatsapp:demo",
                documentType = "conversation",
            ),
            people = listOf(
                AgentTrailEventPerson("p-self", "You", "participant", isSelf = true),
                AgentTrailEventPerson("p-maya", "Maya Reeves", "participant"),
            ),
        ),
        AgentTrailEvent(
            eventId = "e3",
            at = "2025-12-24T18:07:00.000Z",
            kind = "message",
            doc = AgentTrailEventDoc(
                documentId = "b3",
                title = "Fwd: Q4 budget review — final allocation",
                sourceId = "gmail:demo",
                documentType = "email",
            ),
            people = listOf(AgentTrailEventPerson("p-jamie", "Jamie Lopez", "recipient")),
            related = listOf(
                AgentTrailEventRelated(
                    documentId = "b1",
                    title = "Your Q4 budget review is now finalised",
                    sourceId = "gmail:demo",
                    linkType = "email-thread",
                    direction = "out",
                ),
            ),
        ),
        AgentTrailEvent(
            eventId = "e4",
            at = "2026-05-14T16:40:00.000Z",
            kind = "message",
            doc = AgentTrailEventDoc(
                documentId = "b4",
                title = "Maya Reeves — 2026-05-14",
                sourceId = "whatsapp:demo",
                documentType = "conversation",
            ),
            people = listOf(
                AgentTrailEventPerson("p-self", "You", "participant", isSelf = true),
                AgentTrailEventPerson("p-maya", "Maya Reeves", "participant"),
            ),
        ),
    )

    private fun budgetCitations(): List<AgentCitation> = listOf(
        AgentCitation(
            documentId = "b1-att",
            ref = AgentDocRef(documentId = "b1-att", sourceId = "gmail:demo", title = "q4-budget-summary-2025-final.pdf"),
            docNote = "The Q4 budget PDF attached to the finalisation email.",
            entries = listOf(
                AgentCitationEntry(
                    toolCallId = "tc1", messageId = "m1",
                    quote = "Total approved spend — 1.2M, allocation locked for the quarter.",
                    note = null, quoteAuthor = null,
                ),
            ),
        ),
        AgentCitation(
            documentId = "b4",
            ref = AgentDocRef(documentId = "b4", sourceId = "whatsapp:demo", title = "Maya Reeves — 2026-05-14"),
            entries = listOf(
                AgentCitationEntry(
                    toolCallId = "tc2", messageId = "m2",
                    quote = "I use the budget sheet daily but I can't find the link anymore. Can you resend it?",
                    note = "Maya asked you for the budget link on 14 May 2026 — you sent the PDF over WhatsApp.",
                    quoteAuthor = "Maya", quoteIsSelf = false,
                ),
            ),
        ),
    )
}
