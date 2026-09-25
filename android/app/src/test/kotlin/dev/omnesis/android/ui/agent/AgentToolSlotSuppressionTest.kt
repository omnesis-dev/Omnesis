// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentToolResult
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Transcript suppression for silent tools. `annotate` and `cite_record` both feed the
 * citations drawer + the bubble's citation-count chip but render nothing inline in the
 * conversation flow (see [ToolCard]) — neither the tool name nor an args summary surfaces as a
 * chip/block. These tests render a real [AssistantTurn] and assert the silent tools produce no
 * visible transcript node, while ordinary text content still renders (proving the harness shows
 * what isn't suppressed).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class AgentToolSlotSuppressionTest {

    @get:Rule val compose = createComposeRule()

    private val catalog = SourceCatalog()

    private fun renderTurn(parts: List<AgentPart>, stopReason: String? = null) {
        compose.setContent {
            // Match the screenshot harness: inspection mode freezes the citing-pulse animation
            // (and any other inspection-gated motion) so the test never spins on a non-idle clock.
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme {
                    AssistantTurn(
                        turn = AgentTurn.Assistant(id = "t", parts = parts, stopReason = stopReason),
                        catalog = catalog,
                        onFlushEphemeral = {},
                        onOpenDocument = {},
                    )
                }
            }
        }
    }

    @Test
    fun cite_record_renders_no_inline_transcript_chip() {
        renderTurn(
            listOf(
                AgentPart.Tool(
                    AgentToolCall(
                        toolCallId = "cr1",
                        tool = "cite_record",
                        argsSummary = "strava_activities: 18771215030",
                        argsKnown = true,
                        result = null,
                    ),
                ),
                AgentPart.Text("You ran 5.2 km."),
            ),
        )

        // The answer text renders…
        compose.onNodeWithText("You ran 5.2 km.").assertIsDisplayed()
        // …but the cite_record call surfaces neither its tool name nor its args summary inline.
        assertEquals(0, compose.onAllNodesWithTextCount("cite_record"))
        assertEquals(0, compose.onAllNodesWithTextCount("strava_activities: 18771215030"))
    }

    @Test
    fun annotate_renders_no_inline_transcript_chip() {
        renderTurn(
            listOf(
                AgentPart.Tool(
                    AgentToolCall(
                        toolCallId = "an1",
                        tool = "annotate",
                        argsSummary = "doc-1",
                        argsKnown = true,
                        result = null,
                    ),
                ),
                AgentPart.Text("Per your notes."),
            ),
        )

        compose.onNodeWithText("Per your notes.").assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithTextCount("annotate"))
    }

    @Test
    fun finished_turn_hides_all_parallel_sql_cards() {
        val calls = (1..4).map { index ->
            AgentPart.Tool(
                AgentToolCall(
                    toolCallId = "sql-$index",
                    tool = "run_sql",
                    argsKnown = true,
                    result = AgentToolResult.SqlRows(sql = "SELECT $index"),
                ),
            )
        }
        renderTurn(calls + AgentPart.Text("The four checks agree."), stopReason = "end_turn")

        compose.onNodeWithText("The four checks agree.").assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithTextCount("Run SQL"))
    }

    @Test
    fun completed_list_loops_card_reports_outcome_then_flushes_and_disappears_once() {
        var flushCount = 0
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OmnesisTheme {
                ToolCard(
                    call = AgentToolCall(
                        toolCallId = "list-loops-1",
                        tool = "list_loops",
                        argsKnown = true,
                        result = AgentToolResult.Structured("loops.listed", kotlinx.serialization.json.JsonNull),
                    ),
                    pillRun = null,
                    catalog = catalog,
                    onFlushEphemeral = { flushCount += 1 },
                    onOpenDocument = {},
                )
            }
        }

        compose.mainClock.advanceTimeBy(400)
        compose.onNodeWithText("List loops").assertIsDisplayed()
        compose.onNodeWithText("Loops listed").assertIsDisplayed()

        compose.mainClock.advanceTimeBy(1_500)
        compose.onNodeWithText("List loops").assertDoesNotExist()
        assertEquals(1, flushCount)
        compose.mainClock.advanceTimeBy(2_000)
        assertEquals(1, flushCount)
    }

    @Test
    fun generic_result_type_is_humanized() {
        assertEquals("Loops listed", humanizeResultType("loops.listed"))
        assertEquals("Done", humanizeResultType(""))
    }

    @Test
    fun generic_ephemeral_error_flushes_and_disappears_once() {
        var flushCount = 0
        compose.mainClock.autoAdvance = false
        compose.setContent {
            OmnesisTheme {
                ToolCard(
                    call = AgentToolCall(
                        toolCallId = "list-loops-error",
                        tool = "list_loops",
                        argsKnown = true,
                        result = AgentToolResult.ErrorResult("unavailable", "Could not list loops"),
                    ),
                    pillRun = null,
                    catalog = catalog,
                    onFlushEphemeral = { flushCount += 1 },
                    onOpenDocument = {},
                )
            }
        }

        compose.mainClock.advanceTimeBy(400)
        compose.onNodeWithText("Could not list loops").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(1_500)
        compose.onNodeWithText("List loops").assertDoesNotExist()
        assertEquals(1, flushCount)
    }
}

/** Count nodes matching exact [text] without asserting existence — 0 when suppressed. */
private fun ComposeContentTestRule.onAllNodesWithTextCount(text: String): Int =
    onAllNodesWithText(text).fetchSemanticsNodes().size
