// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.setup.SetupStatusKind
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.flow.SetupBusy
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.ui.SetupProgress
import dev.omnesis.android.setup.ui.SetupStepPage
import dev.omnesis.android.setup.ui.SetupStepPageActions
import dev.omnesis.android.setup.ui.SetupStepPageUi
import dev.omnesis.android.setup.ui.SetupWhatsSentDisclosure
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the Call Log setup page — introduction,
 * waiting on Android, and each outcome it can reach — and the Settings
 * "What's sent" disclosure, each in light and dark. All counts are invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class CallLogSetupScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/${name}_${if (dark) "dark" else "light"}.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private val noActions = SetupStepPageActions({}, {}, {}, {}, {}, {}, {})

    private fun page(
        outcome: SetupOutcome? = null,
        busy: SetupBusy = SetupBusy.IDLE,
        statusLine: SetupStatusLine? = null,
    ): @Composable () -> Unit = {
        SetupStepPage(
            ui = SetupStepPageUi(
                copy = CallLogSetupCopy,
                progress = SetupProgress(total = 5, current = 4),
                outcome = outcome,
                busy = busy,
                statusLine = statusLine,
                nextLabel = "Finish",
            ),
            actions = noActions,
        )
    }

    private val waiting = page(busy = SetupBusy.WAITING_FOR_SYSTEM)
    private val on = page(SetupOutcome.On, statusLine = SetupStatusLine("Last sync failed", SetupStatusKind.ATTENTION))
    private val notAllowed = page(SetupOutcome.NotAllowed)
    private val failed = page(SetupOutcome.Failed(null))

    private val whatsSent: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg)) {
            SetupWhatsSentDisclosure(CallLogSetupCopy, initiallyExpanded = true)
        }
    }

    @Test fun setup_page_light() = capture("call_log_setup_page", dark = false, page())
    @Test fun setup_page_dark() = capture("call_log_setup_page", dark = true, page())

    @Test fun setup_waiting_light() = capture("call_log_setup_waiting", dark = false, waiting)
    @Test fun setup_waiting_dark() = capture("call_log_setup_waiting", dark = true, waiting)

    @Test fun setup_on_light() = capture("call_log_setup_on", dark = false, on)
    @Test fun setup_on_dark() = capture("call_log_setup_on", dark = true, on)

    @Test fun setup_not_allowed_light() = capture("call_log_setup_not_allowed", dark = false, notAllowed)
    @Test fun setup_not_allowed_dark() = capture("call_log_setup_not_allowed", dark = true, notAllowed)

    @Test fun setup_failed_light() = capture("call_log_setup_failed", dark = false, failed)
    @Test fun setup_failed_dark() = capture("call_log_setup_failed", dark = true, failed)

    @Test fun settings_whats_sent_light() = capture("call_log_settings_whats_sent", dark = false, whatsSent)
    @Test fun settings_whats_sent_dark() = capture("call_log_settings_whats_sent", dark = true, whatsSent)
}
