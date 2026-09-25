// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.setup.SetupStatusKind
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.flow.SetupBusy
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.hostedSourceChoices
import dev.omnesis.android.setup.ui.SetupProgress
import dev.omnesis.android.setup.ui.SetupStepPage
import dev.omnesis.android.setup.ui.SetupStepPageActions
import dev.omnesis.android.setup.ui.SetupStepPageUi
import dev.omnesis.android.setup.ui.SetupWhatsSentDisclosure
import dev.omnesis.android.transport.SourceMultiDeviceMode
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the Photos page of the phone setup flow — the
 * disclosure with its illustration, the busy agreement, and each outcome
 * Photos can end in — plus the "What's sent" disclosure on its Settings card,
 * each in light and dark. Counts and messages are invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PhotosSetupScreenshotTest {

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
        copy: SetupStepCopy = PhotosSetupCopy,
    ): @Composable () -> Unit = {
        SetupStepPage(
            ui = SetupStepPageUi(
                copy = copy,
                progress = SetupProgress(total = 3, current = 1),
                outcome = outcome,
                busy = busy,
                statusLine = statusLine,
            ),
            actions = noActions,
            illustration = { PhotosSetupIllustration() },
        )
    }

    private val on = page(SetupOutcome.On, statusLine = SetupStatusLine("1,120 photos processed", SetupStatusKind.SYNCING, 0.17f))
    private val limited = page(SetupOutcome.Limited, statusLine = SetupStatusLine("Up to date", SetupStatusKind.UP_TO_DATE))
    private val choice = page(SetupOutcome.ChoiceRequired(hostedSourceChoices(PhotosSetupCopy.name)(SourceMultiDeviceMode.EXCLUSIVE)))
    private val failed = page(SetupOutcome.Failed("Your gateway didn't answer. Try again."))

    private val disclosure: @Composable () -> Unit = {
        Column(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg)) {
            SetupWhatsSentDisclosure(PhotosSetupCopy, initiallyExpanded = true)
        }
    }

    @Test fun setup_page_light() = capture("photos_setup_page", dark = false, page())
    @Test fun setup_page_dark() = capture("photos_setup_page", dark = true, page())

    @Test fun setup_waiting_light() = capture("photos_setup_waiting", dark = false, page(busy = SetupBusy.WAITING_FOR_SYSTEM))
    @Test fun setup_waiting_dark() = capture("photos_setup_waiting", dark = true, page(busy = SetupBusy.WAITING_FOR_SYSTEM))

    @Test fun setup_on_light() = capture("photos_setup_on", dark = false, on)
    @Test fun setup_on_dark() = capture("photos_setup_on", dark = true, on)

    @Test fun setup_limited_light() = capture("photos_setup_limited", dark = false, limited)
    @Test fun setup_limited_dark() = capture("photos_setup_limited", dark = true, limited)

    @Test fun setup_not_allowed_light() = capture("photos_setup_not_allowed", dark = false, page(SetupOutcome.NotAllowed))
    @Test fun setup_not_allowed_dark() = capture("photos_setup_not_allowed", dark = true, page(SetupOutcome.NotAllowed))

    @Test fun setup_choice_required_light() = capture("photos_setup_choice_required", dark = false, choice)
    @Test fun setup_choice_required_dark() = capture("photos_setup_choice_required", dark = true, choice)

    @Test fun setup_failed_light() = capture("photos_setup_failed", dark = false, failed)
    @Test fun setup_failed_dark() = capture("photos_setup_failed", dark = true, failed)

    private val working = page(busy = SetupBusy.WORKING)
    private val retrying = page(SetupOutcome.Failed("Your gateway didn't answer."), busy = SetupBusy.WORKING)
    private val notAllowedOlderAndroid = page(SetupOutcome.NotAllowed, copy = PhotosSetupCopy.copy(settingsSteps = photosSettingsSteps(32)))

    // Back from Settings: the page showed "off", then the enable continued in place and turned Photos on.
    private val onAfterSettings: @Composable () -> Unit = {
        var outcome by remember { mutableStateOf<SetupOutcome>(SetupOutcome.NotAllowed) }
        LaunchedEffect(Unit) { outcome = SetupOutcome.On }
        page(outcome, statusLine = SetupStatusLine("Syncing…", SetupStatusKind.SYNCING))()
    }

    @Test fun setup_on_after_settings_light() = capture("photos_setup_on_after_settings", dark = false, onAfterSettings)
    @Test fun setup_on_after_settings_dark() = capture("photos_setup_on_after_settings", dark = true, onAfterSettings)

    @Test fun setup_working_light() = capture("photos_setup_working", dark = false, working)
    @Test fun setup_working_dark() = capture("photos_setup_working", dark = true, working)

    @Test fun setup_retrying_light() = capture("photos_setup_retrying", dark = false, retrying)
    @Test fun setup_retrying_dark() = capture("photos_setup_retrying", dark = true, retrying)

    @Test fun setup_not_allowed_api32_light() = capture("photos_setup_not_allowed_api32", dark = false, notAllowedOlderAndroid)
    @Test fun setup_not_allowed_api32_dark() = capture("photos_setup_not_allowed_api32", dark = true, notAllowedOlderAndroid)

    @Test fun settings_whats_sent_light() = capture("photos_settings_whats_sent", dark = false, disclosure)
    @Test fun settings_whats_sent_dark() = capture("photos_settings_whats_sent", dark = true, disclosure)
}
