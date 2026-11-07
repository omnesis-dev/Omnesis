// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentToolResult
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Screenshot captures run against the wall clock, so a capture that stalls on a slow runner must
 * not photograph a later state than its golden. Advancing well past every timer here stands in for
 * that stall: frozen, the transcript keeps its first state; live, the same timers fire, which is
 * the race this guards against and shows the freeze doesn't reach production behaviour.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentTimersFrozenTest {

    @get:Rule val compose = createComposeRule()

    private val document = AgentToolCall(
        toolCallId = "t-document",
        tool = "fetch_document",
        argsKnown = true,
        result = AgentToolResult.DocumentResult(
            ref = AgentDocRef(documentId = "d1", sourceId = "notes:local", title = "Fictional note"),
        ),
    )

    private val sql = AgentToolCall(
        toolCallId = "t-sql",
        tool = "run_sql",
        argsKnown = true,
        result = AgentToolResult.SqlRows(
            sql = "SELECT 1",
            columns = listOf("n"),
            rows = emptyList(),
            rowCount = 0,
            sources = emptyList(),
            subjects = emptyList(),
        ),
    )

    /** Renders [call] followed by the working dots, then runs far past every timer. */
    private fun renderPastEveryTimer(call: AgentToolCall, frozen: Boolean): Int {
        var flushes = 0
        compose.mainClock.autoAdvance = false
        compose.setContent {
            CompositionLocalProvider(
                LocalInspectionMode provides true,
                LocalAgentTimersFrozen provides frozen,
            ) {
                OmnesisTheme(darkTheme = true) {
                    Column {
                        ToolCard(
                            call = call,
                            pillRun = null,
                            catalog = SourceCatalog(),
                            onFlushEphemeral = { flushes += 1 },
                            onOpenDocument = {},
                        )
                        if (rememberWorkingDotsRevealed(active = true, revision = 0)) {
                            WorkingDots(Modifier.testTag(DOTS))
                        }
                    }
                }
            }
        }
        compose.mainClock.advanceTimeBy(FAR_PAST_EVERY_TIMER_MS)
        compose.waitForIdle()
        return flushes
    }

    @Test fun a_frozen_document_card_stays_and_the_dots_stay_hidden() {
        val flushes = renderPastEveryTimer(document, frozen = true)
        compose.onNodeWithText("Open document").assertIsDisplayed()
        compose.onNodeWithTag(DOTS).assertDoesNotExist()
        assertEquals(0, flushes)
    }

    @Test fun a_frozen_sql_card_stays_and_the_dots_stay_hidden() {
        val flushes = renderPastEveryTimer(sql, frozen = true)
        compose.onNodeWithText("Run SQL").assertIsDisplayed()
        compose.onNodeWithTag(DOTS).assertDoesNotExist()
        assertEquals(0, flushes)
    }

    @Test fun live_timers_still_dismiss_the_document_card_and_reveal_the_dots() {
        val flushes = renderPastEveryTimer(document, frozen = false)
        compose.onNodeWithText("Open document").assertDoesNotExist()
        compose.onNodeWithTag(DOTS).assertIsDisplayed()
        assertEquals(1, flushes)
    }

    @Test fun live_timers_still_dismiss_the_sql_card() {
        val flushes = renderPastEveryTimer(sql, frozen = false)
        compose.onNodeWithText("Run SQL").assertDoesNotExist()
        assertEquals(1, flushes)
    }

    private companion object {
        const val DOTS = "workingDots"
        const val FAR_PAST_EVERY_TIMER_MS = 10_000L
    }
}
