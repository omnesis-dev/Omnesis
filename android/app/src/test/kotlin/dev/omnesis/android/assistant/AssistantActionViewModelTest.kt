// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import android.content.Context
import android.content.Intent
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.PendingNotesStore
import dev.omnesis.android.transport.client.AgentSessionProfile
import dev.omnesis.android.transport.client.AgentStreamItem
import dev.omnesis.android.transport.dto.AgentEvent
import dev.omnesis.android.transport.dto.CreateSessionResponse
import dev.omnesis.android.transport.dto.SendMessageResponse
import dev.omnesis.android.ui.capture.SpeechTranscriber
import dev.omnesis.android.ui.voice.DictationFailureNotice
import dev.omnesis.android.voice.DictationFailure
import dev.omnesis.android.voice.Endpointing
import dev.omnesis.android.voice.FakeVoiceInput
import dev.omnesis.android.voice.OnDeviceVoiceInput
import dev.omnesis.android.voice.ScriptedVoiceInputs
import dev.omnesis.android.voice.VoiceInputEnd
import dev.omnesis.android.voice.VoiceInputs
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AssistantActionViewModelTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun invalid_new_delivery_cannot_be_overwritten_by_the_previous_answer() {
        val releaseAnswer = CompletableDeferred<Unit>()
        val vm = viewModel(FakeGateway(releaseAnswer))
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK)
                .putExtra(AssistantActionActivity.EXTRA_QUESTION, "What is next?"),
            freshDelivery = true,
            trustedDelivery = true,
        )
        assertTrueWorking(vm.state.value)

        vm.handle(Intent("example.invalid.ACTION"), freshDelivery = true)
        val rejected = AssistantActionUiState.Finished(
            "Couldn't start",
            "That Omnesis action isn't supported.",
            successful = false,
        )
        assertEquals(rejected, vm.state.value)

        releaseAnswer.complete(Unit)
        assertEquals(rejected, vm.state.value)
    }

    @Test
    fun process_death_restoration_is_terminal_instead_of_opening_the_microphone() {
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            SavedStateHandle(mapOf("assistant_action_handled" to true)),
        )

        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = false)

        assertEquals(
            AssistantActionUiState.Finished(
                "Omnesis",
                "This action was already handled. Start it again to run a new request.",
                successful = false,
            ),
            vm.state.value,
        )
    }

    @Test
    fun stale_permission_result_cannot_overwrite_a_direct_text_request() {
        val vm = viewModel(FakeGateway(CompletableDeferred()))
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK)
                .putExtra(AssistantActionActivity.EXTRA_QUESTION, "What is next?"),
            freshDelivery = true,
            trustedDelivery = true,
        )
        val working = vm.state.value

        vm.microphoneDenied()
        vm.startListening()

        assertEquals(working, vm.state.value)
    }

    @Test
    fun untrusted_parameterized_delivery_waits_for_explicit_confirmation() {
        val vm = viewModel(FakeGateway(CompletableDeferred()))
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK)
                .putExtra(AssistantActionActivity.EXTRA_QUESTION, "What is next?"),
            freshDelivery = true,
            trustedDelivery = false,
        )

        assertEquals(
            AssistantActionUiState.Confirming(AssistantActionKind.ASK, "What is next?"),
            vm.state.value,
        )
        vm.confirm()
        assertTrueWorking(vm.state.value)
    }

    @Test
    fun untrusted_missing_text_delivery_requires_a_tap_before_listening() {
        val transcriber = FakeTranscriber(context)
        val vm = viewModel(FakeGateway(CompletableDeferred()), transcriber = transcriber)
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true)

        assertEquals(
            AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK),
            vm.state.value,
        )
        vm.startListening()
        assertEquals(0, transcriber.startCount)
        assertEquals(
            AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK),
            vm.state.value,
        )

        vm.confirm()
        assertEquals(true, vm.state.value is AssistantActionUiState.Listening)
        vm.startListening()
        assertEquals(1, transcriber.startCount)
    }

    @Test
    fun stale_recognizer_callbacks_cannot_cross_an_untrusted_delivery_boundary() {
        val gateway = FakeGateway(CompletableDeferred())
        val transcriber = FakeTranscriber(context)
        val vm = viewModel(gateway, transcriber = transcriber)
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        vm.startListening()
        val stale = transcriber.listeners.single()

        vm.handle(Intent(AssistantActionActivity.ACTION_CAPTURE), freshDelivery = true)
        stale.onPartial("Stale private speech")
        stale.onFinal("Stale private speech")
        stale.onEnded(SpeechTranscriber.EndReason.NORMAL)

        assertEquals(
            AssistantActionUiState.ReadyToListen(AssistantActionKind.CAPTURE),
            vm.state.value,
        )
        assertEquals(1, transcriber.startCount)
        assertEquals(0, gateway.sendCount)
    }

    @Test
    fun losing_foreground_cancels_listening_and_late_silence_cannot_restart_it() {
        val transcriber = FakeTranscriber(context)
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            transcriber = transcriber,
        )
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        vm.startListening()
        val stale = transcriber.listeners.single()

        vm.stopListening()
        stale.onEnded(SpeechTranscriber.EndReason.NORMAL)

        assertEquals(
            AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK),
            vm.state.value,
        )
        assertEquals(1, transcriber.startCount)
        assertEquals(true, transcriber.cancelCount > 0)
    }

    @Test
    fun permission_dialog_state_survives_pause_and_routes_grant_or_denial() {
        val granted = viewModel(FakeGateway(CompletableDeferred()))
        granted.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        granted.awaitMicrophonePermission()
        granted.stopListening()
        assertEquals(
            AssistantActionUiState.AwaitingMicrophonePermission(AssistantActionKind.ASK, 1),
            granted.state.value,
        )
        granted.microphonePermissionGranted()
        assertEquals(true, granted.state.value is AssistantActionUiState.Listening)

        val denied = viewModel(FakeGateway(CompletableDeferred()))
        denied.handle(
            Intent(AssistantActionActivity.ACTION_CAPTURE),
            freshDelivery = true,
            trustedDelivery = true,
        )
        denied.awaitMicrophonePermission()
        denied.microphoneDenied()
        assertEquals(
            AssistantActionUiState.Finished(
                "Microphone is off",
                "Allow microphone access to use hands-free Omnesis actions.",
                successful = false,
            ),
            denied.state.value,
        )
    }

    @Test
    fun repeated_trusted_missing_text_deliveries_have_distinct_listening_identity() {
        val vm = viewModel(FakeGateway(CompletableDeferred()))
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        val first = vm.state.value as AssistantActionUiState.Listening

        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK),
            freshDelivery = true,
            trustedDelivery = true,
        )
        val second = vm.state.value as AssistantActionUiState.Listening

        assertEquals(true, second.deliveryId > first.deliveryId)
    }

    @Test
    fun gateway_dictation_records_transcribes_then_executes_with_the_transcript() {
        val gateway = FakeGateway(CompletableDeferred())
        val recording = FakeVoiceInput()
        val vm = viewModel(gateway, voiceInputs = ScriptedVoiceInputs(true, gateway = mutableListOf(recording)).inputs)
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        assertEquals(Endpointing.SPEECH_END, recording.endpointing)

        recording.listener!!.onRecording(0.6f, 1_500)
        assertEquals(AssistantActionUiState.Recording(AssistantActionKind.ASK, 0.6f, 1_500, 1), vm.state.value)
        vm.finishRecording()
        assertEquals(1, recording.stopCount)
        recording.listener!!.onTranscribing()
        assertEquals(AssistantActionUiState.Transcribing(AssistantActionKind.ASK), vm.state.value)

        recording.listener!!.onText("When is the dentist appointment")
        recording.listener!!.onEnded(VoiceInputEnd.Finished)
        assertEquals(
            AssistantActionUiState.Working(AssistantActionKind.ASK, "When is the dentist appointment"),
            vm.state.value,
        )
    }

    @Test
    fun a_failed_transcription_can_be_retried_before_anything_executes() {
        val gateway = FakeGateway(CompletableDeferred())
        val recording = FakeVoiceInput()
        val vm = viewModel(gateway, voiceInputs = ScriptedVoiceInputs(true, gateway = mutableListOf(recording)).inputs)
        vm.handle(Intent(AssistantActionActivity.ACTION_CAPTURE), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        recording.listener!!.onTranscribing()
        recording.listener!!.onEnded(VoiceInputEnd.Failed(DictationFailure("Couldn't reach your gateway.", retryable = true)))

        assertEquals(
            AssistantActionUiState.DictationFailed(
                AssistantActionKind.CAPTURE,
                DictationFailureNotice("Couldn't reach your gateway.", canRetry = true, canDictateOnDevice = true),
            ),
            vm.state.value,
        )
        vm.retryTranscription()
        assertEquals(1, recording.retryCount)
        recording.listener!!.onTranscribing()
        assertEquals(AssistantActionUiState.Transcribing(AssistantActionKind.CAPTURE), vm.state.value)
        recording.listener!!.onText("Buy a birthday card")
        recording.listener!!.onEnded(VoiceInputEnd.Finished)
        // Unpaired in this test, so the note lands in the offline queue (written off the main thread).
        val deadline = System.currentTimeMillis() + 5_000
        while (vm.state.value !is AssistantActionUiState.Finished && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        assertEquals(
            AssistantActionUiState.Finished("Note captured", queuedCaptureMessage(dev.omnesis.android.notes.QueueReason.UNPAIRED)),
            vm.state.value,
        )
        assertEquals(0, gateway.sendCount)
    }

    @Test
    fun dictating_on_the_phone_after_a_failure_listens_with_the_recognizer() {
        val recording = FakeVoiceInput()
        val phone = FakeVoiceInput()
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            voiceInputs = ScriptedVoiceInputs(true, gateway = mutableListOf(recording), onDevice = mutableListOf(phone)).inputs,
        )
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        recording.listener!!.onEnded(VoiceInputEnd.Failed(DictationFailure("Transcription didn't finish.", retryable = true)))

        vm.dictateOnDevice()
        assertEquals(1, recording.cancelCount)
        assertEquals(AssistantActionUiState.Listening(AssistantActionKind.ASK, deliveryId = 1), vm.state.value)
        // The Activity starts listening on entering Listening; it must use the phone this time.
        vm.startListening()
        assertEquals(1, phone.startCount)
    }

    @Test
    fun a_hands_free_recording_that_hears_nothing_finishes_without_executing() {
        val gateway = FakeGateway(CompletableDeferred())
        val recording = FakeVoiceInput()
        val vm = viewModel(gateway, voiceInputs = ScriptedVoiceInputs(true, gateway = mutableListOf(recording)).inputs)
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        recording.listener!!.onEnded(VoiceInputEnd.NoSpeech)
        val finished = vm.state.value as AssistantActionUiState.Finished
        assertEquals("Didn't catch that", finished.title)
        assertEquals(0, gateway.sendCount)
    }

    @Test
    fun a_transcript_that_lands_while_hidden_waits_for_the_person() {
        val gateway = FakeGateway(CompletableDeferred())
        val recording = FakeVoiceInput()
        val vm = viewModel(gateway, voiceInputs = ScriptedVoiceInputs(true, gateway = mutableListOf(recording)).inputs)
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        vm.finishRecording()
        recording.listener!!.onTranscribing()

        vm.onForegroundChanged(false)
        vm.stopListening()
        recording.listener!!.onText("What's on the calendar tomorrow")
        recording.listener!!.onEnded(VoiceInputEnd.Finished)

        assertEquals(
            AssistantActionUiState.Confirming(AssistantActionKind.ASK, "What's on the calendar tomorrow"),
            vm.state.value,
        )
        assertEquals(0, gateway.sendCount)
        vm.onForegroundChanged(true)
        vm.confirm()
        assertEquals(
            AssistantActionUiState.Working(AssistantActionKind.ASK, "What's on the calendar tomorrow"),
            vm.state.value,
        )
    }

    @Test
    fun losing_foreground_while_recording_discards_the_recording() {
        val recording = FakeVoiceInput()
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            voiceInputs = ScriptedVoiceInputs(true, gateway = mutableListOf(recording)).inputs,
        )
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        recording.listener!!.onRecording(0.3f, 400)

        vm.stopListening()
        assertEquals(1, recording.cancelCount)
        assertEquals(AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK), vm.state.value)
        recording.listener!!.onTranscribing()
        assertEquals(AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK), vm.state.value)
    }

    @Test
    fun unpaired_capture_copy_requires_pairing_instead_of_promising_reachability_retry() {
        assertEquals(
            "Saved on this phone. Pair Omnesis with your gateway to sync it.",
            queuedCaptureMessage(dev.omnesis.android.notes.QueueReason.UNPAIRED),
        )
    }

    private fun viewModel(
        gateway: VoiceAskGateway,
        state: SavedStateHandle = SavedStateHandle(),
        transcriber: SpeechTranscriber = object : SpeechTranscriber(context) {
            override fun cancel() = Unit
        },
        voiceInputs: VoiceInputs = VoiceInputs(
            gatewayStatus = MutableStateFlow(null),
            newOnDevice = { OnDeviceVoiceInput(transcriber) },
            newGateway = { _, _ -> error("gateway dictation is inactive") },
            onDeviceAvailable = { true },
            refreshGatewayStatus = {},
        ),
    ): AssistantActionViewModel = AssistantActionViewModel(
        askRunner = VoiceAskRunner({ gateway }, object : VoiceAskContinuity {
            override fun conversationToResume(): String? = null
            override fun record(conversationId: String) = Unit
        }) { 0L },
        notes = NotesRepository(PendingNotesStore(context), gateway = { null }),
        voiceInputs = voiceInputs,
        savedState = state,
    )

    private fun assertTrueWorking(state: AssistantActionUiState) {
        assertEquals(true, state is AssistantActionUiState.Working)
    }

    private class FakeGateway(
        private val releaseAnswer: CompletableDeferred<Unit>,
    ) : VoiceAskGateway {
        var sendCount = 0

        override suspend fun createSession(
            resumeFromId: String?,
            transcriptLimit: Int?,
            profile: AgentSessionProfile,
        ) = CreateSessionResponse(sessionId = "session-a")

        override suspend fun sendMessage(
            sessionId: String,
            text: String,
            notifyAfterMs: Int,
            viewingForMs: Int,
        ): SendMessageResponse {
            sendCount++
            return SendMessageResponse(messageId = "message-a")
        }

        override fun events(lastEventId: String?, onOpen: () -> Unit): Flow<AgentStreamItem> = flow {
            onOpen()
            releaseAnswer.await()
            emit(AgentStreamItem("1", AgentEvent.MessageEnd("session-a", "message-a")))
        }
    }

    private class FakeTranscriber(context: Context) : SpeechTranscriber(context) {
        var startCount = 0
        var cancelCount = 0
        val listeners = mutableListOf<Listener>()

        override fun isAvailable() = true

        override fun start(listener: Listener) {
            startCount++
            listeners += listener
        }

        override fun cancel() {
            cancelCount++
        }
    }
}
