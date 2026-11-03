// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.NoteAgentDto
import dev.omnesis.android.transport.dto.NoteReceiptDto
import dev.omnesis.android.transport.dto.NoteChangeDto
import dev.omnesis.android.transport.dto.NoteEntryDto
import dev.omnesis.android.ui.capture.CaptureContent
import dev.omnesis.android.ui.capture.CaptureUiState
import dev.omnesis.android.ui.capture.SpeechState
import dev.omnesis.android.ui.notes.NotesHistoryContent
import dev.omnesis.android.ui.notes.NotesHistoryState
import org.junit.Before
import org.junit.After
import java.util.TimeZone
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class NotesHistoryScreenshotTest {
    private lateinit var originalZone: TimeZone
    @Before fun pinTimeZone() { originalZone = TimeZone.getDefault(); TimeZone.setDefault(TimeZone.getTimeZone("UTC")) }
    @After fun restoreTimeZone() { TimeZone.setDefault(originalZone) }
    private val note = NoteEntryDto("note-1", "2026-07-13", "2026-07-13T10:00:00Z", "2026-07-13T10:00:00Z",
        "Remind me to water the balcony plants on Saturday.", surface = "android-app",
        agent = NoteAgentDto("done", NoteReceiptDto("I've added a task for Saturday.",
            listOf(NoteChangeDto("Water the balcony plants", "task-1", 42)))))
    private val entries = listOf(note, note.copy(id = "note-2", text = "Remember that the spare projector cable is in the studio cupboard.",
        agent = NoteAgentDto("running")), note.copy(id = "note-3", text = "Voice note", agent = null, transcription = "pending"))

    private fun capture(name: String, dark: Boolean, state: NotesHistoryState, captureLabel: String = "Tell", fontScale: Float = 1f) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalInspectionMode provides true, LocalDensity provides Density(density.density, fontScale)) {
                OmnesisTheme(darkTheme = dark) {
                    NotesHistoryContent(state, {}, {}, {}, {}, {}, {}, {}, {}, {}, captureLabel = captureLabel)
                }
            }
        }
    }
    private fun handoff(dark: Boolean) = capture("notes_handoff_${if (dark) "dark" else "light"}", dark,
        NotesHistoryState(listOf(note.copy(text = "About this task…\n\nI need help choosing the replacement part.",
            agent = NoteAgentDto("done", NoteReceiptDto("Which part needs replacing?", conversationId = "conversation_example")))),
            loading = false, selectedId = note.id))
    @Test fun notes_handoff_light() = handoff(false)
    @Test fun notes_handoff_dark() = handoff(true)

    @Test fun notes_history_light() = capture("notes_history_light", false, NotesHistoryState(entries, loading = false, cursor = "next"))
    @Test fun notes_history_dark() = capture("notes_history_dark", true, NotesHistoryState(entries, loading = false))
    @Test fun notes_detail_light() = capture("notes_detail_light", false, NotesHistoryState(entries, loading = false, selectedId = note.id))
    @Test fun notes_detail_dark() = capture("notes_detail_dark", true, NotesHistoryState(entries, loading = false, selectedId = note.id))
    @Test fun notes_empty_light() = capture("notes_empty_light", false, NotesHistoryState(loading = false))
    @Test fun notes_empty_dark() = capture("notes_empty_dark", true, NotesHistoryState(loading = false))
    @Test fun notes_loading_light() = capture("notes_loading_light", false, NotesHistoryState())
    @Test fun notes_error_dark() = capture("notes_error_dark", true, NotesHistoryState(loading = false, error = java.io.IOException("Offline")))
    @Test fun notes_reading_detail_light() = capture("notes_reading_detail_light", false,
        NotesHistoryState(entries, loading = false, selectedId = "note-2"))
    @Test fun notes_transcribing_detail_dark() = capture("notes_transcribing_detail_dark", true,
        NotesHistoryState(entries, loading = false, selectedId = "note-3"))
    @Test fun notes_failed_detail_light() = capture("notes_failed_detail_light", false,
        NotesHistoryState(listOf(note.copy(agent = NoteAgentDto("failed"))), loading = false, selectedId = note.id,
            actionError = "Couldn't connect to the gateway."))
    @Test fun capture_history_toolbar_light() {
        captureRoboImage(filePath = "src/test/roborazzi/capture_history_toolbar_light.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = false) {
                    CaptureContent(CaptureUiState(speech = SpeechState.LISTENING), {}, {}, {}, {}, {}, onHistory = {})
                }
            }
        }
    }
    @Test fun notes_capture_history_dark() = capture("notes_capture_history_dark", true,
        NotesHistoryState(entries, loading = false), captureLabel = "Back to capture")
    @Test fun notes_detail_accessibility_light() = capture("notes_detail_accessibility_light", false,
        NotesHistoryState(entries, loading = false, selectedId = note.id), fontScale = 1.6f)
    @Test fun notes_history_accessibility_dark() = capture("notes_history_accessibility_dark", true,
        NotesHistoryState(entries, loading = false, cursor = "next"), fontScale = 1.6f)
    @Test fun notes_detail_long_dark() = capture("notes_detail_long_dark", true,
        NotesHistoryState(listOf(note.copy(text = "The rehearsal room key is in the desk drawer, beside the spare projector cable. " +
            "For the next workshop, use the smaller room: it has a whiteboard and enough space for the prototype tables.\n\n" +
            "The first session should focus on testing the cardboard model, collecting written feedback, and choosing the next experiment. " +
            "Keep the equipment checklist with the printed workshop plan so everything is easy to find.")),
            loading = false, selectedId = note.id))
}
