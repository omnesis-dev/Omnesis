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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
            transcriber = transcriber,
            sourceCatalog = SourceCatalog(),
            gateway = gateway,
        ) to transcriber
    }

    private fun brief(id: String) = BriefRecordDto(id = id, title = "Invented brief $id")
}
