// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AssistantPart
import dev.omnesis.android.transport.dto.ChatMessage
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.TaskOriginSnapshot
import dev.omnesis.android.transport.dto.UserPart
import dev.omnesis.android.transport.dto.WatchFiringOriginSnapshot
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * An anchored thread — one the agent opened when a watch fired — is a reply to a card, and
 * the gateway hides the folded run transcript that seeded it. On a thread nobody has replied to
 * yet that seed is the *whole* transcript, so there are no visible turns at all: the card is the
 * only thing standing between the reader and a screen that looks broken.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentOriginCardTest {

    @get:Rule
    val compose = createComposeRule()

    private val watchOrigin = ConversationOrigin(
        kind = "watch_firing",
        watchId = "watch_example",
        watch = WatchFiringOriginSnapshot(
            name = "a deposit clears",
            condition = "a supplier changes their bank details partway through a thread",
            firedAt = 1_767_225_600_000,
        ),
        seedMessageCount = 1,
    )

    private val taskOrigin = ConversationOrigin(
        kind = "task",
        runId = "task_example",
        taskId = "task_example",
        task = TaskOriginSnapshot(
            title = "Renew the studio lease",
            state = "open",
            due = "2026-10-22",
            sourceCount = 3,
        ),
        seedMessageCount = 0,
    )

    @Test
    fun a_recognised_origin_carrying_its_snapshot_has_a_card() {
        assertTrue(hasContextCard(watchOrigin))
        assertTrue(hasContextCard(taskOrigin))
    }

    /**
     * Without the snapshot there is nothing to draw, so the seeded prefix must stay visible
     * rather than be hidden behind a card that never appears.
     */
    @Test
    fun an_origin_without_its_snapshot_or_of_an_unknown_kind_has_no_card() {
        assertFalse(hasContextCard(null))
        assertFalse(hasContextCard(watchOrigin.copy(watch = null)))
        assertFalse(hasContextCard(taskOrigin.copy(task = null)))
        assertFalse(hasContextCard(ConversationOrigin(kind = "something_later", seedMessageCount = 2)))
        // The Morning brief conversation is an ordinary visible thread with nothing to hide.
        assertFalse(hasContextCard(ConversationOrigin(kind = "daily_brief", runId = "run_example")))
    }

    @Test
    fun a_watch_firing_thread_says_which_watch_fired_and_what_it_watches_for() {
        showAgent(watchOrigin)

        compose.onNodeWithText("WATCH FIRED").assertIsDisplayed()
        compose.onNodeWithText("a deposit clears").assertIsDisplayed()
        compose.onNodeWithText("WATCHING FOR").assertIsDisplayed()
        compose
            .onNodeWithText("a supplier changes their bank details partway through a thread")
            .assertIsDisplayed()
        compose.onNodeWithText("Ask Omnesis about your corpus").assertDoesNotExist()
    }

    @Test
    fun tapping_a_watch_firing_card_opens_that_watch() {
        var openedWatchId: String? = null
        showAgent(watchOrigin, onOpenWatch = { openedWatchId = it })

        compose.onNode(
            hasText("a deposit clears") and
                hasText("a supplier changes their bank details partway through a thread") and
                hasClickAction(),
        ).performClick()

        assertEquals("watch_example", openedWatchId)
    }

    @Test
    fun a_legacy_watch_firing_without_an_id_stays_noninteractive() {
        var openedWatchId: String? = null
        showAgent(watchOrigin.copy(watchId = null), onOpenWatch = { openedWatchId = it })

        compose.onNodeWithText("a deposit clears").assertHasNoClickAction()

        assertEquals(null, openedWatchId)
    }

    /**
     * A task conversation has no seed, so nothing is hidden: every message the user and the
     * agent wrote shows under the card.
     */
    @Test
    fun a_task_conversation_hides_no_messages() {
        val messages = listOf(
            ChatMessage.User(listOf(UserPart.Text("What is left before the lease can be renewed?"))),
            ChatMessage.Assistant(listOf(AssistantPart.Text("The signed form and the deposit."))),
        )
        assertEquals(messages, visibleConversationMessages(messages, taskOrigin))
        assertEquals(messages, visibleConversationMessages(messages, taskOrigin.copy(seedMessageCount = null)))
    }

    @Test
    fun a_task_card_reads_its_state_due_day_and_sources() {
        val today = LocalDate.of(2026, 10, 21)
        assertEquals(
            listOf("Open", "Due tomorrow", "3 sources"),
            taskOriginFacts(taskOrigin.task!!, today).map { it.text },
        )
        assertEquals(
            listOf("Done", "1 source"),
            taskOriginFacts(TaskOriginSnapshot(title = "T", state = "done", sourceCount = 1), today).map { it.text },
        )
        assertEquals(
            listOf("Struck", "Due Fri 6 Nov"),
            taskOriginFacts(TaskOriginSnapshot(title = "T", state = "dismissed", due = "2026-11-06"), today)
                .map { it.text },
        )
        // A due day that has passed is overdue only while the task is still unresolved.
        val late = TaskOriginSnapshot(title = "T", state = "open", due = "2026-10-19")
        assertEquals(
            TaskOriginFact(TaskOriginFactIcon.DUE, "Due Mon 19 Oct", overdue = true),
            taskOriginFacts(late, today)[1],
        )
        assertFalse(taskOriginFacts(late.copy(state = "done"), today)[1].overdue)
        assertFalse(taskOriginFacts(taskOrigin.task!!, today)[1].overdue)
        // A state a newer gateway names reads as it is spelled; an unreadable due day is left out.
        assertEquals(
            listOf("Waiting"),
            taskOriginFacts(TaskOriginSnapshot(title = "T", state = "waiting", due = "soon"), today).map { it.text },
        )
    }

    @Test
    fun a_task_conversation_says_which_task_it_is_about_ready_for_the_first_message() {
        showAgent(taskOrigin)

        compose.onNodeWithText("TASK").assertIsDisplayed()
        compose.onNodeWithText("Renew the studio lease").assertIsDisplayed()
        compose.onNodeWithText("3 sources").assertIsDisplayed()
        compose.onNodeWithText("Ask Omnesis about your corpus").assertDoesNotExist()
        assertTrue(awaitsFirstMessage(AgentCoordinator.UiState(sessionId = "s", conversationOrigin = taskOrigin)))
        assertFalse(
            awaitsFirstMessage(
                AgentCoordinator.UiState(sessionId = "s", conversationOrigin = taskOrigin, transcriptLoading = true),
            ),
        )
        assertFalse(awaitsFirstMessage(AgentCoordinator.UiState(sessionId = "s", conversationOrigin = watchOrigin)))
    }

    @Test
    fun tapping_a_task_card_opens_that_task() {
        var openedTaskId: String? = null
        showAgent(taskOrigin, onOpenTask = { openedTaskId = it })

        compose.onNode(hasText("Renew the studio lease") and hasClickAction()).performClick()

        assertEquals("task_example", openedTaskId)
    }

    @Test
    fun a_task_card_without_a_task_id_stays_noninteractive() {
        showAgent(taskOrigin.copy(taskId = null), onOpenTask = { error("nothing to open") })

        compose.onNodeWithText("Renew the studio lease").assertHasNoClickAction()
        compose.onNodeWithText("View task").assertDoesNotExist()
    }

    /** A plain thread with nothing in it is still the blank chat it always was. */
    @Test
    fun a_thread_with_no_origin_still_shows_the_blank_chat() {
        showAgent(origin = null)

        compose.onNodeWithText("Ask Omnesis about your corpus").assertIsDisplayed()
    }

    private fun showAgent(
        origin: ConversationOrigin?,
        onOpenWatch: ((String) -> Unit)? = null,
        onOpenTask: (String) -> Unit = {},
    ) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AgentContent(
                    state = AgentCoordinator.UiState(
                        hasClient = true,
                        sessionId = "s_anchored",
                        conversationOrigin = origin,
                    ),
                    catalog = SourceCatalog(),
                    onOpenMenu = {},
                    onSend = { _, _ -> },
                    onStop = {},
                    onRetry = {},
                    onNewConversation = {},
                    onFlushEphemeral = {},
                    onOpenDocument = {},
                    onOpenWatch = onOpenWatch,
                    onOpenTask = onOpenTask,
                )
            }
        }
    }
}
