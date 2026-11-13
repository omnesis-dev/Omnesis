// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
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
import dev.omnesis.android.ui.settings.WATCH_SETTING_SAVE_FAILED
import dev.omnesis.android.ui.settings.WatchSection
import dev.omnesis.android.ui.settings.WatchSettingsState
import dev.omnesis.android.ui.settings.WatchSettingsState.DecisionGate
import dev.omnesis.android.ui.settings.WatchSettingsState.Transcription
import dev.omnesis.android.wear.WatchLink
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The Settings "Watch" section in each state the phone can be in. The section sits low on a long
 * screen, so it is rendered alone, on the screen's own background and padding. The watch name is
 * invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class WatchSettingsScreenshotTest {
    private val connected = WatchLink.Connected("Pixel Watch 3")

    private fun capture(name: String, dark: Boolean, state: WatchSettingsState) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { Section(state) }
            }
        }
    }

    @Composable
    private fun Section(state: WatchSettingsState) {
        Column(
            Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            WatchSection(state, onSetDecisionGate = {}, onEnableTranscription = {}, onRetryRecordings = {})
        }
    }

    private val noWatch = WatchSettingsState(WatchLink.NoWatch, DecisionGate(enabled = true))
    private val appMissing = WatchSettingsState(WatchLink.AppMissing("Pixel Watch 3"), DecisionGate(enabled = true))
    private val gateActive = WatchSettingsState(connected, DecisionGate(enabled = true))
    private val gateOff = WatchSettingsState(connected, DecisionGate(enabled = false))
    private val noDecisionModel = WatchSettingsState(connected, DecisionGate(enabled = true, needsDecisionModel = true))
    private val saving = WatchSettingsState(connected, DecisionGate(enabled = false, saving = true))
    private val saveFailed =
        WatchSettingsState(connected, DecisionGate(enabled = true), error = WATCH_SETTING_SAVE_FAILED)
    private val needsMicrophone =
        WatchSettingsState(connected, DecisionGate(enabled = true), Transcription.NeedsMicrophone())
    private val microphoneDenied =
        WatchSettingsState(connected, DecisionGate(enabled = true), Transcription.NeedsMicrophone(denied = true))
    private val waiting = WatchSettingsState(connected, DecisionGate(enabled = true), Transcription.Waiting(2))
    private val olderGateway = WatchSettingsState(connected, decisionGate = null)

    @Test fun no_watch_dark() = capture("settings_watch_no_watch_dark", true, noWatch)
    @Test fun no_watch_light() = capture("settings_watch_no_watch_light", false, noWatch)
    @Test fun app_missing_dark() = capture("settings_watch_app_missing_dark", true, appMissing)
    @Test fun app_missing_light() = capture("settings_watch_app_missing_light", false, appMissing)
    @Test fun gate_active_dark() = capture("settings_watch_connected_gate_active_dark", true, gateActive)
    @Test fun gate_active_light() = capture("settings_watch_connected_gate_active_light", false, gateActive)
    @Test fun gate_off_dark() = capture("settings_watch_gate_off_dark", true, gateOff)
    @Test fun gate_off_light() = capture("settings_watch_gate_off_light", false, gateOff)
    @Test fun no_decision_model_dark() = capture("settings_watch_no_decision_model_dark", true, noDecisionModel)
    @Test fun no_decision_model_light() = capture("settings_watch_no_decision_model_light", false, noDecisionModel)
    @Test fun saving_dark() = capture("settings_watch_saving_dark", true, saving)
    @Test fun saving_light() = capture("settings_watch_saving_light", false, saving)
    @Test fun save_failed_dark() = capture("settings_watch_save_failed_dark", true, saveFailed)
    @Test fun save_failed_light() = capture("settings_watch_save_failed_light", false, saveFailed)
    @Test fun needs_microphone_dark() = capture("settings_watch_needs_microphone_dark", true, needsMicrophone)
    @Test fun needs_microphone_light() = capture("settings_watch_needs_microphone_light", false, needsMicrophone)
    @Test fun microphone_denied_dark() = capture("settings_watch_microphone_denied_dark", true, microphoneDenied)
    @Test fun microphone_denied_light() = capture("settings_watch_microphone_denied_light", false, microphoneDenied)
    @Test fun waiting_recordings_dark() = capture("settings_watch_waiting_recordings_dark", true, waiting)
    @Test fun waiting_recordings_light() = capture("settings_watch_waiting_recordings_light", false, waiting)
    @Test fun older_gateway_dark() = capture("settings_watch_older_gateway_dark", true, olderGateway)
    @Test fun older_gateway_light() = capture("settings_watch_older_gateway_light", false, olderGateway)
}
