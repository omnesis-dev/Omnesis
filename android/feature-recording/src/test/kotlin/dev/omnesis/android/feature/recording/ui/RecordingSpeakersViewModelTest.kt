// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording.ui

import androidx.lifecycle.SavedStateHandle
import dev.omnesis.android.feature.recording.OutboxChunk
import dev.omnesis.android.feature.recording.OutboxSession
import dev.omnesis.android.feature.recording.RecordingSessionProvider
import dev.omnesis.android.feature.recording.RecordingsGateway
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.PersonSummary
import dev.omnesis.android.transport.dto.RecordingSpeakerDto
import dev.omnesis.android.transport.dto.RecordingSummaryDto
import dev.omnesis.android.transport.dto.SpeakerMapping
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RecordingSpeakersViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    /** The gateway as the speakers screen sees it: an in-memory speaker table. */
    private class FakeGateway : RecordingsGateway {
        var speakers = listOf(
            RecordingSpeakerDto(1, talkMs = 240_000, samples = listOf("Shall we start?")),
            RecordingSpeakerDto(2, talkMs = 61_000, samples = listOf("Sounds good.")),
        )
        val sets = mutableListOf<Pair<Int, SpeakerMapping>>()
        val queries = mutableListOf<String>()
        var failNext: GatewayException? = null
        var hold: CompletableDeferred<Unit>? = null
        var people = listOf(
            PersonSummary(id = "p-self", canonicalName = "Me", isSelf = true),
            PersonSummary(id = "p-maya", canonicalName = "Maya", documentCount = 12),
            PersonSummary(id = "p-jamie", canonicalName = "Jamie", documentCount = 1),
        )

        override suspend fun speakers(sessionId: String): List<RecordingSpeakerDto> {
            failNext?.let { failNext = null; throw it }
            return speakers
        }

        override suspend fun setSpeaker(sessionId: String, speaker: Int, mapping: SpeakerMapping): List<RecordingSpeakerDto> {
            hold?.await()
            failNext?.let { failNext = null; throw it }
            sets += speaker to mapping
            speakers = speakers.map {
                if (it.speaker != speaker) {
                    it
                } else {
                    when (mapping) {
                        SpeakerMapping.Self -> it.copy(isSelf = true, personId = null, name = null)
                        is SpeakerMapping.Person -> it.copy(
                            isSelf = false,
                            personId = mapping.personId,
                            name = people.first { p -> p.id == mapping.personId }.canonicalName,
                        )
                        is SpeakerMapping.Name -> it.copy(isSelf = false, personId = null, name = mapping.name)
                        SpeakerMapping.Clear -> it.copy(isSelf = false, personId = null, name = null)
                    }
                }
            }
            return speakers
        }

        override suspend fun searchPeople(query: String, limit: Int): List<PersonSummary> {
            queries += query
            return people.filter { query.isEmpty() || it.canonicalName.contains(query, ignoreCase = true) }
        }

        override suspend fun accepting() = true
        override suspend fun start(session: OutboxSession) = Unit
        override suspend fun putChunk(chunk: OutboxChunk) = Unit
        override suspend fun finish(sessionId: String, chunkCount: Int, endedAt: String) = Unit
        override suspend fun delete(sessionId: String) = Unit
        override suspend fun recent(limit: Int): List<RecordingSummaryDto> = emptyList()
    }

    private val gateway = FakeGateway()
    private var connected = true

    private fun viewModel() = RecordingSpeakersViewModel(
        SavedStateHandle(mapOf(RecordingSpeakersViewModel.ARG_RECORDING_ID to "rec-1", RecordingSpeakersViewModel.ARG_TITLE to "Design sync")),
        RecordingSessionProvider { gateway.takeIf { connected } },
    )

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    @Test fun loadsTheSpeakers() = runTest(dispatcher) {
        val vm = viewModel()
        assertEquals(RecordingSpeakersUiState.Load.Loading, vm.state.value.load)
        advanceUntilIdle()
        assertEquals(RecordingSpeakersUiState.Load.Loaded, vm.state.value.load)
        assertEquals(listOf(1, 2), vm.state.value.speakers.map { it.speaker })
        assertEquals("Design sync", vm.state.value.title)
    }

    @Test fun aFailedLoadOffersARetry() = runTest(dispatcher) {
        gateway.failNext = GatewayException.Network(IOException("offline"))
        val vm = viewModel()
        advanceUntilIdle()
        assertTrue(vm.state.value.load is RecordingSpeakersUiState.Load.Failed)
        vm.load()
        advanceUntilIdle()
        assertEquals(RecordingSpeakersUiState.Load.Loaded, vm.state.value.load)
    }

    @Test fun anUnknownRecordingSaysSo() = runTest(dispatcher) {
        gateway.failNext = GatewayException.NotFound("recording not found")
        val vm = viewModel()
        advanceUntilIdle()
        val load = vm.state.value.load as RecordingSpeakersUiState.Load.Failed
        assertTrue(load.message.contains("no longer"))
    }

    @Test fun setSelfShowsAtOnceThenTakesTheGatewaysAnswer() = runTest(dispatcher) {
        val vm = viewModel()
        advanceUntilIdle()
        gateway.hold = CompletableDeferred()
        vm.setSelf(1)
        runCurrent()
        assertTrue(vm.state.value.speakers.first { it.speaker == 1 }.isSelf)
        assertEquals(setOf(1), vm.state.value.saving)
        gateway.hold!!.complete(Unit)
        advanceUntilIdle()
        assertEquals(listOf(1 to SpeakerMapping.Self), gateway.sets)
        assertTrue(vm.state.value.saving.isEmpty())
        assertEquals("You", speakerLabel(vm.state.value.speakers.first()))
    }

    @Test fun choosingAPersonSearchesDebouncedAndMapsTheSpeaker() = runTest(dispatcher) {
        val vm = viewModel()
        advanceUntilIdle()
        vm.openPicker(2)
        advanceUntilIdle()
        // The owner is "This is me", not a person to pick.
        assertEquals(listOf("p-maya", "p-jamie"), vm.state.value.picker!!.results.map { it.id })
        vm.onPickerQuery("m")
        vm.onPickerQuery("ma")
        vm.onPickerQuery("may")
        advanceTimeBy(RecordingSpeakersViewModel.SEARCH_DEBOUNCE_MS - 1)
        assertEquals(listOf(""), gateway.queries)
        advanceUntilIdle()
        assertEquals(listOf("", "may"), gateway.queries)
        val maya = vm.state.value.picker!!.results.single()
        vm.choosePerson(2, maya)
        assertNull(vm.state.value.picker)
        assertEquals("Maya", vm.state.value.speakers.first { it.speaker == 2 }.name)
        advanceUntilIdle()
        assertEquals(listOf(2 to SpeakerMapping.Person("p-maya")), gateway.sets)
        assertEquals("p-maya", vm.state.value.speakers.first { it.speaker == 2 }.personId)
    }

    @Test fun namingTrimsAndIgnoresABlankName() = runTest(dispatcher) {
        val vm = viewModel()
        advanceUntilIdle()
        vm.name(2, "   ")
        advanceUntilIdle()
        assertTrue(gateway.sets.isEmpty())
        vm.name(2, "  Jamie  ")
        advanceUntilIdle()
        assertEquals(listOf(2 to SpeakerMapping.Name("Jamie")), gateway.sets)
        assertEquals("Jamie", speakerLabel(vm.state.value.speakers.first { it.speaker == 2 }))
    }

    @Test fun clearUnmapsTheSpeaker() = runTest(dispatcher) {
        gateway.speakers = gateway.speakers.map { if (it.speaker == 1) it.copy(name = "Jamie") else it }
        val vm = viewModel()
        advanceUntilIdle()
        vm.clear(1)
        advanceUntilIdle()
        assertEquals(listOf(1 to SpeakerMapping.Clear), gateway.sets)
        assertFalse(vm.state.value.speakers.first().mapped)
        assertEquals("Speaker 1", speakerLabel(vm.state.value.speakers.first()))
    }

    @Test fun aRefusedChangeRollsBackAndSaysSo() = runTest(dispatcher) {
        val vm = viewModel()
        advanceUntilIdle()
        gateway.failNext = GatewayException.ServerError(500, "boom")
        vm.name(1, "Maya")
        runCurrent()
        advanceUntilIdle()
        val speaker = vm.state.value.speakers.first { it.speaker == 1 }
        assertNull(speaker.name)
        assertTrue(vm.state.value.saving.isEmpty())
        assertEquals("The change could not be saved. Try again.", vm.state.value.message)
        vm.dismissMessage()
        assertNull(vm.state.value.message)
    }

    @Test fun anUnknownPersonRollsBackWithItsOwnMessage() = runTest(dispatcher) {
        val vm = viewModel()
        advanceUntilIdle()
        gateway.failNext = GatewayException.ServerError(400, "no such person")
        vm.choosePerson(1, PersonSummary(id = "p-gone", canonicalName = "Jamie"))
        advanceUntilIdle()
        assertNull(vm.state.value.speakers.first().personId)
        assertEquals("That person is no longer known to the gateway.", vm.state.value.message)
    }

    @Test fun disconnectedChangesRollBack() = runTest(dispatcher) {
        val vm = viewModel()
        advanceUntilIdle()
        connected = false
        vm.setSelf(2)
        advanceUntilIdle()
        assertFalse(vm.state.value.speakers.first { it.speaker == 2 }.isSelf)
        assertEquals("Reconnect to the gateway and try again.", vm.state.value.message)
    }

    @Test fun anotherSpeakersPendingChangeSurvivesTheAnswer() = runTest(dispatcher) {
        val vm = viewModel()
        advanceUntilIdle()
        val first = CompletableDeferred<Unit>()
        gateway.hold = first
        vm.setSelf(1)
        runCurrent()
        // Speaker 2's change is in flight while speaker 1's answer arrives.
        val second = CompletableDeferred<Unit>()
        gateway.hold = second
        vm.name(2, "Jamie")
        runCurrent()
        first.complete(Unit)
        runCurrent()
        assertEquals("Jamie", vm.state.value.speakers.first { it.speaker == 2 }.name)
        second.complete(Unit)
        advanceUntilIdle()
        assertTrue(vm.state.value.speakers.first().isSelf)
        assertEquals("Jamie", vm.state.value.speakers.last().name)
        assertTrue(vm.state.value.saving.isEmpty())
    }

    @Test fun formatsTalkTime() {
        assertEquals("Under a minute", formatTalkTime(5_000))
        assertEquals("1 min", formatTalkTime(61_000))
        assertEquals("4 min", formatTalkTime(240_000))
        assertEquals("1 h", formatTalkTime(3_600_000))
        assertEquals("1 h 5 min", formatTalkTime(3_900_000))
    }
}
