// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.ui.agent.AgentChatState
import dev.omnesis.android.ui.agent.AgentCitation
import dev.omnesis.android.ui.agent.AgentCitationEntry
import dev.omnesis.android.ui.agent.AgentContent
import dev.omnesis.android.ui.agent.AgentCoordinator
import dev.omnesis.android.ui.agent.AgentPart
import dev.omnesis.android.ui.agent.AgentTurn
import dev.omnesis.android.ui.tasks.TaskRowActions
import dev.omnesis.android.ui.tasks.TasksContent
import dev.omnesis.android.ui.tasks.TasksUiState
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Exercises the real nested pointer recognizers that the pure [MenuRevealTest] cannot see. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class MenuGestureIntegrationTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun `right swipe over a task row opens the menu without touching the task`() {
        var menuOpened = false
        var taskActions = 0
        var hapticCount = 0

        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                var menuOpen by remember { mutableStateOf(false) }
                MenuRevealContainer(
                    isOpen = menuOpen,
                    onOpenChange = {
                        menuOpen = it
                        menuOpened = it
                    },
                    onCommittedSwipeHaptic = { hapticCount += 1 },
                    menu = {},
                ) {
                    TasksContent(
                        state = TasksUiState(loading = false, day = TODAY.toString(), tasks = listOf(sampleTask)),
                        today = TODAY,
                        actions = TaskRowActions(
                            onTapBullet = { taskActions += 1 },
                            onOpen = { taskActions += 1 },
                            onFanAction = { _, _ -> taskActions += 1 },
                        ),
                    )
                }
            }
        }

        compose.onNodeWithText(sampleTask.title).performTouchInput {
            swipe(
                start = Offset(width * 0.1f, centerY),
                end = Offset(width * 0.9f, centerY),
                durationMillis = 400,
            )
        }

        compose.waitUntil(5_000) { menuOpened }
        assertEquals(0, taskActions)
        assertEquals(1, hapticCount)
    }

    @Test
    fun `short fast right flick opens the menu and emits one haptic`() {
        var menuOpened = false
        var hapticCount = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                var menuOpen by remember { mutableStateOf(false) }
                MenuRevealContainer(
                    isOpen = menuOpen,
                    onOpenChange = {
                        menuOpen = it
                        menuOpened = it
                    },
                    onCommittedSwipeHaptic = { hapticCount += 1 },
                    menu = {},
                ) { Box(Modifier.fillMaxSize()) }
            }
        }

        compose.onRoot().performTouchInput {
            val start = Offset(width * 0.15f, height * 0.5f)
            swipe(start = start, end = start + Offset(120f, 0f), durationMillis = 40)
        }

        compose.waitUntil(5_000) { menuOpened }
        assertEquals(1, hapticCount)
    }

    @Test
    fun `cancelled horizontal drag resets and the next swipe still opens`() {
        var menuOpened = false
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                var menuOpen by remember { mutableStateOf(false) }
                MenuRevealContainer(
                    isOpen = menuOpen,
                    onOpenChange = {
                        menuOpen = it
                        menuOpened = it
                    },
                    menu = {},
                ) { Box(Modifier.fillMaxSize().testTag("menuContent")) }
            }
        }

        val restingLeft = compose.onNodeWithTag("menuContent")
            .fetchSemanticsNode().boundsInRoot.left

        compose.onRoot().performTouchInput {
            val start = Offset(width * 0.1f, height * 0.5f)
            down(start)
            moveTo(start + Offset(180f, 0f), delayMillis = 40)
            cancel()
        }
        compose.waitForIdle()
        assertFalse(menuOpened)
        assertEquals(
            restingLeft,
            compose.onNodeWithTag("menuContent").fetchSemanticsNode().boundsInRoot.left,
            0.5f,
        )

        compose.onRoot().performTouchInput {
            swipe(
                start = Offset(width * 0.1f, height * 0.5f),
                end = Offset(width * 0.7f, height * 0.5f),
                durationMillis = 200,
            )
        }
        compose.waitUntil(5_000) { menuOpened }
    }

    @Test
    fun `vertical drags over task rows scroll the list without triggering actions`() {
        var menuOpened = false
        var taskActions = 0
        val target = scrollingTasks[20]

        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                var menuOpen by remember { mutableStateOf(false) }
                MenuRevealContainer(
                    isOpen = menuOpen,
                    onOpenChange = {
                        menuOpen = it
                        menuOpened = it
                    },
                    menu = {},
                ) {
                    TasksContent(
                        state = TasksUiState(loading = false, day = TODAY.toString(), tasks = scrollingTasks),
                        today = TODAY,
                        actions = TaskRowActions(
                            onTapBullet = { taskActions += 1 },
                            onOpen = { taskActions += 1 },
                            onFanAction = { _, _ -> taskActions += 1 },
                        ),
                    )
                }
            }
        }

        compose.onNodeWithText(target.title).assertDoesNotExist()
        repeat(3) {
            compose.onRoot().performTouchInput {
                swipe(
                    start = Offset(width * 0.5f, height * 0.85f),
                    end = Offset(width * 0.5f, height * 0.15f),
                    durationMillis = 400,
                )
            }
        }

        compose.onNodeWithText(target.title).assertIsDisplayed()
        assertEquals(0, taskActions)
        assertFalse(menuOpened)
    }

    @Test
    fun `right swipe over a conversation with citations opens the main menu`() {
        var menuOpened = false
        setCitationConversation { menuOpened = it }

        compose.onRoot().performTouchInput {
            swipe(
                start = Offset(width * 0.1f, height * 0.5f),
                end = Offset(width * 0.7f, height * 0.5f),
                durationMillis = 400,
            )
        }

        compose.waitUntil(5_000) { menuOpened }
    }

    @Test
    fun `left swipe from the right edge still opens the Timeline`() {
        var menuOpened = false
        setCitationConversation { menuOpened = it }

        compose.onRoot().performTouchInput {
            swipe(
                start = Offset(width - 2f, height * 0.5f),
                end = Offset(width * 0.55f, height * 0.5f),
                durationMillis = 400,
            )
        }

        compose.onNodeWithText("Timeline").assertIsDisplayed()
        compose.waitForIdle()
        assertFalse(menuOpened)
    }

    @Test
    fun `tapping a closed Timeline tab opens it above the edge swipe strip`() {
        var menuOpened = false
        setCitationConversation { menuOpened = it }
        compose.waitForIdle()

        val tabCenter = compose.onAllNodesWithTag("timelineStickyTab")[0]
            .fetchSemanticsNode().boundsInRoot.center
        compose.onRoot().performTouchInput { click(tabCenter) }

        compose.onNodeWithText("Timeline").assertIsDisplayed()
        compose.waitForIdle()
        assertFalse(menuOpened)
    }

    @Test
    fun `fast left swipe beginning on a closed Timeline tab opens it`() {
        var menuOpened = false
        setCitationConversation { menuOpened = it }
        compose.waitForIdle()

        val tabCenter = compose.onAllNodesWithTag("timelineStickyTab")[0]
            .fetchSemanticsNode().boundsInRoot.center
        compose.onRoot().performTouchInput {
            swipe(
                start = tabCenter,
                end = tabCenter - Offset(250f, 0f),
                durationMillis = 80,
            )
        }

        compose.onNodeWithText("Timeline").assertIsDisplayed()
        compose.waitForIdle()
        assertFalse(menuOpened)
    }

    @Test
    fun `left swipe beginning on the closed Timeline overflow pill opens it`() {
        var menuOpened = false
        val citations = List(24) { index ->
            sampleCitation.copy(
                documentId = "document-overflow-$index",
                ref = sampleCitation.ref.copy(documentId = "document-overflow-$index"),
            )
        }
        setCitationConversation(citations = citations) { menuOpened = it }
        compose.waitForIdle()

        val pillCenter = compose.onNodeWithTag("timelineOverflowPill")
            .fetchSemanticsNode().boundsInRoot.center
        compose.onRoot().performTouchInput {
            swipe(pillCenter, pillCenter - Offset(250f, 0f), durationMillis = 80)
        }

        compose.onNodeWithText("Timeline").assertIsDisplayed()
        assertFalse(menuOpened)
    }

    private fun setCitationConversation(
        citations: List<AgentCitation> = listOf(sampleCitation),
        onMenuOpenChange: (Boolean) -> Unit,
    ) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                var menuOpen by remember { mutableStateOf(false) }
                MenuRevealContainer(
                    isOpen = menuOpen,
                    onOpenChange = {
                        menuOpen = it
                        onMenuOpenChange(it)
                    },
                    menu = {},
                ) {
                    AgentContent(
                        state = AgentCoordinator.UiState(
                            hasClient = true,
                            sessionId = "session-example",
                            chat = AgentChatState(
                                turns = listOf(
                                    AgentTurn.User(
                                        id = "turn-user-example",
                                        text = "Is the launch checklist ready?",
                                    ),
                                    AgentTurn.Assistant(
                                        id = "turn-assistant-example",
                                        parts = listOf(
                                            AgentPart.Text("Yes. The final checklist is ready for review."),
                                        ),
                                    ),
                                ),
                                citations = citations,
                            ),
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

    private companion object {
        val TODAY: LocalDate = LocalDate.of(2026, 10, 12)

        val sampleTask = TaskDto(
            id = "task-example",
            title = "Review the Northstar launch checklist",
            scheduledFor = "2026-10-12",
        )

        val scrollingTasks = List(24) { index ->
            sampleTask.copy(id = "task-scroll-example-$index", title = "Invented task item $index")
        }

        val sampleCitation = AgentCitation(
            documentId = "document-example",
            ref = AgentDocRef(
                documentId = "document-example",
                sourceId = "notes:local",
                title = "Northstar launch notes",
            ),
            entries = listOf(
                AgentCitationEntry(
                    toolCallId = "tool-example",
                    messageId = "message-example",
                    quote = "The launch checklist is ready.",
                    note = null,
                    quoteAuthor = null,
                ),
            ),
        )
    }
}
