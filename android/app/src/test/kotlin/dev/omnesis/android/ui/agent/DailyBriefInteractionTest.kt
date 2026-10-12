// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
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
import org.junit.Assert.assertEquals
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

    private fun start(days: Int = 3, failingOnce: Set<String> = emptySet()) {
        val (origin, messages) = DailyBriefFixtures.conversation(days)
        loader = DailyBriefFixtures.Loader(DailyBriefFixtures.pages, failingOnce)
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

    @Test
    fun earlier_days_fold_to_one_line_that_opens_and_folds_again() {
        start()
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasTestTag("dailyBrief.folded.2026-10-12"))
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
}
