// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A sub-agent card is a LIVE in-flight marker, not a transcript record: once the parent
 * turn ends the answer it fed into is written and the card folds away, leaving the report
 * the room. Parity with the portal (`renderPart(..., turnDone)`) and iOS (`if !turnDone`).
 *
 * The fold hangs off the turn's `stopReason` — the same done-signal the thinking block
 * fades on — so this drives it through the real [AssistantTurn] renderer rather than
 * asserting on the reducer, which never removes the part.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentSubagentCardFoldTest {

    @get:Rule val compose = createComposeRule()

    private fun turn(stopReason: String?, status: String?) = AgentTurn.Assistant(
        id = "a1",
        parts = listOf(
            AgentPart.Subagent(
                AgentSubagentCard(
                    subagentId = "sub-1",
                    specialist = "warranty-sweep",
                    title = "Warranty and service history",
                    task = "Trace the appliance cover record",
                    status = status,
                    summary = if (status == null) "" else "Every claim is documented.",
                    tokens = 4200,
                ),
            ),
            AgentPart.Text("Here is the cover history."),
        ),
        stopReason = stopReason,
    )

    /**
     * [status] `null` is a card still running — the shape the reported bug left stranded on the
     * transcript with its working dots up; `"complete"` is one that finished mid-turn.
     */
    private fun assertFoldsAtTurnEnd(status: String?) {
        val stopReason = mutableStateOf<String?>(null)
        compose.setContent {
            // Load-bearing, not cosmetic: AssistantTurn runs the citing pulse and the thinking
            // shimmer for a live trailing part, and outside inspection those infinite animations
            // keep Compose non-idle so `waitForIdle` never returns. The fold itself is a plain
            // `if`, which inspection mode cannot freeze, so the assertions stay honest.
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = true) {
                    AssistantTurn(
                        turn(stopReason.value, status),
                        catalog = SourceCatalog(),
                        onFlushEphemeral = {},
                        onOpenDocument = {},
                    )
                }
            }
        }

        compose.onNodeWithText("Warranty and service history").assertExists()
        compose.onNodeWithText("Here is the cover history.").assertExists()

        stopReason.value = "end_turn"
        compose.waitForIdle()

        compose.onNodeWithText("Warranty and service history").assertDoesNotExist()
        compose.onNodeWithText("Here is the cover history.").assertExists()
    }

    @Test fun a_finished_card_folds_once_the_turn_ends() = assertFoldsAtTurnEnd(status = "complete")

    @Test fun a_still_running_card_folds_once_the_turn_ends() = assertFoldsAtTurnEnd(status = null)
}
