// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import android.view.View
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.ui.agent.AgentComposer
import dev.omnesis.android.ui.agent.AgentContent
import dev.omnesis.android.ui.agent.AgentCoordinator
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AgentComposerImeScreenshotTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun composerAboveImeLight() = capture("agent_composer_ime_light", dark = false)

    @Test
    fun composerAboveImeDark() = capture("agent_composer_ime_dark", dark = true)

    @Test
    fun landingAboveImeLight() = captureLanding("agent_landing_ime_light", dark = false)

    @Test
    fun landingAboveImeDark() = captureLanding("agent_landing_ime_dark", dark = true)

    private fun capture(name: String, dark: Boolean) {
        lateinit var composeView: View
        var density = 1f
        compose.setContent {
            composeView = LocalView.current
            density = LocalDensity.current.density
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(OmTheme.colors.bgPrimary),
                    ) {
                        SimulatedKeyboard(Modifier.align(Alignment.BottomCenter))
                        AgentComposer(
                            busy = false,
                            enabled = true,
                            onSend = { _, _ -> },
                            onStop = {},
                            modifier = Modifier.align(Alignment.BottomCenter),
                            initialText = "Summarize the Northstar project",
                        )
                    }
                }
            }
        }

        dispatchInsetsAndCapture(composeView, density, KeyboardHeight, name)
    }

    private fun captureLanding(name: String, dark: Boolean) {
        lateinit var composeView: View
        var density = 1f
        compose.setContent {
            composeView = LocalView.current
            density = LocalDensity.current.density
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
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
                        SimulatedKeyboard(
                            modifier = Modifier.align(Alignment.BottomCenter),
                            height = LandingKeyboardHeight,
                        )
                    }
                }
            }
        }

        dispatchInsetsAndCapture(composeView, density, LandingKeyboardHeight, name)
    }

    private fun dispatchInsetsAndCapture(
        composeView: View,
        density: Float,
        keyboardHeight: Dp,
        name: String,
    ) {
        val imeHeightPx = (keyboardHeight.value * density).toInt()
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
                    .setVisible(WindowInsetsCompat.Type.ime(), true)
                    .build(),
            )
        }
        compose.waitForIdle()
        compose.onRoot().captureRoboImage("src/test/roborazzi/$name.png")
    }

    @Composable
    private fun SimulatedKeyboard(
        modifier: Modifier = Modifier,
        height: Dp = KeyboardHeight,
    ) {
        val colors = MaterialTheme.colorScheme
        Column(
            modifier
                .fillMaxWidth()
                .height(height)
                .background(colors.surfaceContainer)
                .border(width = 1.dp, color = colors.outlineVariant)
                .padding(horizontal = 8.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            repeat(4) { row ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(7.dp),
                ) {
                    val keyCount = if (row == 3) 3 else 10
                    repeat(keyCount) {
                        Spacer(
                            Modifier
                                .weight(if (row == 3 && it == 1) 4f else 1f)
                                .fillMaxSize()
                                .background(colors.surfaceContainerHighest, RoundedCornerShape(6.dp)),
                        )
                    }
                }
            }
        }
    }

    private companion object {
        val KeyboardHeight = 300.dp
        val LandingKeyboardHeight = 400.dp
    }
}
