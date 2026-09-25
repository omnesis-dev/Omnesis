// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.BriefOriginSnapshot
import dev.omnesis.android.transport.dto.ConversationOrigin
import dev.omnesis.android.transport.dto.WatchFiringOriginSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * An anchored thread — one opened from a brief or a watch firing — is a reply to a card, and
 * the gateway hides the folded run transcript that seeded it. On a thread nobody has replied to
 * yet that seed is the *whole* transcript, so there are no visible turns at all: the card is the
 * only thing standing between the reader and a screen that looks broken.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentOriginCardTest {

    @get:Rule
    val compose = createComposeRule()

    private val briefOrigin = ConversationOrigin(
        kind = "brief",
        brief = BriefOriginSnapshot(
            title = "Two invoices quote the same reference",
            description = "Studio Northstar billed reference NS-8841 twice.",
            body = "The second invoice arrived nine days after the first.",
        ),
        seedMessageCount = 2,
    )

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

    @Test
    fun a_recognised_origin_carrying_its_snapshot_has_a_card() {
        assertTrue(hasContextCard(briefOrigin))
        assertTrue(hasContextCard(watchOrigin))
    }

    /**
     * Without the snapshot there is nothing to draw, so the seeded prefix must stay visible
     * rather than be hidden behind a card that never appears.
     */
    @Test
    fun an_origin_without_its_snapshot_or_of_an_unknown_kind_has_no_card() {
        assertFalse(hasContextCard(null))
        assertFalse(hasContextCard(briefOrigin.copy(brief = null)))
        assertFalse(hasContextCard(watchOrigin.copy(watch = null)))
        assertFalse(hasContextCard(ConversationOrigin(kind = "something_later", seedMessageCount = 2)))
    }

    @Test
    fun a_brief_thread_with_nothing_said_yet_shows_its_card_and_not_the_blank_chat() {
        showAgent(briefOrigin)

        compose.onNodeWithText("Two invoices quote the same reference").assertIsDisplayed()
        compose.onNodeWithText("Studio Northstar billed reference NS-8841 twice.").assertIsDisplayed()
        compose.onNodeWithText("Ask Omnesis about your corpus").assertDoesNotExist()
    }

    /**
     * The toggle speaks as one control, so its label is the accessible name rather than the two
     * words drawn inside it.
     */
    @Test
    fun a_brief_card_keeps_its_body_behind_a_disclosure() {
        showAgent(briefOrigin)

        compose.onNodeWithText("The second invoice arrived nine days after the first.").assertDoesNotExist()
        compose.onNodeWithContentDescription("Show the brief's details").performClick()
        compose.onNodeWithText("The second invoice arrived nine days after the first.").assertIsDisplayed()
        compose.onNodeWithContentDescription("Hide the brief's details").assertIsDisplayed()
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
        showAgent(watchOrigin) { openedWatchId = it }

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
        showAgent(watchOrigin.copy(watchId = null)) { openedWatchId = it }

        compose.onNodeWithText("a deposit clears").assertHasNoClickAction()

        assertEquals(null, openedWatchId)
    }

    /** A plain thread with nothing in it is still the blank chat it always was. */
    @Test
    fun a_thread_with_no_origin_still_shows_the_blank_chat() {
        showAgent(origin = null)

        compose.onNodeWithText("Ask Omnesis about your corpus").assertIsDisplayed()
    }

    private fun showAgent(origin: ConversationOrigin?, onOpenWatch: ((String) -> Unit)? = null) {
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
                )
            }
        }
    }
}
