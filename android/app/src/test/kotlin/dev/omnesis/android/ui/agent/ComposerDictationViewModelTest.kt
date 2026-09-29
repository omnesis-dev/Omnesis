// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import dev.omnesis.android.transport.dto.DictationStatusDto
import dev.omnesis.android.ui.voice.DictationFailureNotice
import dev.omnesis.android.voice.DictationFailure
import dev.omnesis.android.voice.Endpointing
import dev.omnesis.android.voice.FakeVoiceInput
import dev.omnesis.android.voice.ScriptedVoiceInputs
import dev.omnesis.android.voice.VoiceInputEnd
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The agent composer's mic: dictation fills the draft (live on the phone, after
 * transcription on the gateway) and never sends it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ComposerDictationViewModelTest {

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun on_device_dictation_streams_live_words_then_delivers_them_once() {
        val phone = FakeVoiceInput()
        val vm = ComposerDictationViewModel(ScriptedVoiceInputs(false, onDevice = mutableListOf(phone)).inputs)
        vm.toggle()
        assertEquals(Endpointing.MANUAL, phone.endpointing)
        assertEquals(ComposerDictationPhase.Listening, vm.state.value.phase)

        phone.listener!!.onPartial("summarize my")
        assertEquals("summarize my", vm.state.value.liveText)
        phone.listener!!.onText("summarize my week")
        phone.listener!!.onPartial("in three")
        assertEquals("summarize my week in three", vm.state.value.liveText)

        vm.toggle()
        assertEquals(1, phone.stopCount)
        phone.listener!!.onText("in three bullets")
        phone.listener!!.onEnded(VoiceInputEnd.Finished)

        val state = vm.state.value
        assertEquals(ComposerDictationPhase.Idle, state.phase)
        assertEquals("", state.liveText)
        val delivery = state.delivery!!
        assertEquals("summarize my week in three bullets", delivery.text)
        vm.onDeliveryConsumed(delivery.id)
        assertNull(vm.state.value.delivery)
    }

    @Test
    fun gateway_dictation_shows_recording_then_transcribing_then_delivers_the_transcript() {
        val recording = FakeVoiceInput()
        val vm = ComposerDictationViewModel(ScriptedVoiceInputs(true, gateway = mutableListOf(recording)).inputs)
        vm.toggle()
        recording.listener!!.onRecording(0.5f, 2_000)
        assertEquals(ComposerDictationPhase.Recording(0.5f, 2_000), vm.state.value.phase)

        vm.toggle()
        assertEquals(1, recording.stopCount)
        recording.listener!!.onTranscribing()
        assertEquals(ComposerDictationPhase.Transcribing, vm.state.value.phase)
        // A second tap while transcribing does nothing.
        vm.toggle()
        assertEquals(1, recording.startCount)

        recording.listener!!.onText("Draft a reply to Maya Reeves about Thursday")
        recording.listener!!.onEnded(VoiceInputEnd.Finished)
        assertEquals("Draft a reply to Maya Reeves about Thursday", vm.state.value.delivery?.text)
        assertEquals(ComposerDictationPhase.Idle, vm.state.value.phase)
    }

    @Test
    fun a_failed_transcription_can_be_retried_or_redone_on_the_phone() {
        val recording = FakeVoiceInput()
        val phone = FakeVoiceInput()
        val vm = ComposerDictationViewModel(
            ScriptedVoiceInputs(true, gateway = mutableListOf(recording), onDevice = mutableListOf(phone)).inputs,
        )
        vm.toggle()
        recording.listener!!.onTranscribing()
        recording.listener!!.onEnded(VoiceInputEnd.Failed(DictationFailure("Couldn't reach your gateway.", retryable = true)))
        assertEquals(
            ComposerDictationPhase.Failed(DictationFailureNotice("Couldn't reach your gateway.", true, true)),
            vm.state.value.phase,
        )

        vm.retry()
        assertEquals(1, recording.retryCount)
        recording.listener!!.onEnded(VoiceInputEnd.Failed(DictationFailure("Couldn't reach your gateway.", retryable = true)))

        vm.dictateOnDevice()
        assertEquals(1, recording.cancelCount)
        assertEquals(1, phone.startCount)
        assertEquals(ComposerDictationPhase.Listening, vm.state.value.phase)
    }

    @Test
    fun typing_over_live_words_keeps_them_in_the_draft_and_stops_listening() {
        val phone = FakeVoiceInput()
        val vm = ComposerDictationViewModel(ScriptedVoiceInputs(false, onDevice = mutableListOf(phone)).inputs)
        vm.toggle()
        phone.listener!!.onPartial("what did I")
        vm.onDraftEdited()

        assertEquals(1, phone.cancelCount)
        assertEquals("", vm.state.value.liveText)
        assertEquals(ComposerDictationPhase.Idle, vm.state.value.phase)
        // The edited field already holds the words; nothing is delivered on top.
        phone.listener!!.onEnded(VoiceInputEnd.Finished)
        assertNull(vm.state.value.delivery)
    }

    @Test
    fun sending_mid_dictation_sends_the_live_words_and_delivers_nothing_after() {
        val phone = FakeVoiceInput()
        val vm = ComposerDictationViewModel(ScriptedVoiceInputs(false, onDevice = mutableListOf(phone)).inputs)
        vm.toggle()
        phone.listener!!.onText("what's due this week")
        vm.onSent()
        assertEquals(1, phone.cancelCount)
        phone.listener!!.onEnded(VoiceInputEnd.Finished)
        assertNull(vm.state.value.delivery)
    }

    @Test
    fun a_denied_microphone_says_so_without_offering_a_retry() {
        val vm = ComposerDictationViewModel(ScriptedVoiceInputs(false).inputs)
        vm.onMicPermissionDenied(permanently = false)
        val failed = vm.state.value.phase as ComposerDictationPhase.Failed
        assertFalse(failed.notice.canRetry)
        assertFalse(failed.notice.canOpenSettings)
        vm.dismissFailure()
        assertEquals(ComposerDictationPhase.Idle, vm.state.value.phase)
    }

    @Test
    fun a_permanent_denial_offers_the_app_settings() {
        val vm = ComposerDictationViewModel(ScriptedVoiceInputs(false).inputs)
        vm.onMicPermissionDenied(permanently = true)
        assertTrue((vm.state.value.phase as ComposerDictationPhase.Failed).notice.canOpenSettings)
    }

    @Test
    fun a_fresh_draft_stops_the_dictation_and_drops_its_words() {
        val recording = FakeVoiceInput()
        val vm = ComposerDictationViewModel(ScriptedVoiceInputs(true, gateway = mutableListOf(recording)).inputs)
        vm.toggle()
        recording.listener!!.onTranscribing()
        vm.onDraftReplaced()
        assertEquals(1, recording.cancelCount)
        assertEquals(ComposerDictationPhase.Idle, vm.state.value.phase)
        recording.listener!!.onText("words for the old conversation")
        recording.listener!!.onEnded(VoiceInputEnd.Finished)
        assertNull(vm.state.value.delivery)
    }

    @Test
    fun opening_the_composer_rereads_the_gateway_status() {
        val scripted = ScriptedVoiceInputs(false)
        ComposerDictationViewModel(scripted.inputs)
        assertEquals(1, scripted.statusRefreshes)
    }

    @Test
    fun the_mic_is_offered_when_either_engine_can_run() {
        val noRecognizer = ScriptedVoiceInputs(false, onDeviceAvailable = false)
        val vm = ComposerDictationViewModel(noRecognizer.inputs)
        assertFalse(vm.state.value.available)

        noRecognizer.status.value = DictationStatusDto(visible = true, enabled = true, modelAssigned = true, active = true)
        assertTrue(vm.state.value.available)

        assertTrue(ComposerDictationViewModel(ScriptedVoiceInputs(false).inputs).state.value.available)
    }
}
