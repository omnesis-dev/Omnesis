// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTouchInput
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.TaskDocumentDto
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.ui.agent.AgentContent
import dev.omnesis.android.ui.agent.AgentCoordinator
import java.time.LocalDate
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * "Chat about this" driven the way a person drives it: a long press on a task, a slide onto
 * the fan's last target and a lift, then the conversation the gateway created opens with the
 * task's card at its top. The agent surface is fed the conversation the gateway returned, as
 * the app's agent coordinator is when it opens it. All fixture data is invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class TaskChatFlowTest {

    @get:Rule val compose = createComposeRule()

    private val today = LocalDate.of(2026, 10, 14)

    private val lease = TaskDto(
        id = "t_lease",
        title = "Renew the studio lease",
        accepted = true,
        scheduledFor = "2026-10-14",
        dueDay = "2026-10-30",
        documents = listOf(
            TaskDocumentDto(id = "d_offer", title = "Renewal offer", sourceId = "web"),
            TaskDocumentDto(id = "d_terms", title = "Lease terms", sourceId = "web"),
        ),
    )

    private lateinit var gateway: StatefulTasksGateway
    private val chatAvailable = MutableStateFlow(true)

    private fun start() {
        gateway = StatefulTasksGateway(listOf(lease), resolvedNow = "2026-10-14T09:30:00.000Z")
        val vm = TasksViewModel(gateway, chatAvailable = chatAvailable) { today }
        compose.setContent { Harness(vm) }
        compose.waitForIdle()
    }

    /** The Tasks screen until it opens a conversation, then the agent surface showing it. */
    @Composable
    private fun Harness(vm: TasksViewModel) {
        var openedId by remember { mutableStateOf<String?>(null) }
        CompositionLocalProvider(LocalInspectionMode provides true) {
            OmnesisTheme(darkTheme = false) {
                val id = openedId
                if (id == null) {
                    TasksScreen(onOpenMenu = {}, onOpenConversation = { openedId = it }, vm = vm)
                } else {
                    val conversation = gateway.conversations.single { it.sessionId == id }
                    AgentContent(
                        state = AgentCoordinator.UiState(
                            hasClient = true,
                            sessionId = conversation.sessionId,
                            title = conversation.title,
                            conversationOrigin = conversation.origin,
                        ),
                        catalog = SourceCatalog(),
                        onOpenMenu = {},
                        onSend = { _, _ -> },
                        onStop = {},
                        onRetry = {},
                        onNewConversation = {},
                        onFlushEphemeral = {},
                        onOpenDocument = {},
                    )
                }
            }
        }
    }

    private fun node(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true)

    /** Long-press [taskId]'s row, slide onto the fan target tagged [target] and lift there. */
    private fun fanTo(taskId: String, target: String) {
        val row = node("tasks.row.$taskId")
        val rowBounds = row.fetchSemanticsNode().boundsInRoot
        val press = Offset(rowBounds.width * 0.75f, 40f)
        row.performTouchInput {
            down(press)
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 100)
            moveBy(Offset(0f, 1f))
        }
        compose.waitForIdle()
        val local = node("tasks.fan.$target").fetchSemanticsNode().boundsInRoot.center - rowBounds.topLeft
        row.performTouchInput {
            moveTo(local)
            up()
        }
        compose.waitForIdle()
    }

    @Test
    fun chat_about_this_opens_a_new_conversation_headed_by_the_task() {
        start()

        fanTo(lease.id, "chatAbout")

        assertEquals(listOf("Renew the studio lease"), gateway.conversations.map { it.title })
        // Chatting changed nothing about the task.
        assertTrue(gateway.commands.isEmpty())
        compose.onNode(
            hasTestTag("agent.origin.task") and
                hasText("TASK") and
                hasText("Renew the studio lease") and
                hasText("Open") and
                hasText("2 sources"),
        ).assertIsDisplayed()
        // Not the blank-chat landing: the card is what the chat is about.
        compose.onNodeWithText("Ask Omnesis about your corpus").assertDoesNotExist()
    }

    @Test
    fun the_fan_has_no_chat_target_while_the_gateway_does_not_offer_it() {
        chatAvailable.value = false
        start()

        val row = node("tasks.row.${lease.id}")
        row.performTouchInput {
            down(Offset(width * 0.75f, 40f))
            advanceEventTime(viewConfiguration.longPressTimeoutMillis + 100)
            moveBy(Offset(0f, 1f))
        }
        compose.waitForIdle()

        node("tasks.fan.cancelTask").assertExists()
        node("tasks.fan.chatAbout").assertDoesNotExist()
        row.performTouchInput { up() }
    }
}
