// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.DailyBriefReactionKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Morning brief conversation driven through the real agent surface: day separators, the
 * latest day open with what its brief was based on, earlier days folded until tapped, chips
 * that open documents and tasks, and a Retry that recovers a failed read. Fixtures are invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DailyBriefInteractionTest {

    @get:Rule val compose = createComposeRule()

    private val opened = mutableListOf<String>()
    private val tasks = mutableListOf<String>()
    private lateinit var loader: DailyBriefFixtures.Loader
    private lateinit var sender: DailyBriefFixtures.Sender

    private fun start(days: Int = 3, failingOnce: Set<String> = emptySet(), failingReactions: Set<String> = emptySet()) {
        val (origin, messages) = DailyBriefFixtures.conversation(days)
        loader = DailyBriefFixtures.Loader(DailyBriefFixtures.pages, failingOnce)
        sender = DailyBriefFixtures.Sender(failing = failingReactions)
        val state = AgentCoordinator.UiState(
            hasClient = true,
            sessionId = DailyBriefFixtures.CONVERSATION_ID,
            conversationOrigin = origin,
            chat = AgentTurnBuilder.stateFrom(messages, breakBefore = AgentTurnBuilder.briefTurnBreaks(origin, 0)),
        )
        compose.setContent {
            // Inspection mode freezes the transcript's own animations; taps and fetches still run.
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = false) {
                    AgentContent(
                        state = state,
                        catalog = SourceCatalog(),
                        onOpenMenu = {},
                        onSend = { _, _ -> },
                        onStop = {},
                        onRetry = {},
                        onNewConversation = {},
                        onFlushEphemeral = {},
                        onOpenDocument = { opened += it },
                        onOpenTask = { tasks += it },
                        dailyBrief = DailyBriefContext(
                            loader = loader,
                            now = { DailyBriefFixtures.now },
                            zone = { DailyBriefFixtures.zone },
                            reactions = sender,
                        ),
                    )
                }
            }
        }
        compose.waitForIdle()
    }

    private fun node(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true)

    @Test
    fun the_latest_brief_is_open_with_its_header_time_and_list() {
        start()
        node("dailyBrief.separator.2026-10-14").assertIsDisplayed()
        // The latest day's separator does not fold, so TalkBack hears just its day.
        node("dailyBrief.separator.2026-10-14").assertContentDescriptionEquals("Today")
        compose.onNodeWithContentDescription("Morning brief, sent at 07:05").assertExists()
        compose.onNodeWithText("Based on 3 things").assertExists()
        compose.onNodeWithText("The venue deposit is due on Friday.").assertExists()
        // The composer speaks to the brief.
        compose.onNodeWithText("Reply about today's brief…").assertExists()
    }

    /** Opening on a long history still lands on the latest brief, not the oldest day. */
    @Test
    fun a_long_conversation_opens_at_its_latest_brief() {
        start(days = 14)
        node("dailyBrief.separator.2026-10-14").assertIsDisplayed()
        compose.onNodeWithContentDescription("Morning brief, sent at 07:05").assertIsDisplayed()
        node("dailyBrief.separator.2026-10-01").assertDoesNotExist()
    }

    /** A folded line reads its count itself, so it is right even before its separator scrolls in. */
    @Test
    fun a_folded_line_counts_its_things_before_its_separator_shows() {
        start()
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasTestTag("dailyBrief.folded.2026-10-12"))
        compose.waitForIdle()
        compose.onNodeWithText("Morning brief · 2 things · 1 reply").assertExists()
    }

    @Test
    fun earlier_days_fold_to_one_line_that_opens_and_folds_again() {
        start()
        // Up to the day's heading, which brings its folded line in under it.
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasTestTag("dailyBrief.separator.2026-10-12"))
        compose.waitForIdle()
        node("dailyBrief.folded.2026-10-12").assertExists()
        compose.onNodeWithText("Morning brief · 2 things · 1 reply").assertExists()
        compose.onNodeWithText("Mon 12 Oct").assertExists()
        compose.onNodeWithText("Yesterday").assertExists()

        node("dailyBrief.folded.2026-10-12").performClick()
        compose.waitForIdle()
        node("dailyBrief.folded.2026-10-12").assertDoesNotExist()
        compose.onNode(hasText("Earlier brief for 2026-10-12", substring = true)).assertExists()
        // An earlier day's list starts closed, and opens on tap.
        compose.onNodeWithText("Based on 2 things").assertExists()
        compose.onNodeWithText("Invented item 1 for 2026-10-12.").assertDoesNotExist()
        node("dailyBrief.footer.2026-10-12").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Invented item 1 for 2026-10-12.").assertExists()

        node("dailyBrief.separator.2026-10-12").performClick()
        compose.waitForIdle()
        node("dailyBrief.folded.2026-10-12").assertExists()
    }

    @Test
    fun the_latest_list_folds_and_opens_from_its_footer() {
        start()
        node("dailyBrief.footer.2026-10-14").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("The venue deposit is due on Friday.").assertDoesNotExist()
        node("dailyBrief.footer.2026-10-14").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("The venue deposit is due on Friday.").assertExists()
    }

    @Test
    fun source_and_task_chips_open_the_document_and_the_task() {
        start()
        node("dailyBrief.source.doc_quote").performClick()
        node("dailyBrief.task.task_deposit").performClick()
        compose.waitForIdle()
        assertEquals(listOf("doc_quote"), opened)
        assertEquals(listOf("task_deposit"), tasks)
        // A source with no title still reads as a document.
        compose.onNodeWithText("Untitled document").assertExists()
    }

    @Test
    fun a_failed_read_says_so_quietly_and_retry_recovers() {
        start(failingOnce = setOf("2026-10-14"))
        compose.onNodeWithText("Couldn't load —").assertExists()

        node("dailyBrief.retry.2026-10-14").performClick()
        compose.waitForIdle()

        compose.onNodeWithText("Couldn't load —").assertDoesNotExist()
        compose.onNodeWithText("Based on 3 things").assertExists()
        assertEquals(2, loader.reads.count { it == "2026-10-14" })
    }

    // --- Reactions ------------------------------------------------------------------------

    @Test
    fun items_show_the_reactions_the_brief_came_with() {
        start()
        node("dailyBrief.thumbsUp.obs_deposit").assertIsNotSelected()
        node("dailyBrief.thumbsDown.obs_deposit").assertIsNotSelected()
        node("dailyBrief.thumbsUp.obs_tuner").assertIsSelected()
        node("dailyBrief.thumbsDown.obs_review").assertIsSelected()
        node("dailyBrief.reactionCaption.obs_review").assertExists()
        compose.onNodeWithText("Not interested").assertExists()
        node("dailyBrief.reactionCaption.obs_deposit").assertDoesNotExist()
    }

    @Test
    fun thumbs_up_selects_and_a_second_tap_clears() {
        start()
        node("dailyBrief.thumbsUp.obs_deposit").performClick()
        compose.waitForIdle()
        node("dailyBrief.thumbsUp.obs_deposit").assertIsSelected()

        node("dailyBrief.thumbsUp.obs_deposit").performClick()
        compose.waitForIdle()
        node("dailyBrief.thumbsUp.obs_deposit").assertIsNotSelected()
        assertEquals(
            listOf(
                DailyBriefFixtures.Reaction("obs_deposit", DailyBriefReactionKind.UP, null),
                DailyBriefFixtures.Reaction("obs_deposit", null, null),
            ),
            sender.sent,
        )
    }

    @Test
    fun thumbs_down_asks_which_and_not_interested_is_sent_at_once() {
        start()
        node("dailyBrief.thumbsDown.obs_deposit").performClick()
        compose.waitForIdle()
        node("dailyBrief.thumbsDownDialog").assertIsDisplayed()
        compose.onNodeWithText(DailyBriefCopy.NOT_INTERESTED_CHOICE).assertExists()
        compose.onNodeWithText(DailyBriefCopy.FACTUAL_ERROR_CHOICE).assertExists()

        node("dailyBrief.thumbsDownChoice.not_interested").performClick()
        node("dailyBrief.thumbsDownContinue").performClick()
        compose.waitForIdle()

        node("dailyBrief.thumbsDownDialog").assertDoesNotExist()
        node("dailyBrief.thumbsDown.obs_deposit").assertIsSelected()
        node("dailyBrief.reactionCaption.obs_deposit").assertExists()
        assertEquals(listOf(DailyBriefFixtures.Reaction("obs_deposit", DailyBriefReactionKind.NOT_INTERESTED, null)), sender.sent)
    }

    /** With no capture to take a correction, a factual error is still recorded, without words. */
    @Test
    fun a_factual_error_without_a_capture_is_sent_without_words() {
        start()
        node("dailyBrief.thumbsDown.obs_deposit").performClick()
        compose.waitForIdle()
        node("dailyBrief.thumbsDownChoice.factual_error").performClick()
        node("dailyBrief.thumbsDownContinue").performClick()
        compose.waitForIdle()
        compose.onNodeWithText("Factual error").assertExists()
        assertEquals(listOf(DailyBriefFixtures.Reaction("obs_deposit", DailyBriefReactionKind.FACTUAL_ERROR, null)), sender.sent)
    }

    @Test
    fun cancelling_the_thumbs_down_sends_nothing() {
        start()
        node("dailyBrief.thumbsDown.obs_deposit").performClick()
        compose.waitForIdle()
        node("dailyBrief.thumbsDownCancel").performClick()
        compose.waitForIdle()
        node("dailyBrief.thumbsDownDialog").assertDoesNotExist()
        node("dailyBrief.thumbsDown.obs_deposit").assertIsNotSelected()
        assertTrue(sender.sent.isEmpty())
    }

    @Test
    fun a_refused_reaction_goes_back_and_its_reason_can_be_dismissed() {
        start(failingReactions = setOf("obs_deposit"))
        node("dailyBrief.thumbsUp.obs_deposit").performClick()
        compose.waitForIdle()
        node("dailyBrief.thumbsUp.obs_deposit").assertIsNotSelected()
        node("dailyBrief.reactionError.2026-10-14").assertExists()
        compose.onNode(hasText("Couldn't save your reaction", substring = true)).assertExists()

        node("dailyBrief.reactionError.dismiss.2026-10-14").performClick()
        compose.waitForIdle()
        node("dailyBrief.reactionError.2026-10-14").assertDoesNotExist()
    }
}
