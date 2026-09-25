// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h720dp-xxhdpi")
class AgentLandingImeTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun landingContentStaysAboveComposerWhenSoftwareKeyboardIsVisible() {
        assertLandingContentAboveComposer(imeHeightDp = 300, fontScale = 1f)
    }

    @Test
    fun largeLandingContentStaysAboveComposerWhenSoftwareKeyboardIsVisible() {
        assertLandingContentAboveComposer(imeHeightDp = 400, fontScale = 2f)
    }

    @Test
    fun openingAndClosingKeyboardPreservesFocusedDraftInResumedEmptyLanding() {
        lateinit var composeView: View
        var density = 1f
        compose.setContent {
            composeView = LocalView.current
            density = LocalDensity.current.density
            OmnesisTheme(darkTheme = false) {
                Box(Modifier.fillMaxSize()) {
                    AgentContent(
                        state = AgentCoordinator.UiState(
                            hasClient = true,
                            sessionId = "session-example",
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

        val input = compose.onNode(hasSetTextAction())
        input.performClick()
        input.performTextInput("Draft survives keyboard changes")
        input.assertIsFocused().assertTextContains("Draft survives keyboard changes")

        val imeHeightPx = (300 * density).toInt()
        dispatchInsets(composeView, density, imeHeightPx, imeVisible = true)
        compose.waitForIdle()
        input.assertIsFocused().assertTextContains("Draft survives keyboard changes")

        dispatchInsets(composeView, density, imeHeightPx = 0, imeVisible = false)
        compose.waitForIdle()
        input.assertIsFocused().assertTextContains("Draft survives keyboard changes")
    }

    private fun assertLandingContentAboveComposer(imeHeightDp: Int, fontScale: Float) {
        lateinit var composeView: View
        var density = 1f
        compose.setContent {
            composeView = LocalView.current
            val baseDensity = LocalDensity.current
            density = baseDensity.density
            CompositionLocalProvider(
                LocalDensity provides Density(baseDensity.density, fontScale),
            ) {
                OmnesisTheme(darkTheme = false) {
                    Box(Modifier.fillMaxSize()) {
                        AgentContent(
                            state = AgentCoordinator.UiState(hasClient = true),
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

        compose.onNode(hasSetTextAction()).assertIsFocused()
        val imeHeightPx = (imeHeightDp * density).toInt()
        dispatchInsets(composeView, density, imeHeightPx, imeVisible = true)
        compose.waitForIdle()

        val mark = compose.onNodeWithTag("agentLandingMark").assertIsDisplayed()
            .fetchSemanticsNode().boundsInRoot
        val headlineNode = compose.onNodeWithText("Ask Omnesis about your corpus").assertIsDisplayed()
        val headline = headlineNode.fetchSemanticsNode().boundsInRoot
        val composer = compose.onNodeWithTag("agentComposerPill").assertIsDisplayed()
            .fetchSemanticsNode().boundsInRoot
        val keyboardTop = compose.onRoot().fetchSemanticsNode().boundsInRoot.bottom - imeHeightPx

        val textLayouts = mutableListOf<TextLayoutResult>()
        headlineNode.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action ->
            action(textLayouts)
        }
        val textLayout = textLayouts.single()

        assertTrue("Landing mark $mark should remain on screen", mark.top >= 0f)
        assertTrue("Landing mark $mark should retain visible height", mark.bottom > mark.top)
        assertTrue("Landing mark $mark should sit above headline $headline", mark.bottom <= headline.top)
        assertTrue("Headline $headline should remain on screen", headline.top >= 0f)
        assertTrue(
            "Headline $headline should leave space above composer $composer",
            headline.bottom + 4 * density <= composer.top,
        )
        assertTrue("Composer $composer should sit above keyboard top $keyboardTop", composer.bottom <= keyboardTop)
        assertTrue("Headline should fit in two lines", textLayout.lineCount <= 2)
        assertTrue(
            "Headline should not be ellipsized",
            (0 until textLayout.lineCount).none(textLayout::isLineEllipsized),
        )
        assertTrue(
            "Headline should lay out every character",
            textLayout.getLineEnd(textLayout.lineCount - 1, visibleEnd = false) ==
                "Ask Omnesis about your corpus".length,
        )
        assertTrue(
            "Headline layout should be fully visible inside $headline",
            textLayout.size.width <= headline.width + 1f &&
                textLayout.size.height <= headline.height + 1f,
        )
    }

    private fun dispatchInsets(
        composeView: View,
        density: Float,
        imeHeightPx: Int,
        imeVisible: Boolean,
    ) {
        compose.runOnUiThread {
            ViewCompat.dispatchApplyWindowInsets(
                composeView,
                WindowInsetsCompat.Builder()
                    .setInsets(
                        WindowInsetsCompat.Type.navigationBars(),
                        Insets.of(0, 0, 0, (24 * density).toInt()),
                    )
                    .setInsets(
                        WindowInsetsCompat.Type.ime(),
                        Insets.of(0, 0, 0, imeHeightPx),
                    )
                    .setVisible(WindowInsetsCompat.Type.ime(), imeVisible)
                    .build(),
            )
        }
    }
}
