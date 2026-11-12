// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.screenshots

import dev.omnesis.android.wear.core.AskState
import dev.omnesis.android.wear.core.CapturePhase
import dev.omnesis.android.wear.core.CaptureState
import dev.omnesis.android.wear.core.NoteState
import dev.omnesis.android.wear.core.SpeakerState
import dev.omnesis.android.wear.core.VoiceNoteState
import dev.omnesis.android.wear.core.WatchScreen
import dev.omnesis.android.wear.ui.WatchActions
import dev.omnesis.android.wear.ui.WatchPresentation
import dev.omnesis.android.wear.ui.WatchRoot
import dev.omnesis.android.wear.ui.WatchUiState
import dev.omnesis.android.wearprotocol.AskActivity
import dev.omnesis.android.wearprotocol.AskActivitySnapshot
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.CaptureButtons
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.WearLine
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.time.Duration.Companion.seconds

/**
 * Render-review screenshots of every screen and state of the watch app, each
 * on a small round, a large round and a square display. Questions, notes and
 * answers are invented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class WatchScreensScreenshotTest {
    private fun capture(
        name: String,
        state: WatchUiState,
        presentation: WatchPresentation = WatchPresentation(),
    ) = captureOnEveryWatch(name) { WatchRoot(state, presentation, WatchActions()) }

    private fun answered(outcome: AskOutcome, speaker: SpeakerState? = null): WatchUiState {
        val text = WearLine.forOutcome(outcome)
        return WatchUiState(
            ask = AskState.Answered(text, outcome.kind, WearLine.statusTitle(outcome)),
            speaker = speaker ?: SpeakerState(text),
        )
    }

    private fun asking(question: String, activity: AskActivitySnapshot?) =
        WatchUiState(ask = AskState.Asking(question, "ref"), activity = activity)

    private fun recorder(
        phase: CapturePhase,
        buttons: CaptureButtons = CaptureButtons.ASK_AND_TELL,
        activity: AskActivitySnapshot? = null,
    ) = WatchUiState(capture = CaptureState(phase, buttons, level = 0.6f, activity = activity))

    // The ask flow.

    @Test
    fun ask_idle() = capture("ask_idle", WatchUiState())

    @Test
    fun ask_idle_before_the_buttons_appear() =
        capture("ask_idle_before_hint", WatchUiState(), WatchPresentation(hintVisible = false))

    @Test
    fun ask_asking() = capture(
        "ask_asking",
        asking("Did I book the ferry for the coast trip?", AskActivitySnapshot("Searching…", "12 found")),
    )

    @Test
    fun ask_asking_with_the_longest_status_line() = capture(
        "ask_asking_longest_line",
        asking("What did the studio quote for the kitchen refit?", AskActivitySnapshot("Looking up people…", "148 found")),
    )

    @Test
    fun ask_asking_a_long_question() = capture(
        "ask_asking_long_question",
        asking(
            "What did the studio quote for the kitchen refit, including the appliances and the " +
                "delivery dates they promised for each of them?",
            AskActivitySnapshot("Reading…", "3 read"),
        ),
    )

    @Test
    fun ask_asking_before_any_progress() =
        capture("ask_asking_no_progress", asking("When is the ferry on Friday?", null))

    @Test
    fun ask_waking_the_phone() = capture(
        "ask_waking_phone",
        asking("When is the ferry on Friday?", AskActivitySnapshot(AskActivity.wakingPhoneLabel)),
    )

    @Test
    fun ask_answered() = capture(
        "ask_answered",
        answered(AskOutcome.Answered("Yes — the ferry is booked for Friday at 09:40, and the confirmation is in your inbox.")),
    )

    @Test
    fun ask_answered_while_it_is_read_aloud() {
        val text = "Yes — the ferry is booked for Friday at 09:40, and the confirmation is in your inbox."
        capture(
            "ask_answered_reading",
            answered(AskOutcome.Answered(text), SpeakerState(text, spokenUpTo = 34, isSpeaking = true)),
        )
    }

    @Test
    fun ask_answered_at_length() = capture(
        "ask_answered_long",
        answered(
            AskOutcome.Answered(
                "The studio quoted 8,400 for the cabinets and worktops, and 2,150 for the oven, hob and " +
                    "extractor. They promised the cabinets in the first week of March and the appliances " +
                    "a week later, with fitting booked for the Monday after everything has arrived.",
            ),
        ),
    )

    @Test
    fun ask_still_working() = capture("ask_still_working", answered(AskOutcome.StillWorking))

    @Test
    fun ask_queued_for_the_phone() = capture("ask_queued", answered(AskOutcome.QueuedForPhone))

    @Test
    fun ask_failed() = capture("ask_failed", answered(AskOutcome.PhoneUnreachable))

    // The unified recorder.

    @Test
    fun recorder_opening_the_microphone() = capture("recorder_opening", recorder(CapturePhase.Preparing))

    @Test
    fun recorder_listening_with_ask_and_tell() = capture("recorder_listening_ask_tell", recorder(CapturePhase.Recording))

    @Test
    fun recorder_listening_with_send() =
        capture("recorder_listening_send", recorder(CapturePhase.Recording, CaptureButtons.SEND))

    @Test
    fun recorder_listening_with_ask_only() =
        capture("recorder_listening_ask_only", recorder(CapturePhase.Recording, CaptureButtons.ASK_ONLY))

    @Test
    fun recorder_listening_with_animations_off() = capture(
        "recorder_listening_reduced_motion",
        recorder(CapturePhase.Recording),
        WatchPresentation(reduceMotion = true),
    )

    @Test
    fun recorder_ready_with_ask_and_tell() = capture("recorder_ready_ask_tell", recorder(CapturePhase.Ready))

    @Test
    fun recorder_ready_with_send() = capture("recorder_ready_send", recorder(CapturePhase.Ready, CaptureButtons.SEND))

    @Test
    fun recorder_ready_with_ask_only() =
        capture("recorder_ready_ask_only", recorder(CapturePhase.Ready, CaptureButtons.ASK_ONLY))

    @Test
    fun recorder_saving() = capture("recorder_saving", recorder(CapturePhase.Saving))

    @Test
    fun recorder_sent_working_out_the_route() =
        capture("recorder_sent_automatic", recorder(CapturePhase.Sent(CaptureRoute.AUTOMATIC), CaptureButtons.SEND))

    @Test
    fun recorder_sent_as_a_question() = capture("recorder_sent_ask", recorder(CapturePhase.Sent(CaptureRoute.ASK)))

    @Test
    fun recorder_sent_as_a_question_with_progress() = capture(
        "recorder_sent_ask_progress",
        recorder(CapturePhase.Sent(CaptureRoute.ASK), activity = AskActivitySnapshot("Looking up people…", "148 found")),
    )

    @Test
    fun recorder_sent_as_a_note() = capture("recorder_sent_note", recorder(CapturePhase.Sent(CaptureRoute.NOTE)))

    @Test
    fun recorder_sent_and_left_to_the_phone() = capture(
        "recorder_sent_deferred",
        recorder(CapturePhase.Sent(CaptureRoute.AUTOMATIC), CaptureButtons.SEND).let { it.copy(capture = it.capture.copy(deferred = true)) },
    )

    @Test
    fun recorder_could_not_record() =
        capture("recorder_failed", recorder(CapturePhase.Failed, CaptureButtons.UNSUPPORTED))

    // The note flow.

    @Test
    fun note_idle() = capture("note_idle", WatchUiState(screen = WatchScreen.NOTE))

    @Test
    fun note_sent() = capture(
        "note_sent",
        WatchUiState(screen = WatchScreen.NOTE, note = NoteState.Sent("Pick up the bike on Saturday")),
    )

    @Test
    fun note_could_not_be_saved() = capture(
        "note_failed",
        WatchUiState(screen = WatchScreen.NOTE, note = NoteState.Failed("Pick up the bike on Saturday")),
    )

    @Test
    fun note_sent_at_length() = capture(
        "note_sent_long",
        WatchUiState(
            screen = WatchScreen.NOTE,
            note = NoteState.Sent(
                "Ask the roofer whether the quote covers the flashing around the chimney, and whether " +
                    "the scaffolding can stay up until the gutters have been replaced as well.",
            ),
        ),
    )

    // The note recorder and its notices.

    @Test
    fun voice_note_recording() = capture(
        "voice_note_recording",
        WatchUiState(screen = WatchScreen.NOTE, voiceNote = VoiceNoteState.Recording(0, 120.seconds)),
        WatchPresentation(voiceNoteElapsed = 12.seconds),
    )

    @Test
    fun voice_note_sent_for_the_gateway_to_transcribe() = capture(
        "voice_note_sent_recorded",
        WatchUiState(screen = WatchScreen.NOTE, voiceNote = VoiceNoteState.Sent(recorded = true)),
    )

    @Test
    fun voice_note_sent_as_text() = capture(
        "voice_note_sent_text",
        WatchUiState(screen = WatchScreen.NOTE, voiceNote = VoiceNoteState.Sent(recorded = false)),
    )

    @Test
    fun voice_note_could_not_be_saved() =
        capture("voice_note_failed", WatchUiState(screen = WatchScreen.NOTE, voiceNote = VoiceNoteState.Failed))

    @Test
    fun one_note_was_dropped() = capture("notes_dropped_one", WatchUiState(voiceNote = VoiceNoteState.Dropped(1)))

    @Test
    fun several_notes_were_dropped() =
        capture("notes_dropped_several", WatchUiState(voiceNote = VoiceNoteState.Dropped(3)))
}
