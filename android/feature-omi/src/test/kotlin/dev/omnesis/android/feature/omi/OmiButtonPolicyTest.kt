// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi

import dev.omnesis.android.feature.recording.RecordingInput
import dev.omnesis.android.feature.recording.RecordingState
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class OmiButtonPolicyTest {
    private val state = MutableStateFlow<RecordingState>(RecordingState.Idle)
    private val calls = mutableListOf<String>()
    private var startAllowed = true
    private val alwaysOn = MutableStateFlow(false)
    private var markable = true

    private fun TestScope.policy() = OmiButtonPolicy(
        recording = state,
        startRecording = { calls += "start"; startAllowed },
        stopRecording = { calls += "stop" },
        markMoment = { calls += "mark"; markable },
        alwaysOn = alwaysOn,
        vibrate = { calls += it.name },
        scope = backgroundScope,
        startTimeoutMs = 5_000,
    )

    private fun active(input: RecordingInput, ambient: Boolean = false) =
        RecordingState.Active("s", null, recordedMs = 0, runningSinceMs = 1, chunks = 0, input = input, ambient = ambient)

    @Test fun capturingAllDayATapMarksTheMomentWithOnePulse() = runTest {
        alwaysOn.value = true
        state.value = active(RecordingInput.WEARABLE, ambient = true)
        policy().onButton(OmiButton.TAP)
        assertEquals(listOf("mark", "MARKED"), calls)
    }

    @Test fun capturingAllDayATapThatMarksNothingGivesTheLongPulseAndStartsNothing() = runTest {
        alwaysOn.value = true
        markable = false
        // Between two episodes nothing records for a moment.
        policy().onButton(OmiButton.TAP)
        assertEquals(listOf("mark", "FAILED"), calls)
    }

    @Test fun capturingAllDayATapStillStopsARecordingTheOwnerStarted() = runTest {
        alwaysOn.value = true
        state.value = active(RecordingInput.PHONE)
        policy().onButton(OmiButton.TAP)
        assertEquals(listOf("stop", "STOPPED"), calls)
    }

    @Test fun aTapStartsARecordingAndOnePulseConfirmsItRuns() = runTest {
        val policy = policy()
        policy.onButton(OmiButton.TAP)
        runCurrent()
        assertEquals(listOf("start"), calls)
        state.value = active(RecordingInput.WEARABLE)
        runCurrent()
        assertEquals(listOf("start", "STARTED"), calls)
    }

    @Test fun aStartTheSystemRefusesGivesTheLongPulseAtOnce() = runTest {
        startAllowed = false
        val policy = policy()
        policy.onButton(OmiButton.TAP)
        assertEquals(listOf("start", "FAILED"), calls)
        // And the next tap tries again.
        startAllowed = true
        policy.onButton(OmiButton.TAP)
        assertEquals(listOf("start", "FAILED", "start"), calls)
    }

    @Test fun aStartThatNeverRunsGivesTheLongPulse() = runTest {
        val policy = policy()
        policy.onButton(OmiButton.TAP)
        advanceTimeBy(5_001)
        assertEquals(listOf("start", "FAILED"), calls)
    }

    @Test fun aTapWhileStartingIsIgnored() = runTest {
        val policy = policy()
        policy.onButton(OmiButton.TAP)
        policy.onButton(OmiButton.TAP)
        runCurrent()
        assertEquals(listOf("start"), calls)
    }

    @Test fun aTapWhileRecordingStopsWithTwoPulses() = runTest {
        state.value = active(RecordingInput.WEARABLE)
        policy().onButton(OmiButton.TAP)
        assertEquals(listOf("stop", "STOPPED"), calls)
    }

    @Test fun aTapAlsoStopsARecordingStartedOnThePhone() = runTest {
        state.value = active(RecordingInput.PHONE)
        policy().onButton(OmiButton.TAP)
        assertEquals(listOf("stop", "STOPPED"), calls)
    }

    @Test fun otherEventsDoNothing() = runTest {
        val policy = policy()
        listOf(OmiButton.DOUBLE_TAP, OmiButton.PRESSED, OmiButton.RELEASED).forEach(policy::onButton)
        runCurrent()
        assertEquals(emptyList<String>(), calls)
    }

    @Test fun aPhoneRecordingStartingMeanwhileIsNotTakenForThePendants() = runTest {
        val policy = policy()
        policy.onButton(OmiButton.TAP)
        state.value = active(RecordingInput.PHONE)
        advanceTimeBy(5_001)
        assertEquals(listOf("start", "FAILED"), calls)
    }
}
