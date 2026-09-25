// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage.setup

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
 * Render-review screenshots for the App Usage page of the phone setup flow —
 * the disclosure page, the wait on the usage-access screen, each outcome it
 * can end in — and the Settings "What's sent" disclosure, each in light and
 * dark. All fixture values are invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AppUsageSetupScreenshotTest {

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
                copy = AppUsageSetupCopy,
                progress = SetupProgress(total = 4, current = 2),
                outcome = outcome,
                busy = busy,
                statusLine = statusLine,
            ),
            actions = noActions,
        )
    }

    private val waiting = page(busy = SetupBusy.WAITING_FOR_SYSTEM)
    private val on = page(outcome = SetupOutcome.On, statusLine = SetupStatusLine("Up to date", SetupStatusKind.UP_TO_DATE))
    private val notAllowed = page(outcome = SetupOutcome.NotAllowed)
    private val failed = page(outcome = SetupOutcome.Failed("The gateway could not finish enabling this phone. Try again."))

    private val disclosure: @Composable () -> Unit = {
        Column(
            Modifier
                .fillMaxWidth()
                .background(OmTheme.colors.bgPrimary)
                .padding(OmSpacing.lg),
        ) {
            SetupWhatsSentDisclosure(AppUsageSetupCopy, initiallyExpanded = true)
        }
    }

    @Test fun setup_page_light() = capture("app_usage_setup_page", dark = false, page())
    @Test fun setup_page_dark() = capture("app_usage_setup_page", dark = true, page())

    @Test fun setup_waiting_light() = capture("app_usage_setup_waiting", dark = false, waiting)
    @Test fun setup_waiting_dark() = capture("app_usage_setup_waiting", dark = true, waiting)

    @Test fun setup_on_light() = capture("app_usage_setup_on", dark = false, on)
    @Test fun setup_on_dark() = capture("app_usage_setup_on", dark = true, on)

    @Test fun setup_not_allowed_light() = capture("app_usage_setup_not_allowed", dark = false, notAllowed)
    @Test fun setup_not_allowed_dark() = capture("app_usage_setup_not_allowed", dark = true, notAllowed)

    @Test fun setup_failed_light() = capture("app_usage_setup_failed", dark = false, failed)
    @Test fun setup_failed_dark() = capture("app_usage_setup_failed", dark = true, failed)

    @Test fun settings_whats_sent_light() = capture("app_usage_settings_whats_sent", dark = false, disclosure)
    @Test fun settings_whats_sent_dark() = capture("app_usage_settings_whats_sent", dark = true, disclosure)
}
