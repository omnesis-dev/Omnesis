// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.wear.core.AskState
import dev.omnesis.android.wear.core.CapturePhase
import dev.omnesis.android.wear.core.CaptureState
import dev.omnesis.android.wear.core.SpeakerState
import dev.omnesis.android.wear.core.VoiceNoteState
import dev.omnesis.android.wear.core.WatchScreen
import dev.omnesis.android.wear.ui.OmnesisWearTheme
import dev.omnesis.android.wear.ui.WatchActions
import dev.omnesis.android.wear.ui.WatchPresentation
import dev.omnesis.android.wear.ui.WatchRoot
import dev.omnesis.android.wear.ui.WatchUiState
import dev.omnesis.android.wearprotocol.AskOutcome
import dev.omnesis.android.wearprotocol.CaptureButtons
import dev.omnesis.android.wearprotocol.CaptureRoute
import dev.omnesis.android.wearprotocol.WearLine
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.time.Duration.Companion.seconds

/** Each button on each screen asks for the one thing it names. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w227dp-h227dp-small-notlong-round-watch-xhdpi-keyshidden-nonav")
class WatchRootInteractionTest {
    @get:Rule
    val compose = createComposeRule()

    private val pressed = mutableListOf<String>()

    private val actions = WatchActions(
        startCapture = { pressed += "startCapture" },
        askAgain = { pressed += "askAgain" },
        sendCapture = { pressed += "sendCapture:$it" },
        cancelCapture = { pressed += "cancelCapture" },
        closeCapture = { pressed += "closeCapture" },
        retryCapture = { pressed += "retryCapture" },
        enterQuestion = { pressed += "enterQuestion" },
        showNotes = { pressed += "showNotes" },
        dictateNote = { pressed += "dictateNote" },
        sendVoiceNote = { pressed += "sendVoiceNote" },
        cancelVoiceNote = { pressed += "cancelVoiceNote" },
        dismissNotice = { pressed += "dismissNotice" },
        speakAnswer = { pressed += "speakAnswer" },
        stopSpeaking = { pressed += "stopSpeaking" },
    )

    private fun show(state: WatchUiState, presentation: WatchPresentation = WatchPresentation()) {
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisWearTheme { WatchRoot(state, presentation, actions) }
            }
        }
    }

    private fun recorder(phase: CapturePhase, buttons: CaptureButtons = CaptureButtons.ASK_AND_TELL) =
        WatchUiState(capture = CaptureState(phase, buttons))

    private fun answered(speaking: Boolean): WatchUiState {
        val text = "The bakery opens at seven."
        return WatchUiState(
            ask = AskState.Answered(text, AskOutcome.Kind.ANSWER, WearLine.STATUS_STILL_WORKING.text),
            speaker = SpeakerState(text, isSpeaking = speaking),
        )
    }

    @Test
    fun the_ask_screen_offers_the_recorder_a_typed_question_and_notes() {
        show(WatchUiState())
        compose.onNodeWithText(WearLine.TAP_TO_SPEAK.text).performClick()
        compose.onNodeWithContentDescription("Type a question").performClick()
        compose.onNodeWithContentDescription(WearLine.NOTE_TITLE.text).performClick()
        assertEquals(listOf("startCapture", "enterQuestion", "showNotes"), pressed)
    }

    @Test
    fun the_ask_screens_buttons_do_nothing_before_they_appear() {
        show(WatchUiState(), WatchPresentation(hintVisible = false))
        compose.onNodeWithText(WearLine.TAP_TO_SPEAK.text).performClick()
        compose.onNodeWithContentDescription("Type a question").performClick()
        assertEquals(emptyList<String>(), pressed)
    }

    @Test
    fun ask_and_tell_each_send_their_own_route() {
        show(recorder(CapturePhase.Recording))
        compose.onAllNodesWithTag("watchCapture-automatic").assertCountEquals(0)
        compose.onNodeWithTag("watchCapture-ask").performClick()
        compose.onNodeWithTag("watchCapture-note").performClick()
        compose.onNodeWithText(WearLine.CANCEL.text).performClick()
        assertEquals(
            listOf("sendCapture:${CaptureRoute.ASK}", "sendCapture:${CaptureRoute.NOTE}", "cancelCapture"),
            pressed,
        )
    }

    @Test
    fun send_is_the_only_button_when_the_phone_decides() {
        show(recorder(CapturePhase.Ready, CaptureButtons.SEND))
        compose.onAllNodesWithTag("watchCapture-ask").assertCountEquals(0)
        compose.onAllNodesWithTag("watchCapture-note").assertCountEquals(0)
        compose.onNodeWithTag("watchCapture-automatic").performClick()
        assertEquals(listOf("sendCapture:${CaptureRoute.AUTOMATIC}"), pressed)
    }

    @Test
    fun a_follow_up_can_only_ask() {
        show(recorder(CapturePhase.Recording, CaptureButtons.ASK_ONLY))
        compose.onAllNodesWithTag("watchCapture-note").assertCountEquals(0)
        compose.onAllNodesWithTag("watchCapture-automatic").assertCountEquals(0)
        compose.onNodeWithTag("watchCapture-ask").performClick()
        assertEquals(listOf("sendCapture:${CaptureRoute.ASK}"), pressed)
    }

    @Test
    fun nothing_can_be_sent_while_the_microphone_is_opening() {
        show(recorder(CapturePhase.Preparing))
        compose.onAllNodesWithTag("watchCapture-ask").assertCountEquals(0)
        compose.onNodeWithText(WearLine.CANCEL.text).performClick()
        assertEquals(listOf("cancelCapture"), pressed)
    }

    @Test
    fun done_on_a_sent_recording_closes_the_recorder() {
        show(recorder(CapturePhase.Sent(CaptureRoute.NOTE)))
        compose.onNodeWithText(WearLine.DONE.text).performClick()
        assertEquals(listOf("closeCapture"), pressed)
    }

    @Test
    fun a_recorder_that_could_not_record_offers_another_try() {
        show(recorder(CapturePhase.Failed, CaptureButtons.UNSUPPORTED))
        compose.onNodeWithText(WearLine.TRY_AGAIN.text).performClick()
        assertEquals(listOf("retryCapture"), pressed)
    }

    @Test
    fun an_answer_can_be_read_aloud_and_followed_up() {
        show(answered(speaking = false))
        compose.onNodeWithContentDescription(WearLine.SPEAK_ANSWER.text).performClick()
        compose.onNodeWithContentDescription(WearLine.ASK_AGAIN.text).performClick()
        assertEquals(listOf("speakAnswer", "askAgain"), pressed)
    }

    @Test
    fun an_answer_being_read_aloud_can_be_stopped() {
        show(answered(speaking = true))
        compose.onNodeWithContentDescription(WearLine.STOP.text).performClick()
        assertEquals(listOf("stopSpeaking"), pressed)
    }

    @Test
    fun the_note_screen_starts_a_new_note() {
        show(WatchUiState(screen = WatchScreen.NOTE))
        compose.onNodeWithText(WearLine.NEW_NOTE.text).performClick()
        assertEquals(listOf("dictateNote"), pressed)
    }

    @Test
    fun the_note_recorder_sends_or_cancels() {
        show(
            WatchUiState(screen = WatchScreen.NOTE, voiceNote = VoiceNoteState.Recording(0, 120.seconds)),
            WatchPresentation(voiceNoteElapsed = 5.seconds),
        )
        compose.onNodeWithText("0:05 / 2:00").assertExists()
        compose.onNodeWithTag("watchVoiceSend").performClick()
        compose.onNodeWithText(WearLine.CANCEL.text).performClick()
        assertEquals(listOf("sendVoiceNote", "cancelVoiceNote"), pressed)
    }

    @Test
    fun the_dropped_notes_notice_is_acknowledged_with_ok() {
        show(WatchUiState(voiceNote = VoiceNoteState.Dropped(2)))
        compose.onNodeWithText(WearLine.notesNotSent(2)).assertExists()
        compose.onNodeWithText(WearLine.OK.text).performClick()
        assertEquals(listOf("dismissNotice"), pressed)
    }
}
