// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.capture

import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.notes.NotesGateway
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notes.PendingNotesStore
import dev.omnesis.android.notes.PendingNote
import dev.omnesis.android.notes.QueueReason
import dev.omnesis.android.notes.VoiceNoteFiles
import dev.omnesis.android.voice.FakeVoiceNoteSession
import dev.omnesis.android.voice.VoiceNoteSession
import java.io.File
import java.time.Instant
import kotlinx.coroutines.runBlocking
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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
        var audioStarts = 0
        var available = true
        override fun isAvailable(): Boolean = available
        override fun start(listener: Listener) {
            this.listener = listener
            startCount++
        }

        override fun startWithAudio(listener: Listener, audio: RecognizerAudioInput) {
            audioStarts++
            start(listener)
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

    private fun makeVm(
        gateway: () -> NotesGateway?,
        vararg voiceNotes: VoiceNoteSession,
    ): CaptureViewModel {
        val context = ApplicationProvider.getApplicationContext<Context>()
        transcriber = FakeTranscriber(context)
        store = PendingNotesStore(context)
        val sessions = ArrayDeque(voiceNotes.toList())
        return CaptureViewModel(
            transcriber = transcriber,
            repository = NotesRepository(
                store = store,
                gateway = gateway,
                audioFiles = VoiceNoteFiles(File(context.noBackupFilesDir, "voice-notes")),
                now = { NOW },
            ),
            voiceNotes = {
                beginCount++
                sessions.removeFirstOrNull()
            },
            savedStateHandle = SavedStateHandle(),
        )
    }

    private lateinit var store: PendingNotesStore
    private var beginCount = 0

    private fun recordingSession(name: String = "recording-test.wav", captured: Boolean = true): FakeVoiceNoteSession {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val dir = File(context.noBackupFilesDir, "voice-notes").apply { mkdirs() }
        return FakeVoiceNoteSession(File(dir, name), writtenAtMs = NOW.toEpochMilli(), captured = captured)
    }

    private fun awaitQueued(): PendingNote {
        assertEquals(SaveState.Done(queued = QueueReason.UNPAIRED), awaitSaveSettled(vm))
        return runBlocking { store.readAll().single() }
    }

    // --- Voice notes: the gateway transcribes, the phone's words never show ---

    @Test
    fun a_voice_note_records_and_never_shows_the_phones_words() {
        val session = recordingSession()
        vm = makeVm(gateway = { null }, session)
        vm.onMicPermission(true)

        assertEquals(SpeechState.RECORDING, vm.state.value.speech)
        assertEquals(VoiceNoteUi(recording = true, elapsedMs = 0), vm.state.value.voiceNote)
        // The recognizer listens to a copy of the recording, out of sight.
        assertEquals(1, transcriber.audioStarts)
        transcriber.listener!!.onPartial("remind me about the")
        transcriber.listener!!.onFinal("remind me about the dentist")
        assertEquals("", vm.state.value.text)
        assertEquals("", vm.state.value.partialText)

        session.listener!!.onPeak(12_000, 3_400)
        assertEquals(3_400, vm.state.value.voiceNote!!.elapsedMs)
        assertTrue(vm.state.value.voiceNote!!.level > 0.5f)
    }

    @Test
    fun stopping_keeps_the_recording_and_record_more_appends_to_it() {
        val session = recordingSession()
        vm = makeVm(gateway = { null }, session)
        vm.onMicPermission(true)
        session.listener!!.onPeak(9_000, 4_000)

        vm.stopListening()
        assertEquals(SpeechState.IDLE, vm.state.value.speech)
        assertEquals(VoiceNoteUi(recording = false, elapsedMs = 4_000), vm.state.value.voiceNote)
        assertEquals(1, session.paused)
        // Peaks after the stop do not move a stopped note.
        session.listener!!.onPeak(9_000, 5_000)
        assertEquals(4_000, vm.state.value.voiceNote!!.elapsedMs)

        vm.startListening()
        assertEquals(1, session.resumed)
        assertEquals(true, vm.state.value.voiceNote!!.recording)
        assertEquals(1, beginCount)
        assertEquals(2, transcriber.audioStarts)
    }

    @Test
    fun saving_sends_the_audio_with_the_hidden_transcript_as_its_stand_in() {
        val session = recordingSession()
        vm = makeVm(gateway = { null }, session)
        vm.onMicPermission(true)
        transcriber.listener!!.onFinal("pick up the parcel")
        transcriber.listener!!.onPartial("before noon")

        vm.save()

        val queued = awaitQueued()
        assertEquals("pick up the parcel before noon", queued.text)
        assertTrue(queued.audio!!.file.exists())
        assertTrue(session.finished)
        assertEquals("", vm.state.value.text)
    }

    @Test
    fun discarding_the_recording_turns_the_capture_into_a_typed_note() {
        val session = recordingSession()
        vm = makeVm(gateway = { null }, session)
        vm.onMicPermission(true)
        transcriber.listener!!.onFinal("never shown")
        vm.stopListening()

        vm.discardVoiceNote()
        assertTrue(session.discarded)
        assertNull(vm.state.value.voiceNote)
        assertEquals("", vm.state.value.text)

        vm.onTextEdited("Typed instead")
        vm.save()
        val queued = awaitQueued()
        assertEquals("Typed instead", queued.text)
        assertNull(queued.audio)
    }

    @Test
    fun a_voice_note_ignores_keyboard_edits() {
        vm = makeVm(gateway = { null }, recordingSession())
        vm.onMicPermission(true)
        vm.onTextEdited("sneaky")
        assertEquals("", vm.state.value.text)
    }

    @Test
    fun typed_words_stay_a_typed_note_when_the_mic_is_tapped() {
        vm = makeVm(gateway = { null }, recordingSession())
        vm.onTextEdited("Groceries:")
        vm.startListening()
        assertEquals(0, beginCount)
        assertEquals(SpeechState.LISTENING, vm.state.value.speech)
        assertNull(vm.state.value.voiceNote)
    }

    @Test
    fun a_recognizer_that_fails_on_the_recording_stops_listening_but_the_note_records_on() {
        val session = recordingSession()
        vm = makeVm(gateway = { null }, session)
        vm.onMicPermission(true)
        transcriber.listener!!.onEnded(SpeechTranscriber.EndReason.FAULT)

        assertEquals(SpeechState.RECORDING, vm.state.value.speech)
        assertEquals(1, transcriber.audioStarts)

        vm.save()
        val queued = awaitQueued()
        assertEquals("", queued.text)
        assertTrue(queued.audio!!.file.exists())
    }

    @Test
    fun a_voice_note_records_even_without_a_recognizer() {
        vm = makeVm(gateway = { null }, recordingSession())
        transcriber.available = false
        vm.onMicPermission(true)
        assertEquals(SpeechState.RECORDING, vm.state.value.speech)
        assertEquals(0, transcriber.startCount)
    }

    @Test
    fun a_recording_that_captured_nothing_saves_nothing_and_says_so() {
        vm = makeVm(gateway = { null }, recordingSession(captured = false))
        vm.onMicPermission(true)
        vm.save()
        assertTrue(vm.state.value.save is SaveState.Failed)
        assertNull(vm.state.value.voiceNote)
        assertTrue(runBlocking { store.readAll() }.isEmpty())
    }

    @Test
    fun saving_audio_at_repository_start_preserves_it_and_removes_older_orphans() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val session = recordingSession()
        val orphan = File(context.noBackupFilesDir, "voice-notes/orphan.wav").apply {
            writeText("RIFF-invented-orphan")
            assertTrue(setLastModified(NOW.toEpochMilli() - 1))
        }
        vm = makeVm(gateway = { null }, session)
        vm.onMicPermission(true)

        vm.save()

        val queued = awaitQueued()
        assertEquals(NOW.toString(), queued.capturedAt)
        assertEquals("RIFF-invented", queued.audio!!.file.readText())
        assertFalse(orphan.exists())
    }

    @Test
    fun a_lost_recording_hands_over_the_phones_words_as_an_editable_note() {
        val session = recordingSession()
        vm = makeVm(gateway = { null }, session, recordingSession("second.wav"))
        vm.onMicPermission(true)
        transcriber.listener!!.onFinal("book the ferry")
        session.listener!!.onLost()

        assertNull(vm.state.value.voiceNote)
        assertEquals("book the ferry", vm.state.value.text)
        // This visit stays on the phone from here.
        vm.startListening()
        assertEquals(1, beginCount)
        assertEquals(SpeechState.LISTENING, vm.state.value.speech)
    }

    @Test
    fun without_gateway_dictation_dictation_is_unchanged() {
        vm.onMicPermission(true)
        assertEquals(0, transcriber.audioStarts)
        assertEquals(1, transcriber.startCount)
        transcriber.listener!!.onPartial("live words")
        assertEquals("live words", vm.state.value.textWithPartial())
    }

    @Test
    fun durations_read_as_a_clock_and_as_speech() {
        assertEquals("0:07", clockDuration(7_400))
        assertEquals("1:32", clockDuration(92_000))
        assertEquals("1 second", spokenDuration(1_200))
        assertEquals("12 seconds", spokenDuration(12_000))
        assertEquals("1 minute", spokenDuration(60_000))
        assertEquals("2 minutes 5 seconds", spokenDuration(125_000))
    }

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

    private companion object {
        val NOW = Instant.parse("2026-07-13T09:00:00.000Z")
    }
}
