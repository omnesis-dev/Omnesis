// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.assistant.AssistantActionContent
import dev.omnesis.android.assistant.AssistantActionKind
import dev.omnesis.android.assistant.AssistantActionUiState
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AssistantActionScreenshotTest {
    @Test fun awaiting_microphone_permission_light() = capture("assistant_awaiting_permission_light", false) {
        AssistantActionContent(
            AssistantActionUiState.AwaitingMicrophonePermission(AssistantActionKind.ASK, 1),
            {},
        )
    }

    @Test fun awaiting_microphone_permission_dark() = capture("assistant_awaiting_permission_dark", true) {
        AssistantActionContent(
            AssistantActionUiState.AwaitingMicrophonePermission(AssistantActionKind.CAPTURE, 1),
            {},
        )
    }

    @Test fun ready_to_listen_ask_light() = capture("assistant_ready_to_listen_ask_light", false) {
        AssistantActionContent(AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK), {})
    }

    @Test fun ready_to_listen_capture_dark() = capture("assistant_ready_to_listen_capture_dark", true) {
        AssistantActionContent(AssistantActionUiState.ReadyToListen(AssistantActionKind.CAPTURE), {})
    }

    @Test fun confirming_capture_light() = capture("assistant_confirming_capture_light", false) {
        AssistantActionContent(
            AssistantActionUiState.Confirming(AssistantActionKind.CAPTURE, "Book the train tickets"),
            {},
        )
    }

    @Test fun confirming_capture_dark() = capture("assistant_confirming_capture_dark", true) {
        AssistantActionContent(
            AssistantActionUiState.Confirming(AssistantActionKind.CAPTURE, "Book the train tickets"),
            {},
        )
    }

    @Test fun listening_ask_light() = capture("assistant_listening_ask_light", false) {
        AssistantActionContent(AssistantActionUiState.Listening(AssistantActionKind.ASK), {})
    }

    @Test fun listening_ask_dark() = capture("assistant_listening_ask_dark", true) {
        AssistantActionContent(AssistantActionUiState.Listening(AssistantActionKind.ASK), {})
    }

    @Test fun listening_capture_dark() = capture("assistant_listening_capture_dark", true) {
        AssistantActionContent(
            AssistantActionUiState.Listening(AssistantActionKind.CAPTURE, "Book the train tickets"),
            {},
        )
    }

    @Test fun listening_capture_light() = capture("assistant_listening_capture_light", false) {
        AssistantActionContent(
            AssistantActionUiState.Listening(AssistantActionKind.CAPTURE, "Book the train tickets"),
            {},
        )
    }

    @Test fun working_ask_dark() = capture("assistant_working_ask_dark", true) {
        AssistantActionContent(
            AssistantActionUiState.Working(AssistantActionKind.ASK, "What is on my schedule?"),
            {},
        )
    }

    @Test fun working_ask_light() = capture("assistant_working_ask_light", false) {
        AssistantActionContent(
            AssistantActionUiState.Working(AssistantActionKind.ASK, "What is on my schedule?"),
            {},
        )
    }

    @Test fun working_capture_light() = capture("assistant_working_capture_light", false) {
        AssistantActionContent(
            AssistantActionUiState.Working(AssistantActionKind.CAPTURE, "Book the train tickets"),
            {},
        )
    }

    @Test fun working_capture_dark() = capture("assistant_working_capture_dark", true) {
        AssistantActionContent(
            AssistantActionUiState.Working(AssistantActionKind.CAPTURE, "Book the train tickets"),
            {},
        )
    }

    @Test fun answered_light() = capture("assistant_answered_light", false) {
        AssistantActionContent(
            AssistantActionUiState.Finished(
                "Answer from Omnesis",
                "Your next appointment is the Q4 budget review at 10:30.",
                successful = true,
            ),
            {},
        )
    }

    @Test fun answered_dark() = capture("assistant_answered_dark", true) {
        AssistantActionContent(
            AssistantActionUiState.Finished(
                "Answer from Omnesis",
                "Your next appointment is the Q4 budget review at 10:30.",
                successful = true,
            ),
            {},
        )
    }

    @Test fun failed_dark() = capture("assistant_failed_dark", true) {
        AssistantActionContent(
            AssistantActionUiState.Finished(
                "Omnesis",
                "I couldn't reach your gateway. Open Omnesis and check the connection.",
                successful = false,
            ),
            {},
        )
    }

    @Test fun failed_light() = capture("assistant_failed_light", false) {
        AssistantActionContent(
            AssistantActionUiState.Finished(
                "Omnesis",
                "I couldn't reach your gateway. Open Omnesis and check the connection.",
                successful = false,
            ),
            {},
        )
    }

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark, content = content)
            }
        }
    }
}
