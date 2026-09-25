// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.notes.QueueReason
import dev.omnesis.android.ui.capture.CaptureContent
import dev.omnesis.android.ui.capture.CaptureUiState
import dev.omnesis.android.ui.capture.SaveState
import dev.omnesis.android.ui.capture.SpeechState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * "Tell Omnesis" capture screen states — empty, listening (partial streaming),
 * transcribed, mic-denied, save-failed, saved/queued-offline/queued-feature-off
 * confirmations — light + dark.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/src/test/roborazzi/
 *
 * All sample data is invented (privacy rule), never sourced from the corpus.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class CaptureScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    @Composable
    private fun Screen(state: CaptureUiState) {
        CaptureContent(
            state = state,
            onMicTap = {},
            onTextChange = {},
            onSave = {},
            onCancel = {},
            onDismissError = {},
        )
    }

    // --- empty (just opened, mic idle) ---

    @Test
    fun capture_empty_dark() = capture("capture_empty_dark", dark = true) {
        Screen(CaptureUiState())
    }

    @Test
    fun capture_empty_light() = capture("capture_empty_light", dark = false) {
        Screen(CaptureUiState())
    }

    // --- listening, partial result streaming in ---

    private val listening = CaptureUiState(
        text = "Remind me to collect the race bib",
        partialText = "before Saturday",
        speech = SpeechState.LISTENING,
    )

    @Test
    fun capture_listening_dark() = capture("capture_listening_dark", dark = true) {
        Screen(listening)
    }

    @Test
    fun capture_listening_light() = capture("capture_listening_light", dark = false) {
        Screen(listening)
    }

    // --- transcribed, ready to save ---

    private val transcribed = CaptureUiState(
        text = "Jamie Lopez recommended Stellar Sound for the rehearsal space — get a quote",
        speech = SpeechState.IDLE,
    )

    @Test
    fun capture_transcribed_dark() = capture("capture_transcribed_dark", dark = true) {
        Screen(transcribed)
    }

    @Test
    fun capture_transcribed_light() = capture("capture_transcribed_light", dark = false) {
        Screen(transcribed)
    }

    // --- mic permission denied (keyboard fallback) ---

    @Test
    fun capture_denied_dark() = capture("capture_denied_dark", dark = true) {
        Screen(CaptureUiState(speech = SpeechState.DENIED))
    }

    @Test
    fun capture_denied_light() = capture("capture_denied_light", dark = false) {
        Screen(CaptureUiState(speech = SpeechState.DENIED))
    }

    // --- offline speech model not downloaded (dictation is on-device only) ---

    @Test
    fun capture_language_not_downloaded_dark() = capture("capture_language_not_downloaded_dark", dark = true) {
        Screen(CaptureUiState(speech = SpeechState.LANGUAGE_NOT_DOWNLOADED))
    }

    @Test
    fun capture_language_not_downloaded_light() = capture("capture_language_not_downloaded_light", dark = false) {
        Screen(CaptureUiState(speech = SpeechState.LANGUAGE_NOT_DOWNLOADED))
    }

    // --- save failed (deterministic per-note rejection) ---

    @Test
    fun capture_error_dark() = capture("capture_error_dark", dark = true) {
        Screen(
            CaptureUiState(
                text = "Book the ferry for the long weekend",
                save = SaveState.Failed("The gateway returned an error (400)."),
            ),
        )
    }

    // --- confirmations ---

    @Test
    fun capture_saved_dark() = capture("capture_saved_dark", dark = true) {
        Screen(CaptureUiState(text = "done", save = SaveState.Done(queued = null)))
    }

    @Test
    fun capture_queued_dark() = capture("capture_queued_dark", dark = true) {
        Screen(CaptureUiState(text = "done", save = SaveState.Done(queued = QueueReason.UNREACHABLE)))
    }

    @Test
    fun capture_queued_light() = capture("capture_queued_light", dark = false) {
        Screen(CaptureUiState(text = "done", save = SaveState.Done(queued = QueueReason.UNREACHABLE)))
    }

    @Test
    fun capture_queued_unpaired_dark() = capture("capture_queued_unpaired_dark", dark = true) {
        Screen(CaptureUiState(text = "done", save = SaveState.Done(queued = QueueReason.UNPAIRED)))
    }

    @Test
    fun capture_queued_unpaired_light() = capture("capture_queued_unpaired_light", dark = false) {
        Screen(CaptureUiState(text = "done", save = SaveState.Done(queued = QueueReason.UNPAIRED)))
    }

    // --- queued because an older gateway does not expose notes (404) ---

    @Test
    fun capture_queued_feature_off_dark() = capture("capture_queued_feature_off_dark", dark = true) {
        Screen(CaptureUiState(text = "done", save = SaveState.Done(queued = QueueReason.FEATURE_OFF)))
    }

    @Test
    fun capture_queued_feature_off_light() = capture("capture_queued_feature_off_light", dark = false) {
        Screen(CaptureUiState(text = "done", save = SaveState.Done(queued = QueueReason.FEATURE_OFF)))
    }

    // --- queued because the pairing credentials were rejected ---

    @Test
    fun capture_queued_unauthorized_dark() = capture("capture_queued_unauthorized_dark", dark = true) {
        Screen(CaptureUiState(text = "done", save = SaveState.Done(queued = QueueReason.UNAUTHORIZED)))
    }

    @Test
    fun capture_queued_unauthorized_light() = capture("capture_queued_unauthorized_light", dark = false) {
        Screen(CaptureUiState(text = "done", save = SaveState.Done(queued = QueueReason.UNAUTHORIZED)))
    }

    // --- saving in flight ---

    @Test
    fun capture_saving_dark() = capture("capture_saving_dark", dark = true) {
        Screen(CaptureUiState(text = "Order more filament for the printer", save = SaveState.Saving))
    }
}
