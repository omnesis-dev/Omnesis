// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.click
import androidx.compose.ui.test.filter
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onChildren
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.unit.LayoutDirection
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.BriefKindDto
import dev.omnesis.android.transport.dto.BriefReadStateDto
import dev.omnesis.android.transport.dto.BriefRecordDto
import dev.omnesis.android.ui.agent.AgentChatState
import dev.omnesis.android.ui.agent.AgentCitation
import dev.omnesis.android.ui.agent.AgentCitationEntry
import dev.omnesis.android.ui.agent.AgentContent
import dev.omnesis.android.ui.agent.AgentCoordinator
import dev.omnesis.android.ui.agent.AgentPart
import dev.omnesis.android.ui.agent.AgentTurn
import dev.omnesis.android.ui.briefs.BriefsFeedState
import dev.omnesis.android.ui.briefs.BriefsListContent
import java.time.Instant
import kotlin.math.abs
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
    fun `right swipe over a brief row opens the menu without clearing the brief`() {
        var menuOpened = false
        var quickClearCount = 0
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
                    BriefsListContent(
                        feed = BriefsFeedState().replacing(listOf(sampleBrief)),
                        loading = false,
                        loadError = null,
                        onOpen = {},
                        onQuickClear = { quickClearCount += 1 },
                        onAsk = {},
                        onMoreOptions = {},
                        onRetry = {},
                        onRefresh = {},
                        now = Instant.parse("2026-08-20T08:00:00Z"),
                    )
                }
            }
        }

        compose.onNodeWithText(sampleBrief.title).performTouchInput {
            swipe(
                start = Offset(width * 0.1f, centerY),
                end = Offset(width * 0.9f, centerY),
                durationMillis = 400,
            )
        }

        compose.waitUntil(5_000) { menuOpened }
        assertEquals(0, quickClearCount)
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
    fun `brief swipe background matches the full foreground row height`() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                BriefsListContent(
                    feed = BriefsFeedState().replacing(listOf(sampleBrief)),
                    loading = false,
                    loadError = null,
                    onOpen = {},
                    onQuickClear = {},
                    onAsk = {},
                    onMoreOptions = {},
                    onRetry = {},
                    onRefresh = {},
                    now = Instant.parse("2026-08-20T08:00:00Z"),
                )
            }
        }

        val backgroundBounds = compose.onNodeWithTag("briefSwipeBackground")
            .fetchSemanticsNode().boundsInRoot
        val foregroundBounds = compose.onNodeWithTag("briefSwipeForeground")
            .fetchSemanticsNode().boundsInRoot

        assertEquals(foregroundBounds.top, backgroundBounds.top, 0.5f)
        assertEquals(foregroundBounds.bottom, backgroundBounds.bottom, 0.5f)
    }

    @Test
    fun `brief long press offers only ask and dictate`() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                BriefsListContent(
                    feed = BriefsFeedState().replacing(listOf(sampleBrief)),
                    loading = false,
                    loadError = null,
                    onOpen = {}, onQuickClear = {}, onAsk = {}, onDictate = {},
                    onMoreOptions = {}, onRetry = {}, onRefresh = {},
                )
            }
        }

        compose.onNodeWithText(sampleBrief.title).performTouchInput { longClick() }
        val menuItems = compose.onNodeWithTag("briefLongPressMenu").onChildren()
        menuItems.filter(hasText("Ask")).assertCountEquals(1)
        menuItems.filter(hasText("Dictate")).assertCountEquals(1)
        menuItems.filter(hasText("More…")).assertCountEquals(0)
    }

    @Test
    fun `covered swipe buttons are hidden while the row exposes named accessibility actions`() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                BriefsListContent(
                    feed = BriefsFeedState().replacing(listOf(sampleBrief)),
                    loading = false,
                    loadError = null,
                    onOpen = {}, onQuickClear = {}, onAsk = {}, onDictate = {},
                    onMoreOptions = {}, onRetry = {}, onRefresh = {},
                )
            }
        }

        compose.onAllNodesWithTag("briefSwipeMore").assertCountEquals(0)
        compose.onAllNodesWithTag("briefSwipeClear").assertCountEquals(0)
        val actions = compose.onNodeWithText(sampleBrief.title).fetchSemanticsNode()
            .config[SemanticsActions.CustomActions]
            .map { it.label }
        assertEquals(listOf("Ask", "Dictate", "More", "Got it"), actions)
    }

    @Test
    fun `short trailing swipe reveals More without quick clearing`() {
        var moreCount = 0
        var quickClearCount = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                BriefsListContent(
                    feed = BriefsFeedState().replacing(listOf(sampleBrief)),
                    loading = false,
                    loadError = null,
                    onOpen = {},
                    onQuickClear = { quickClearCount += 1 },
                    onAsk = {},
                    onMoreOptions = { moreCount += 1 },
                    onRetry = {}, onRefresh = {},
                )
            }
        }

        compose.onNodeWithText(sampleBrief.title).performTouchInput {
            swipe(
                start = Offset(width * 0.8f, centerY),
                end = Offset(width * 0.45f, centerY),
                durationMillis = 500,
            )
        }
        compose.waitForIdle()
        assertEquals(0, quickClearCount)
        compose.onNodeWithTag("briefSwipeMore").performClick()
        assertEquals(1, moreCount)
        assertEquals(0, quickClearCount)
    }

    @Test
    fun `revealing a second row closes the first row actions`() {
        val second = sampleBrief.copy(id = "brief-2", title = "Plan the studio handover")
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                BriefsListContent(
                    feed = BriefsFeedState().replacing(listOf(sampleBrief, second)),
                    loading = false,
                    loadError = null,
                    onOpen = {}, onQuickClear = {}, onAsk = {}, onMoreOptions = {},
                    onRetry = {}, onRefresh = {},
                )
            }
        }

        fun reveal(title: String) {
            compose.onNodeWithText(title).performTouchInput {
                swipe(
                    start = Offset(width * 0.8f, centerY),
                    end = Offset(width * 0.45f, centerY),
                    durationMillis = 500,
                )
            }
            compose.waitForIdle()
        }

        reveal(sampleBrief.title)
        compose.onAllNodesWithTag("briefSwipeMore").assertCountEquals(1)
        reveal(second.title)
        compose.onAllNodesWithTag("briefSwipeMore").assertCountEquals(1)
    }

    @Test
    fun `physical left swipe clears a brief in RTL without opening the menu`() {
        var menuOpened = false
        var quickClearCount = 0

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
                    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                        BriefsListContent(
                            feed = BriefsFeedState().replacing(listOf(sampleBrief)),
                            loading = false,
                            loadError = null,
                            onOpen = {},
                            onQuickClear = { quickClearCount += 1 },
                            onAsk = {},
                            onMoreOptions = {},
                            onRetry = {},
                            onRefresh = {},
                            now = Instant.parse("2026-08-20T08:00:00Z"),
                        )
                    }
                }
            }
        }

        compose.onNodeWithText(sampleBrief.title).performTouchInput {
            swipe(
                start = Offset(width * 0.9f, centerY),
                end = Offset(width * 0.1f, centerY),
                durationMillis = 400,
            )
        }

        compose.waitUntil(5_000) { quickClearCount == 1 }
        compose.waitForIdle()
        assertFalse(menuOpened)
    }

    @Test
    fun `short left drag settles the brief back without opening the menu`() {
        var menuOpened = false
        var quickClearCount = 0

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
                    BriefsListContent(
                        feed = BriefsFeedState().replacing(listOf(sampleBrief)),
                        loading = false,
                        loadError = null,
                        onOpen = {},
                        onQuickClear = { quickClearCount += 1 },
                        onAsk = {},
                        onMoreOptions = {},
                        onRetry = {},
                        onRefresh = {},
                        now = Instant.parse("2026-08-20T08:00:00Z"),
                    )
                }
            }
        }

        val originalLeft = compose.onNodeWithText(sampleBrief.title)
            .fetchSemanticsNode().boundsInRoot.left

        compose.onNodeWithText(sampleBrief.title).performTouchInput {
            swipe(
                start = Offset(width * 0.6f, centerY),
                end = Offset(width * 0.5f, centerY),
                durationMillis = 1_000,
            )
        }

        compose.waitUntil(5_000) {
            abs(
                compose.onNodeWithText(sampleBrief.title)
                    .fetchSemanticsNode().boundsInRoot.left - originalLeft,
            ) < 1f
        }
        compose.onNodeWithText(sampleBrief.title).assertIsDisplayed()
        assertEquals(0, quickClearCount)
        assertFalse(menuOpened)
    }

    @Test
    fun `vertical drags over brief rows scroll the feed without triggering actions`() {
        var menuOpened = false
        var quickClearCount = 0
        val target = scrollingBriefs[15]

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
                    BriefsListContent(
                        feed = BriefsFeedState().replacing(scrollingBriefs),
                        loading = false,
                        loadError = null,
                        onOpen = {},
                        onQuickClear = { quickClearCount += 1 },
                        onAsk = {},
                        onMoreOptions = {},
                        onRetry = {},
                        onRefresh = {},
                        now = Instant.parse("2026-08-20T08:00:00Z"),
                    )
                }
            }
        }

        compose.onNodeWithText(target.title).assertDoesNotExist()
        repeat(2) {
            compose.onRoot().performTouchInput {
                swipe(
                    start = Offset(width * 0.5f, height * 0.85f),
                    end = Offset(width * 0.5f, height * 0.15f),
                    durationMillis = 400,
                )
            }
        }

        compose.onNodeWithText(target.title).assertIsDisplayed()
        assertEquals(0, quickClearCount)
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
        val sampleBrief = BriefRecordDto(
            id = "brief-example",
            kind = BriefKindDto.INFO,
            state = BriefReadStateDto.UNREAD,
            title = "Review the Northstar launch checklist",
            description = "The final checklist is ready for review.",
            createdAt = "2026-08-20T07:00:00Z",
        )

        val scrollingBriefs = List(24) { index ->
            sampleBrief.copy(
                id = "brief-scroll-example-$index",
                title = "Invented brief item $index",
            )
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
