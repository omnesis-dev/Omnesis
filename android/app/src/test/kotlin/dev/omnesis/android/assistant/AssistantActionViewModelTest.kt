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
import dev.omnesis.android.notes.VoiceNoteFiles
import dev.omnesis.android.ui.capture.RecognizerAudioInput
import dev.omnesis.android.ui.capture.SpeechTranscriber
import dev.omnesis.android.voice.FakeVoiceNoteSession
import dev.omnesis.android.voice.SpeechReadiness
import dev.omnesis.android.voice.SpeechWarmUp
import dev.omnesis.android.voice.VoiceNoteSessions
import dev.omnesis.android.voice.VoiceNoteSession
import java.io.File
import java.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class AssistantActionViewModelTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private val mainDispatcher = UnconfinedTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(mainDispatcher)
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
    fun listening_waits_for_speech_readiness_and_starts_once() {
        val ready = CompletableDeferred<Unit>()
        val transcriber = FakeTranscriber(context)
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            transcriber = transcriber,
            speechReadiness = { ready.await() },
        )
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)

        assertEquals(false, vm.preparing.value)
        vm.startListening()
        vm.startListening()
        assertEquals(0, transcriber.startCount)
        assertEquals(0, transcriber.prepareCount)
        // The overlay is told the microphone is not open yet.
        assertEquals(true, vm.preparing.value)

        ready.complete(Unit)
        assertEquals(false, vm.preparing.value)
        // The recognizer's language check ran before the one session that then started.
        assertEquals(1, transcriber.prepareCount)
        assertEquals(1, transcriber.startCount)
        assertEquals(true, vm.state.value is AssistantActionUiState.Listening)
    }

    @Test
    fun a_cold_start_capture_becomes_a_voice_note_once_the_gateway_status_is_known() {
        // What the gateway's status decides is unknown until readiness: asked earlier, the
        // capture would be a phone-transcribed note without its recording.
        val ready = CompletableDeferred<Unit>()
        val transcriber = FakeTranscriber(context)
        val recording = session()
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            transcriber = transcriber,
            voiceNotes = { recording.takeIf { ready.isCompleted } },
            speechReadiness = { ready.await() },
        )
        vm.handle(Intent(AssistantActionActivity.ACTION_CAPTURE), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        assertEquals(0, transcriber.startCount)

        ready.complete(Unit)

        assertEquals(1, transcriber.audioStarts)
        assertEquals(
            AssistantActionUiState.Listening(AssistantActionKind.CAPTURE, deliveryId = 1, recordingVoiceNote = true),
            vm.state.value,
        )
    }

    @Test
    fun listening_starts_without_readiness_once_the_warm_up_budget_is_spent() {
        val transcriber = FakeTranscriber(context)
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            transcriber = transcriber,
            speechReadiness = { CompletableDeferred<Unit>().await() },
        )
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)
        vm.startListening()

        mainDispatcher.scheduler.advanceTimeBy(SpeechWarmUp.TIMEOUT_MS - 1)
        assertEquals(0, transcriber.startCount)
        mainDispatcher.scheduler.advanceTimeBy(2)
        assertEquals(1, transcriber.startCount)
        assertEquals(0, transcriber.prepareCount)
    }

    @Test
    fun a_slow_language_check_is_cut_off_by_the_same_budget() {
        val transcriber = FakeTranscriber(context).apply { prepareGate = CompletableDeferred() }
        val vm = viewModel(FakeGateway(CompletableDeferred()), transcriber = transcriber)
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        assertEquals(1, transcriber.prepareCount)
        assertEquals(0, transcriber.startCount)

        mainDispatcher.scheduler.advanceTimeBy(SpeechWarmUp.TIMEOUT_MS + 1)
        assertEquals(1, transcriber.startCount)
    }

    @Test
    fun leaving_the_foreground_during_the_warm_up_never_opens_the_microphone() {
        val ready = CompletableDeferred<Unit>()
        val transcriber = FakeTranscriber(context)
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            transcriber = transcriber,
            speechReadiness = { ready.await() },
        )
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)
        vm.startListening()

        vm.stopListening()
        ready.complete(Unit)

        assertEquals(0, transcriber.startCount)
        assertEquals(AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK), vm.state.value)
    }

    @Test
    fun a_request_that_carries_its_words_does_not_wait_for_the_warm_up() {
        val gateway = FakeGateway(CompletableDeferred())
        val vm = viewModel(gateway, speechReadiness = { CompletableDeferred<Unit>().await() })
        vm.handle(
            Intent(AssistantActionActivity.ACTION_ASK)
                .putExtra(AssistantActionActivity.EXTRA_QUESTION, "What is next?"),
            freshDelivery = true,
            trustedDelivery = true,
        )
        assertTrueWorking(vm.state.value)
    }

    private fun voiceNotesRepo(store: PendingNotesStore) = NotesRepository(
        store,
        gateway = { null },
        audioFiles = VoiceNoteFiles(File(context.noBackupFilesDir, "voice-notes")),
        now = { NOW },
    )

    private fun session(): FakeVoiceNoteSession =
        FakeVoiceNoteSession(
            File(File(context.noBackupFilesDir, "voice-notes").apply { mkdirs() }, "recording-a.wav"),
            writtenAtMs = NOW.toEpochMilli(),
        )

    private suspend fun awaitFinished(vm: AssistantActionViewModel) {
        // Persistence uses real IO; suspend so the shared test scheduler can resume
        // the capture coroutine before checking the saved note.
        val finished = vm.state.filterIsInstance<AssistantActionUiState.Finished>().first()
        assertTrue("Capture failed: $finished", finished.successful)
    }

    @Test
    fun a_dictated_capture_is_saved_with_its_recording() = runTest {
        val transcriber = FakeTranscriber(context)
        val recording = session()
        val store = PendingNotesStore(context)
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            transcriber = transcriber,
            voiceNote = recording,
            notes = voiceNotesRepo(store),
        )
        vm.handle(Intent(AssistantActionActivity.ACTION_CAPTURE), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        assertEquals(1, transcriber.audioStarts)
        assertEquals(
            AssistantActionUiState.Listening(AssistantActionKind.CAPTURE, deliveryId = 1, recordingVoiceNote = true),
            vm.state.value,
        )

        // The overlay shows the recording, never the phone's words.
        transcriber.listeners.last().onPartial("Buy a birth")
        assertEquals("", (vm.state.value as AssistantActionUiState.Listening).partialText)
        transcriber.listeners.last().onFinal("Buy a birthday card")
        transcriber.listeners.last().onEnded(SpeechTranscriber.EndReason.NORMAL)
        assertTrue("Capture must finish its recording before persistence", recording.finished)
        awaitFinished(vm)

        val queued = store.readAll().single()
        assertEquals("Buy a birthday card", queued.text)
        assertEquals(true, queued.audio!!.file.exists())
    }

    @Test
    fun a_capture_the_recognizer_cannot_hear_ends_on_silence_and_saves_the_recording() = runTest {
        val transcriber = FakeTranscriber(context)
        val recording = session()
        val store = PendingNotesStore(context)
        val vm = viewModel(
            FakeGateway(CompletableDeferred()),
            transcriber = transcriber,
            voiceNote = recording,
            notes = voiceNotesRepo(store),
        )
        vm.handle(Intent(AssistantActionActivity.ACTION_CAPTURE), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        transcriber.listeners.last().onEnded(SpeechTranscriber.EndReason.FAULT)

        var t = 0L
        repeat(5) { recording.listener!!.onPeak(9_000, t.also { t += 100 }) }
        repeat(30) { recording.listener!!.onPeak(100, t.also { t += 100 }) }
        assertTrue("Capture must finish its recording before persistence", recording.finished)
        awaitFinished(vm)

        val queued = store.readAll().single()
        assertEquals("", queued.text)
        assertEquals(true, queued.audio!!.file.exists())
    }

    @Test
    fun an_ask_never_records_for_the_gateway() {
        val transcriber = FakeTranscriber(context)
        val recording = session()
        val vm = viewModel(FakeGateway(CompletableDeferred()), transcriber = transcriber, voiceNote = recording)
        vm.handle(Intent(AssistantActionActivity.ACTION_ASK), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        assertEquals(0, transcriber.audioStarts)
        assertEquals(1, transcriber.startCount)
        transcriber.listeners.last().onPartial("What is on")
        assertEquals("What is on", (vm.state.value as AssistantActionUiState.Listening).partialText)
    }

    @Test
    fun losing_foreground_discards_a_captures_recording() {
        val transcriber = FakeTranscriber(context)
        val recording = session()
        val vm = viewModel(FakeGateway(CompletableDeferred()), transcriber = transcriber, voiceNote = recording)
        vm.handle(Intent(AssistantActionActivity.ACTION_CAPTURE), freshDelivery = true, trustedDelivery = true)
        vm.startListening()
        vm.stopListening()
        assertEquals(true, recording.discarded)
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
        voiceNote: VoiceNoteSession? = null,
        notes: NotesRepository = NotesRepository(PendingNotesStore(context), gateway = { null }),
        voiceNotes: VoiceNoteSessions = VoiceNoteSessions { voiceNote },
        speechReadiness: SpeechReadiness = SpeechReadiness {},
    ): AssistantActionViewModel = AssistantActionViewModel(
        askRunner = VoiceAskRunner({ gateway }, object : VoiceAskContinuity {
            override fun conversationToResume(): String? = null
            override fun record(conversationId: String) = Unit
        }) { 0L },
        notes = notes,
        transcriber = transcriber,
        voiceNotes = voiceNotes,
        savedState = state,
        speechReadiness = speechReadiness,
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
            viewingForMs: Int?,
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

    private companion object {
        val NOW = Instant.parse("2026-07-13T09:00:00.000Z")
    }

    private class FakeTranscriber(context: Context) : SpeechTranscriber(context) {
        var startCount = 0
        var audioStarts = 0
        var cancelCount = 0
        var prepareCount = 0
        var prepareGate: CompletableDeferred<Unit>? = null
        val listeners = mutableListOf<Listener>()

        override suspend fun prepare() {
            prepareCount++
            prepareGate?.await()
        }

        override fun isAvailable() = true

        override fun start(listener: Listener) {
            startCount++
            listeners += listener
        }

        override fun startWithAudio(listener: Listener, audio: RecognizerAudioInput) {
            audioStarts++
            start(listener)
        }

        override fun cancel() {
            cancelCount++
        }
    }
}
