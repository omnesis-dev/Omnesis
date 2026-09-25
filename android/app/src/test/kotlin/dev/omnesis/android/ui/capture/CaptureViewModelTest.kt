// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.notes.NotesGateway
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.PendingNotesStore
import dev.omnesis.android.notes.QueueReason
import dev.omnesis.android.transport.client.NotesClient
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * [CaptureViewModel] behavior: the dictation-session lifecycle, driven through
 * a scripted fake transcriber (partials must survive session restarts instead
 * of being replaced by the next session's first partial), and the save
 * outcomes (posted / queued-unreachable / queued-feature-off).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class CaptureViewModelTest {

    /** Records start/stop/cancel and hands the test the listener to script results with. */
    private class FakeTranscriber(context: Context) : SpeechTranscriber(context) {
        var listener: Listener? = null
        var startCount = 0
        override fun isAvailable(): Boolean = true
        override fun start(listener: Listener) {
            this.listener = listener
            startCount++
        }

        override fun stop() = Unit
        override fun cancel() = Unit
    }

    private lateinit var transcriber: FakeTranscriber
    private lateinit var vm: CaptureViewModel

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        vm = makeVm(gateway = { null })
    }

    @After fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun makeVm(gateway: () -> NotesGateway?): CaptureViewModel {
        val context = ApplicationProvider.getApplicationContext<Context>()
        transcriber = FakeTranscriber(context)
        return CaptureViewModel(
            transcriber = transcriber,
            repository = NotesRepository(store = PendingNotesStore(context), gateway = gateway),
            savedStateHandle = SavedStateHandle(),
        )
    }

    /** The save runs a real coroutine + (for gateway tests) real HTTP; poll for its terminal state. */
    private fun awaitSaveSettled(vm: CaptureViewModel): SaveState {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            val save = vm.state.value.save
            if (save is SaveState.Done || save is SaveState.Failed) return save
            Thread.sleep(10)
        }
        error("save never settled: ${vm.state.value.save}")
    }

    @Test
    fun restart_after_an_error_ended_session_keeps_the_uncommitted_partial() {
        vm.onMicPermission(true)
        assertEquals(1, transcriber.startCount)
        transcriber.listener!!.onPartial("call the plumber about the boiler")

        // The session error-ends without ever delivering a final result; the
        // mic is still wanted, so the ViewModel restarts a new session.
        transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.NORMAL)
        assertEquals(2, transcriber.startCount)
        assertEquals("call the plumber about the boiler", vm.state.value.text)
        assertEquals("", vm.state.value.partialText)

        // The new session's first partial appends — it must not clobber the words.
        transcriber.listener!!.onPartial("before Friday")
        assertEquals("call the plumber about the boiler before Friday", vm.state.value.textWithPartial())
    }

    @Test
    fun stop_then_immediate_retap_keeps_the_dictated_words() {
        vm.onMicPermission(true)
        transcriber.listener!!.onPartial("water the garden")

        // Stop, then re-tap before the stopping recognizer delivers its final
        // result — start() cancels it, so that final never arrives.
        vm.stopListening()
        vm.startListening()
        assertEquals("water the garden", vm.state.value.text)
        assertEquals("", vm.state.value.partialText)

        transcriber.listener!!.onPartial("every evening")
        assertEquals("water the garden every evening", vm.state.value.textWithPartial())
    }

    @Test
    fun final_after_stop_still_replaces_the_partial_without_doubling() {
        vm.onMicPermission(true)
        transcriber.listener!!.onPartial("buy oat milk")
        vm.stopListening()

        // No re-tap: the stopping recognizer finishes normally, so the final
        // result replaces the partial rather than being appended after it.
        transcriber.listener!!.onFinal("buy oat milk")
        transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.NORMAL)
        assertEquals("buy oat milk", vm.state.value.text)
        assertEquals("", vm.state.value.partialText)
    }

    @Test
    fun a_missing_language_pack_stops_the_mic_and_says_so_instead_of_restarting() {
        vm.onMicPermission(true)
        assertEquals(1, transcriber.startCount)

        // Offline-only dictation with no downloaded model: every session fails on
        // arrival, so restarting would hold the mic hot forever and never transcribe.
        transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.LANGUAGE_NOT_DOWNLOADED)

        assertEquals(1, transcriber.startCount)
        assertEquals(SpeechState.LANGUAGE_NOT_DOWNLOADED, vm.state.value.speech)
    }

    @Test
    fun an_unsupported_language_reports_recognition_unavailable() {
        vm.onMicPermission(true)

        transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.LANGUAGE_NOT_SUPPORTED)

        assertEquals(1, transcriber.startCount)
        assertEquals(SpeechState.UNAVAILABLE, vm.state.value.speech)
    }

    @Test
    fun a_terminal_end_keeps_the_words_already_dictated() {
        vm.onMicPermission(true)
        transcriber.listener!!.onPartial("pick up the dry cleaning")

        transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.DENIED)

        assertEquals(SpeechState.DENIED, vm.state.value.speech)
        assertEquals("pick up the dry cleaning", vm.state.value.text)
        assertEquals("", vm.state.value.partialText)
    }

    @Test
    fun a_terminal_state_survives_a_stop_and_is_not_demoted_to_idle() {
        vm.onMicPermission(true)
        transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.LANGUAGE_NOT_DOWNLOADED)

        // Nothing the user does on this screen can clear it — only downloading
        // the pack — so it must not decay back into an inviting "tap to talk".
        vm.stopListening()

        assertEquals(SpeechState.LANGUAGE_NOT_DOWNLOADED, vm.state.value.speech)
    }

    @Test
    fun a_streak_of_recognizer_faults_gives_up_instead_of_spinning_the_mic() {
        vm.onMicPermission(true)

        // Faults end a session on arrival, so an unbounded retry would restart
        // at full speed forever with the mic showing as live.
        repeat(20) { transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.FAULT) }

        assertEquals(5, transcriber.startCount)
        assertEquals(SpeechState.UNAVAILABLE, vm.state.value.speech)
    }

    @Test
    fun silence_never_counts_toward_the_fault_budget() {
        vm.onMicPermission(true)

        // A user who opens the screen and thinks before speaking produces a long
        // run of empty sessions; the mic must stay hot through all of them.
        repeat(20) { transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.NORMAL) }

        assertEquals(21, transcriber.startCount)
        assertEquals(SpeechState.LISTENING, vm.state.value.speech)
    }

    @Test
    fun an_intermittent_fault_is_retried_and_the_streak_resets() {
        vm.onMicPermission(true)

        repeat(4) { transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.FAULT) }
        transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.NORMAL)
        repeat(4) { transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.FAULT) }

        assertEquals(SpeechState.LISTENING, vm.state.value.speech)
        assertEquals(10, transcriber.startCount)
    }

    @Test
    fun save_while_unpaired_confirms_as_queued_unpaired() {
        vm.onTextEdited("fix the bike light")
        vm.save()

        assertEquals(SaveState.Done(queued = QueueReason.UNPAIRED), awaitSaveSettled(vm))
    }

    @Test
    fun save_against_a_feature_off_gateway_confirms_as_queued_not_failed() {
        // 404 = an older gateway without /notes. Cross-platform policy: the
        // note is saved on device and confirmed with honest compatibility copy.
        val server = MockWebServer().also { it.start() }
        try {
            server.enqueue(MockResponse().setResponseCode(404).setBody("Not found"))
            val vm = makeVm(
                gateway = {
                    NotesGateway(NotesClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")), "dev-1")
                },
            )

            vm.onTextEdited("fix the bike light")
            vm.save()

            assertEquals(SaveState.Done(queued = QueueReason.FEATURE_OFF), awaitSaveSettled(vm))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun save_against_rejected_pairing_confirms_as_queued_for_repair() {
        val server = MockWebServer().also { it.start() }
        try {
            server.enqueue(MockResponse().setResponseCode(401).setBody("Unauthorized"))
            val vm = makeVm(
                gateway = {
                    NotesGateway(NotesClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")), "dev-1")
                },
            )

            vm.onTextEdited("fix the bike light")
            vm.save()

            assertEquals(SaveState.Done(queued = QueueReason.UNAUTHORIZED), awaitSaveSettled(vm))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun save_surfaces_a_deterministic_rejection_as_failed() {
        val server = MockWebServer().also { it.start() }
        try {
            server.enqueue(MockResponse().setResponseCode(400).setBody("bad request"))
            val vm = makeVm(
                gateway = {
                    NotesGateway(NotesClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok")), "dev-1")
                },
            )

            vm.onTextEdited("fix the bike light")
            vm.save()

            assertTrue(awaitSaveSettled(vm) is SaveState.Failed)
        } finally {
            server.shutdown()
        }
    }
}
