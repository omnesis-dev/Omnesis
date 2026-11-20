// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.feature.assist.AssistCheck
import dev.omnesis.android.feature.assist.AssistPipeline
import dev.omnesis.android.feature.assist.CommandRoute
import dev.omnesis.android.feature.assist.Destination
import dev.omnesis.android.feature.assist.PhoneActionCatalog
import dev.omnesis.android.feature.assist.PhoneActionKind
import dev.omnesis.android.feature.assist.TranscriberKind
import dev.omnesis.android.feature.assist.TranscriptionTiming
import dev.omnesis.android.feature.assist.WakeWord
import dev.omnesis.android.feature.assist.WakeWordModelCatalog
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Render-review screenshots for the voice-commands card: not set up, three
 * routes waiting for their models, everything ready and listening, and a
 * refused token, light + dark.
 *
 *   ./gradlew :feature-assist:recordRoborazziDebug   ->   feature-assist/src/test/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h2400dp-xxhdpi")
class VoiceCommandsScreenshotTest {

    private fun capture(name: String, dark: Boolean, state: VoiceCommandsState) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary).padding(16.dp).verticalScroll(rememberScrollState())) {
                        VoiceCommandsContent(state = state, actions = object : VoiceCommandsActions {})
                    }
                }
            }
        }
    }

    private val connected = AssistCheck.Ok(
        version = "2026.11.0",
        pipelines = listOf(AssistPipeline("p1", "Home Assistant", "en"), AssistPipeline("p2", "Casa", "it")),
        preferred = "p1",
    )

    private val home = CommandRoute("home", WakeWordModelCatalog.OK_HOME.id, Destination.HomeAssistant)
    private val hook = CommandRoute("hook", WakeWordModelCatalog.HEY_MYCROFT.id, Destination.Webhook("https://automation.example.com/hook/voice"))
    private val phone = CommandRoute("phone", WakeWordModelCatalog.ALEXA.id, Destination.PhoneAction)
    private val custom = WakeWord("custom:ehi_casa.onnx", "ehi casa", "ehi_casa.onnx", download = null, origin = "imported on this phone")

    private fun rows(installed: Boolean) = listOf(
        RouteRow(home, WakeWordModelCatalog.OK_HOME, installed),
        RouteRow(hook, WakeWordModelCatalog.HEY_MYCROFT, installed, hasSecret = installed),
        RouteRow(phone, WakeWordModelCatalog.ALEXA, installed),
    )

    private fun app(label: String) = PhoneActionCatalog.App("com.example.${label.lowercase().replace(" ", "")}", label)

    private val maps = app("Atlas")
    private val roadie = app("Roadie")
    private val tunes = app("Stellar Sound")
    private val notes = app("Notebook")
    private val chat = app("Chatter")

    private fun phoneActions(chosen: Boolean) = listOf(
        PhoneActionRow(PhoneActionKind.TIMER, listOf(app("Clock")), app("Clock")),
        PhoneActionRow(PhoneActionKind.ALARM, listOf(app("Clock")), app("Clock")),
        PhoneActionRow(PhoneActionKind.NAVIGATE, listOf(maps, roadie), if (chosen) maps else null),
        PhoneActionRow(PhoneActionKind.MUSIC, listOf(tunes), tunes),
        PhoneActionRow(PhoneActionKind.OPEN_APP, List(42) { app("App $it") }, null),
        PhoneActionRow(PhoneActionKind.CALL, listOf(app("Phone")), app("Phone")),
        PhoneActionRow(PhoneActionKind.CALENDAR, emptyList(), null),
        PhoneActionRow(PhoneActionKind.SHARE, listOf(chat, notes), if (chosen) notes else null),
    )

    private val waiting = VoiceCommandsState(
        baseUrl = "http://homeassistant.local:8123",
        hasToken = true,
        check = connected,
        routes = rows(installed = false),
        transcriberProblems = mapOf(TranscriberKind.PHONE to "this phone has no on-device recognizer that reads audio (Android 13 or later)"),
        phoneActions = phoneActions(chosen = false),
    )

    private val ready = VoiceCommandsState(
        baseUrl = "https://home.example.com",
        hasToken = true,
        enabled = true,
        pipelineId = "p2",
        check = connected,
        routes = rows(installed = true),
        words = WakeWordModelCatalog.words + custom,
        transcriber = TranscriberKind.PHONE,
        timings = mapOf(
            TranscriberKind.GATEWAY to TranscriptionTiming(audioMs = 2_300, tookMs = 1_840, heard = true),
            TranscriberKind.PHONE to TranscriptionTiming(audioMs = 2_100, tookMs = 620, heard = true),
        ),
        overlayAllowed = true,
        phoneActions = phoneActions(chosen = true),
        callingAllowed = true,
    )

    @Test fun notSetUp_light() = capture("voice_commands_not_set_up_light", dark = false, VoiceCommandsState())

    @Test fun notSetUp_dark() = capture("voice_commands_not_set_up_dark", dark = true, VoiceCommandsState())

    @Test fun routesWaitingForModels_light() = capture("voice_commands_routes_waiting_light", dark = false, waiting)

    @Test fun routesWaitingForModels_dark() = capture("voice_commands_routes_waiting_dark", dark = true, waiting)

    @Test fun listening_light() = capture("voice_commands_listening_light", dark = false, ready)

    @Test fun listening_dark() = capture("voice_commands_listening_dark", dark = true, ready)

    @Test fun badToken_light() = capture(
        "voice_commands_bad_token_light",
        dark = false,
        VoiceCommandsState(
            baseUrl = "http://192.0.2.10:8123",
            hasToken = true,
            check = AssistCheck.BadToken,
            routes = listOf(RouteRow(home, WakeWordModelCatalog.OK_HOME, installed = true)),
        ),
    )
}
