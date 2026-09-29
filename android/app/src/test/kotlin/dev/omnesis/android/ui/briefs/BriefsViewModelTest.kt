// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.BriefDismissReasonDto
import dev.omnesis.android.transport.dto.BriefPageDto
import dev.omnesis.android.transport.dto.BriefRecordDto
import dev.omnesis.android.transport.dto.OpenBriefThreadDto
import dev.omnesis.android.ui.capture.SpeechTranscriber
import dev.omnesis.android.ui.voice.DictationFailureNotice
import dev.omnesis.android.ui.voice.VoiceRecording
import dev.omnesis.android.voice.DictationFailure
import dev.omnesis.android.voice.FakeVoiceInput
import dev.omnesis.android.voice.OnDeviceVoiceInput
import dev.omnesis.android.voice.ScriptedVoiceInputs
import dev.omnesis.android.voice.VoiceInputEnd
import dev.omnesis.android.voice.VoiceInputs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class BriefsViewModelTest {
    private class FakeTranscriber(context: Context) : SpeechTranscriber(context) {
        var listener: Listener? = null
        var cancelCount = 0

        override fun isAvailable(): Boolean = true
        override fun start(listener: Listener) {
            this.listener = listener
        }
        override fun stop() = Unit
        override fun cancel() {
            cancelCount++
        }
    }

    private class FakeBriefsGateway(initial: List<BriefRecordDto>) : BriefsGateway {
        var nextFeed = BriefPageDto(initial)

        override suspend fun feed(cursor: String?): BriefPageDto = nextFeed
        override suspend fun markRead(briefId: String) = Unit
        override suspend fun dismiss(
            briefId: String,
            reason: BriefDismissReasonDto,
            feedback: String?,
            snoozeUntil: String?,
        ) = Unit
        override suspend fun openThread(briefId: String) = OpenBriefThreadDto("conversation")
    }

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `refresh cancels and clears dictation when its brief disappears`() {
        val recording = brief("recording")
        val remaining = brief("remaining")
        val gateway = FakeBriefsGateway(listOf(recording, remaining))
        val (vm, transcriber) = makeViewModel(gateway)
        vm.startDictation(recording)
        transcriber.listener!!.onFinal("Bring the revised agenda")
        transcriber.listener!!.onPartial("to tomorrow's review")

        gateway.nextFeed = BriefPageDto(listOf(remaining))
        vm.load(showLoadingIndicator = false)

        assertEquals(1, transcriber.cancelCount)
        assertNull(vm.state.value.dictatingBriefId)
        assertEquals("", vm.state.value.dictationText)
        assertEquals("", vm.state.value.dictationPartial)
    }

    @Test
    fun `refresh preserves active dictation when its brief remains`() {
        val recording = brief("recording")
        val gateway = FakeBriefsGateway(listOf(recording))
        val (vm, transcriber) = makeViewModel(gateway)
        vm.startDictation(recording)
        transcriber.listener!!.onFinal("Bring the revised agenda")
        transcriber.listener!!.onPartial("to tomorrow's review")

        gateway.nextFeed = BriefPageDto(listOf(recording, brief("new")))
        vm.load(showLoadingIndicator = false)

        assertEquals(0, transcriber.cancelCount)
        assertEquals("recording", vm.state.value.dictatingBriefId)
        assertEquals("Bring the revised agenda", vm.state.value.dictationText)
        assertEquals("to tomorrow's review", vm.state.value.dictationPartial)
    }

    private fun makeViewModel(gateway: FakeBriefsGateway): Pair<BriefsViewModel, FakeTranscriber> {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val transcriber = FakeTranscriber(context)
        return BriefsViewModel(
            voiceInputs = VoiceInputs(
                gatewayStatus = MutableStateFlow(null),
                newOnDevice = { OnDeviceVoiceInput(transcriber) },
                newGateway = { _, _ -> error("gateway dictation is inactive") },
                onDeviceAvailable = { true },
                refreshGatewayStatus = {},
            ),
            sourceCatalog = SourceCatalog(),
            gateway = gateway,
        ) to transcriber
    }

    private fun gatewayViewModel(gateway: FakeBriefsGateway, scripted: ScriptedVoiceInputs) =
        BriefsViewModel(voiceInputs = scripted.inputs, sourceCatalog = SourceCatalog(), gateway = gateway)

    @Test
    fun `on-device stop sends the words on screen at once`() {
        val target = brief("target")
        val gateway = FakeBriefsGateway(listOf(target))
        val (vm, transcriber) = makeViewModel(gateway)
        vm.startDictation(target)
        transcriber.listener!!.onFinal("Is the venue confirmed")
        val sent = mutableListOf<Pair<String, String>>()
        vm.stopDictationAndSend { id, spoken -> sent += id to spoken }
        assertEquals(listOf("conversation" to "Is the venue confirmed"), sent)
        assertNull(vm.state.value.dictatingBriefId)
    }

    @Test
    fun `gateway dictation sends the transcript once it arrives`() {
        val target = brief("target")
        val gateway = FakeBriefsGateway(listOf(target))
        val recording = FakeVoiceInput()
        val vm = gatewayViewModel(gateway, ScriptedVoiceInputs(true, gateway = mutableListOf(recording)))
        vm.startDictation(target)
        recording.listener!!.onRecording(0.5f, 3_000)
        assertEquals(VoiceRecording(0.5f, 3_000), vm.state.value.dictationProgress.recording)

        val sent = mutableListOf<Pair<String, String>>()
        vm.stopDictationAndSend { id, spoken -> sent += id to spoken }
        assertEquals(1, recording.stopCount)
        assertTrue(sent.isEmpty())
        recording.listener!!.onTranscribing()
        assertTrue(vm.state.value.dictationProgress.transcribing)
        // A second tap while the words are on their way does nothing.
        vm.stopDictationAndSend { _, _ -> error("sent twice") }

        recording.listener!!.onText("Move it to Thursday afternoon")
        recording.listener!!.onEnded(VoiceInputEnd.Finished)
        assertEquals(listOf("conversation" to "Move it to Thursday afternoon"), sent)
        assertNull(vm.state.value.dictatingBriefId)
        assertEquals(BriefDictationProgress(), vm.state.value.dictationProgress)
    }

    @Test
    fun `a failed transcription can be retried and still sends`() {
        val target = brief("target")
        val gateway = FakeBriefsGateway(listOf(target))
        val recording = FakeVoiceInput()
        val vm = gatewayViewModel(gateway, ScriptedVoiceInputs(true, gateway = mutableListOf(recording)))
        vm.startDictation(target)
        recording.listener!!.onRecording(0.2f, 800)
        val sent = mutableListOf<String>()
        vm.stopDictationAndSend { _, spoken -> sent += spoken }
        recording.listener!!.onEnded(VoiceInputEnd.Failed(DictationFailure("Couldn't reach your gateway.", retryable = true)))
        assertEquals(
            DictationFailureNotice("Couldn't reach your gateway.", canRetry = true, canDictateOnDevice = true),
            vm.state.value.dictationProgress.failure,
        )
        assertEquals("target", vm.state.value.dictatingBriefId)

        vm.retryTranscription()
        assertEquals(1, recording.retryCount)
        recording.listener!!.onText("Yes, keep it")
        recording.listener!!.onEnded(VoiceInputEnd.Finished)
        assertEquals(listOf("Yes, keep it"), sent)
    }

    @Test
    fun `dictating on the phone after a failure abandons the recording and sends nothing yet`() {
        val target = brief("target")
        val gateway = FakeBriefsGateway(listOf(target))
        val recording = FakeVoiceInput()
        val phone = FakeVoiceInput()
        val vm = gatewayViewModel(
            gateway,
            ScriptedVoiceInputs(true, gateway = mutableListOf(recording), onDevice = mutableListOf(phone)),
        )
        vm.startDictation(target)
        recording.listener!!.onRecording(0.2f, 800)
        vm.stopDictationAndSend { _, _ -> error("the failed recording must not send") }
        recording.listener!!.onEnded(VoiceInputEnd.Failed(DictationFailure("Transcription didn't finish.", retryable = true)))

        vm.dictateOnDevice()
        assertEquals(1, recording.cancelCount)
        assertEquals(1, phone.startCount)
        assertEquals("target", vm.state.value.dictatingBriefId)
        assertNull(vm.state.value.dictationProgress.failure)
        recording.listener!!.onEnded(VoiceInputEnd.Finished)
    }

    @Test
    fun `discarding a failed dictation deletes its recording`() {
        val target = brief("target")
        val recording = FakeVoiceInput()
        val vm = gatewayViewModel(FakeBriefsGateway(listOf(target)), ScriptedVoiceInputs(true, gateway = mutableListOf(recording)))
        vm.startDictation(target)
        recording.listener!!.onEnded(VoiceInputEnd.Failed(DictationFailure("Transcription didn't finish.", retryable = true)))
        vm.discardDictation()
        assertEquals(1, recording.cancelCount)
        assertNull(vm.state.value.dictatingBriefId)
    }

    private fun brief(id: String) = BriefRecordDto(id = id, title = "Invented brief $id")
}
