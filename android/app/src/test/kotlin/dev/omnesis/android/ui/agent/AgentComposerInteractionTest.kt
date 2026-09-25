// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentComposerInteractionTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun focusedComposerStaysAboveTheSoftwareKeyboard() {
        lateinit var composeView: View
        var density = 1f
        var expectedGapPx = 0f
        compose.setContent {
            composeView = LocalView.current
            density = LocalDensity.current.density
            OmnesisTheme(darkTheme = false) {
                expectedGapPx = with(LocalDensity.current) { OmTheme.spacing.sm.toPx() }
                Box(Modifier.fillMaxSize()) {
                    AgentComposer(
                        busy = false,
                        enabled = true,
                        onSend = { _, _ -> },
                        onStop = {},
                        modifier = Modifier.align(Alignment.BottomCenter),
                        requestFocus = true,
                    )
                }
            }
        }

        compose.onNode(hasSetTextAction()).assertIsFocused()
        val imeHeightPx = (300 * density).toInt()
        val navigationBarHeightPx = (24 * density).toInt()
        compose.runOnUiThread {
            ViewCompat.dispatchApplyWindowInsets(
                composeView,
                WindowInsetsCompat.Builder()
                    .setInsets(
                        WindowInsetsCompat.Type.navigationBars(),
                        Insets.of(0, 0, 0, navigationBarHeightPx),
                    )
                    .setInsets(
                        WindowInsetsCompat.Type.ime(),
                        Insets.of(0, 0, 0, imeHeightPx),
                    )
                    .setVisible(WindowInsetsCompat.Type.ime(), true)
                    .build(),
            )
        }
        compose.waitForIdle()

        val keyboardTop = compose.onRoot().fetchSemanticsNode().boundsInRoot.bottom - imeHeightPx
        val composerBottom = compose.onNodeWithTag("agentComposerPill")
            .fetchSemanticsNode().boundsInRoot.bottom
        val composerGap = keyboardTop - composerBottom
        assertTrue(
            "Composer bottom $composerBottom should be above keyboard top $keyboardTop",
            composerBottom <= keyboardTop,
        )
        assertTrue(
            "Composer gap $composerGap should retain the 8dp bottom margin ($expectedGapPx px)",
            composerGap in (expectedGapPx - 1f)..(expectedGapPx + 1f),
        )
    }

    @Test
    fun tappingArmedCommandPillDismissesIt() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AgentComposer(
                    busy = false,
                    enabled = true,
                    onSend = { _, _ -> },
                    onStop = {},
                    initialArmedCommand = SlashCommand.byId("deep-research"),
                )
            }
        }

        val dismiss = compose.onNodeWithContentDescription("Dismiss Deep Research (beta)")
        dismiss.assertIsDisplayed().assertHasClickAction().performClick()
        dismiss.assertDoesNotExist()
    }

    @Test
    fun imeSendWhileBusyKeepsDraftUntilTurnSettles() {
        val busy = mutableStateOf(true)
        val sent = mutableListOf<String>()
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AgentComposer(
                    busy = busy.value,
                    enabled = true,
                    onSend = { text, _ -> sent += text },
                    onStop = {},
                    initialText = "Draft follow-up",
                )
            }
        }

        compose.onNodeWithText("Draft follow-up").performImeAction()
        compose.runOnIdle { check(sent.isEmpty()) }
        compose.onNodeWithText("Draft follow-up").assertIsDisplayed()

        compose.runOnIdle { busy.value = false }
        compose.onNodeWithText("Draft follow-up").performImeAction()
        compose.runOnIdle { check(sent == listOf("Draft follow-up")) }
        compose.onNodeWithText("Draft follow-up").assertDoesNotExist()
    }

    @Test
    fun actionErrorCanBeDismissed() {
        var dismissed = false
        val message = "Stop failed: Can't reach the gateway."
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AgentActionErrorBanner(
                    message = message,
                    onDismiss = { dismissed = true },
                )
            }
        }

        compose.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Assertive),
        ).assertIsDisplayed()
        compose.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.Error, message),
        ).assertIsDisplayed()
        compose.onNodeWithContentDescription("Dismiss error").performClick()
        compose.runOnIdle { check(dismissed) }
    }
}
