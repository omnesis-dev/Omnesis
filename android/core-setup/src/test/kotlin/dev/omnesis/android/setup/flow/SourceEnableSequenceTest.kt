// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

import dev.omnesis.android.setup.SetupStatusKind
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.SetupUnit
import dev.omnesis.android.transport.ActivationChoice
import dev.omnesis.android.transport.ActivationStep
import dev.omnesis.android.transport.SourceMultiDeviceMode
import dev.omnesis.android.transport.dto.SourceSyncStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SourceEnableSequenceTest {
    private class FakeActions(
        var inspected: ActivationStep = ActivationStep.Ready,
        var committed: ActivationStep = ActivationStep.Ready,
    ) : SourceEnableActions {
        val calls = mutableListOf<String>()
        var on = false
        var inspectGate: CompletableDeferred<Unit>? = null
        var commitGate: CompletableDeferred<Unit>? = null

        override suspend fun inspect(choice: ActivationChoice?): ActivationStep {
            calls += "inspect:${choice ?: "none"}"
            inspectGate?.await()
            return inspected
        }

        override suspend fun commit(choice: ActivationChoice?): ActivationStep {
            calls += "commit:${choice ?: "none"}"
            commitGate?.await()
            if (committed == ActivationStep.Ready) on = true
            return committed
        }
    }

    private class FakeMemory : ExplicitEnableMemory {
        override var pending: Boolean = false
        override var choice: ActivationChoice? = null
    }

    private class Harness(
        val scope: CoroutineScope,
        val actions: FakeActions = FakeActions(),
        var granted: Boolean = false,
        val kind: SetupAccessKind = SetupAccessKind.DIALOG,
        var unavailable: SetupOutcome.Unavailable? = null,
        val memory: FakeMemory = FakeMemory(),
        afterEnable: SetupOutcome = SetupOutcome.On,
    ) {
        val busy = mutableListOf<SetupBusy>()
        val outcomes = mutableListOf<SetupOutcome?>()
        val sequence = SourceEnableSequence(
            scope = scope,
            actions = actions,
            isOn = { actions.on },
            isGranted = { granted },
            outcomeAfterEnable = { afterEnable },
            accessKind = { kind },
            unavailable = { unavailable },
            memory = memory,
            choiceOptions = hostedSourceChoices("Alpha"),
        )
        val watchers: List<Job> = listOf(
            scope.launch { sequence.outcomes.toList(outcomes) },
            scope.launch { sequence.busy.collect { busy += it } },
        )

        fun stop() = watchers.forEach { it.cancel() }
    }

    private fun TestScope.harness(
        actions: FakeActions = FakeActions(),
        granted: Boolean = false,
        kind: SetupAccessKind = SetupAccessKind.DIALOG,
        afterEnable: SetupOutcome = SetupOutcome.On,
        memory: FakeMemory = FakeMemory(),
    ) = Harness(backgroundScope, actions, granted, kind, memory = memory, afterEnable = afterEnable)

    @Test
    fun aGrantedDialogInspectsAsksCommitsAndReadsTheOutcome() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(afterEnable = SetupOutcome.Limited)
        h.sequence.start()
        assertEquals(listOf("inspect:none"), h.actions.calls)
        assertNotNull("the page is asked to open the dialog", h.sequence.launchRequest.value)
        assertEquals(SetupBusy.WAITING_FOR_SYSTEM, h.sequence.busy.value)

        h.sequence.onAccessResult(granted = true)
        assertEquals(listOf("inspect:none", "commit:none"), h.actions.calls)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.Limited), h.outcomes)
        assertEquals(SetupBusy.IDLE, h.sequence.busy.value)
    }

    @Test
    fun aDenialNeverCommits() = runTest(UnconfinedTestDispatcher()) {
        val h = harness()
        h.sequence.start()
        h.sequence.onAccessResult(granted = false)
        assertEquals(listOf("inspect:none"), h.actions.calls)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.NotAllowed), h.outcomes)
        assertEquals(SetupBusy.IDLE, h.sequence.busy.value)
    }

    @Test
    fun anUnavailableProviderIsReportedWithoutAskingAndroid() = runTest(UnconfinedTestDispatcher()) {
        val reason = SetupOutcome.Unavailable("Provider isn't installed", "Install it, then come back.", "Install provider")
        val h = harness()
        h.unavailable = reason
        h.sequence.start()
        assertNull(h.sequence.launchRequest.value)
        assertEquals(listOf<SetupOutcome?>(reason), h.outcomes)
    }

    @Test
    fun theGatewayCanAskForAChoiceBeforeAnyPrompt() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(actions = FakeActions(inspected = ActivationStep.ChoiceRequired(SourceMultiDeviceMode.EXCLUSIVE)))
        h.sequence.start()
        assertNull(h.sequence.launchRequest.value)
        val choice = h.outcomes.single() as SetupOutcome.ChoiceRequired
        assertEquals(listOf("Keep using the other device", "Use only this phone"), choice.options.map { it.title })
        assertEquals("Moves Alpha to this phone, and the other device stops contributing.", choice.options[1].detail)

        h.actions.inspected = ActivationStep.Ready
        h.sequence.choose(choice.options[1])
        h.sequence.onAccessResult(granted = true)
        assertEquals(listOf("inspect:none", "inspect:TAKE_OVER", "commit:TAKE_OVER"), h.actions.calls)
        assertEquals(SetupOutcome.On, h.outcomes.last())
    }

    @Test
    fun keepingTheOtherDeviceIsRecordedAsSuch() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(actions = FakeActions(inspected = ActivationStep.KeptOther))
        h.sequence.start(ActivationChoice.KEEP_OTHER)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.KeptOther), h.outcomes)
    }

    @Test
    fun aFailureCarriesItsMessageAndTryAgainReplacesItWithTheNewOutcome() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(actions = FakeActions(inspected = ActivationStep.Failed("The gateway could not prepare this phone.")))
        h.sequence.start()
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.Failed("The gateway could not prepare this phone.")), h.outcomes)

        h.actions.inspected = ActivationStep.Ready
        h.sequence.retry()
        h.sequence.onAccessResult(granted = true)
        assertEquals(
            "the failure stays on screen while it runs again",
            listOf(SetupOutcome.Failed("The gateway could not prepare this phone."), SetupOutcome.On),
            h.outcomes,
        )
    }

    @Test
    fun aDecisionThatChangedWhileTheDialogWasOpenAsksTheUserToChooseAgain() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(actions = FakeActions(committed = ActivationStep.ChoiceRequired(SourceMultiDeviceMode.EXCLUSIVE)))
        h.sequence.start()
        h.sequence.onAccessResult(granted = true)
        val choice = h.outcomes.single() as SetupOutcome.ChoiceRequired
        assertEquals(listOf("Keep using the other device", "Use only this phone"), choice.options.map { it.title })
    }

    @Test
    fun leavingThePageForgetsASettingsTripAndTheChosenOption() = runTest(UnconfinedTestDispatcher()) {
        val h = harness()
        h.sequence.start(ActivationChoice.TAKE_OVER)
        h.sequence.onAccessResult(granted = false)
        h.sequence.settingsOpened()
        h.sequence.onPageLeft()

        h.granted = true
        h.sequence.onResume()
        assertEquals("a Settings trip from a page that is gone is not continued", listOf("inspect:TAKE_OVER"), h.actions.calls)

        h.sequence.retry()
        assertEquals(
            "the option went with the page",
            listOf("inspect:TAKE_OVER", "inspect:none", "commit:none"),
            h.actions.calls,
        )
    }

    @Test
    fun notNowForgetsTheChosenOption() = runTest(UnconfinedTestDispatcher()) {
        val h = harness()
        h.sequence.start(ActivationChoice.TAKE_OVER)
        h.sequence.onAccessResult(granted = false)
        h.sequence.notNow()
        h.sequence.retry()
        assertEquals("inspect:none", h.actions.calls.last())
    }

    @Test
    fun anUnexpectedExceptionNeverLeavesThePageBusy() = runTest(UnconfinedTestDispatcher()) {
        val actions = object : SourceEnableActions {
            override suspend fun inspect(choice: ActivationChoice?): ActivationStep = error("socket closed")
            override suspend fun commit(choice: ActivationChoice?): ActivationStep = ActivationStep.Ready
        }
        val outcomes = mutableListOf<SetupOutcome?>()
        val sequence = SourceEnableSequence(backgroundScope, actions, { false }, { false }, { SetupOutcome.On })
        backgroundScope.launch { sequence.outcomes.toList(outcomes) }
        sequence.start()
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.Failed(null)), outcomes)
        assertEquals(SetupBusy.IDLE, sequence.busy.value)
    }

    // --- one enable at a time ---

    @Test
    fun aSecondStartWhileTheInspectionIsSuspendedIsIgnored() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(actions = FakeActions().apply { inspectGate = CompletableDeferred() })
        h.sequence.start()
        h.sequence.start()
        h.sequence.retry()
        assertEquals(listOf("inspect:none"), h.actions.calls)
        h.actions.inspectGate!!.complete(Unit)
        assertNotNull(h.sequence.launchRequest.value)
    }

    @Test
    fun aSecondStartWhileTheDialogIsUpOrTheCommitIsSuspendedIsIgnored() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(actions = FakeActions().apply { commitGate = CompletableDeferred() })
        h.sequence.start()
        val firstRequest = h.sequence.launchRequest.value
        h.sequence.start()
        assertEquals("no second dialog while the first is up", firstRequest, h.sequence.launchRequest.value)

        h.sequence.onAccessResult(granted = true)
        h.sequence.start()
        h.sequence.onAccessResult(granted = true)
        assertEquals(listOf("inspect:none", "commit:none"), h.actions.calls)
        h.actions.commitGate!!.complete(Unit)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), h.outcomes)
    }

    @Test
    fun aResumeWhileARoundTripIsBeingReadDoesNotReadItTwice() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(kind = SetupAccessKind.ROUND_TRIP, actions = FakeActions().apply { commitGate = CompletableDeferred() })
        h.sequence.start()
        h.granted = true
        h.sequence.onResume()
        h.sequence.onResume()
        assertEquals(listOf("inspect:none", "commit:none"), h.actions.calls)
        h.actions.commitGate!!.complete(Unit)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), h.outcomes)
    }

    @Test
    fun cancellationWhileTheGatewayIsAskedLeavesThePageIdle() = runTest(UnconfinedTestDispatcher()) {
        val scope = CoroutineScope(coroutineContext + Job())
        val actions = FakeActions().apply { inspectGate = CompletableDeferred() }
        val sequence = SourceEnableSequence(scope, actions, { false }, { false }, { SetupOutcome.On })
        sequence.start()
        assertEquals(SetupBusy.WORKING, sequence.busy.value)
        scope.cancel()
        assertEquals(SetupBusy.IDLE, sequence.busy.value)
    }

    // --- answers that outlive the page that asked ---

    @Test
    fun aGrantThatArrivesAfterTheAskingPageAndProcessAreGoneStillCompletesTheEnable() = runTest(UnconfinedTestDispatcher()) {
        // A fresh sequence stands for the one rebuilt after the app restarted while the dialog was up.
        val h = harness()
        h.sequence.onAccessResult(granted = true)
        assertEquals(listOf("commit:none"), h.actions.calls)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), h.outcomes)
    }

    @Test
    fun aDenialThatArrivesWithNothingWaitingChangesNothing() = runTest(UnconfinedTestDispatcher()) {
        val h = harness()
        h.sequence.onAccessResult(granted = false)
        assertTrue(h.actions.calls.isEmpty())
        assertTrue(h.outcomes.isEmpty())
    }

    @Test
    fun aRoundTripWithAccessAlreadyGrantedCommitsWithoutLeavingTheApp() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(kind = SetupAccessKind.ROUND_TRIP, granted = true)
        h.sequence.start()
        assertNull(h.sequence.launchRequest.value)
        assertEquals(listOf("inspect:none", "commit:none"), h.actions.calls)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), h.outcomes)
    }

    @Test
    fun aRoundTripReadsTheGrantWhenTheAppResumes() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(kind = SetupAccessKind.ROUND_TRIP)
        h.sequence.start()
        assertNotNull(h.sequence.launchRequest.value)
        h.granted = true
        h.sequence.onResume()
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), h.outcomes)
    }

    @Test
    fun aRoundTripThatGrantedNothingIsNotAllowed() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(kind = SetupAccessKind.ROUND_TRIP)
        h.sequence.start()
        h.sequence.onResume()
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.NotAllowed), h.outcomes)
        assertEquals(listOf("inspect:none"), h.actions.calls)
    }

    // --- a grant alone never turns a source on ---

    @Test
    fun anAgreedRoundTripCompletesAfterARestartFromTheGrantItFinds() = runTest(UnconfinedTestDispatcher()) {
        val memory = FakeMemory()
        harness(kind = SetupAccessKind.ROUND_TRIP, memory = memory).sequence.start()
        assertTrue(memory.pending)

        val restarted = harness(kind = SetupAccessKind.ROUND_TRIP, granted = true, memory = memory)
        restarted.sequence.onResume()
        assertEquals(listOf("commit:none"), restarted.actions.calls)
        assertFalse(memory.pending)
    }

    @Test
    fun aGrantThereAfterNotNowNeverTurnsTheSourceOn() = runTest(UnconfinedTestDispatcher()) {
        val memory = FakeMemory()
        val first = harness(kind = SetupAccessKind.ROUND_TRIP, memory = memory)
        first.sequence.start()
        first.sequence.onResume()
        first.sequence.notNow()
        assertFalse(memory.pending)

        val later = harness(kind = SetupAccessKind.ROUND_TRIP, granted = true, memory = memory)
        later.sequence.onResume()
        assertTrue("an old grant with nothing agreed never enables", later.actions.calls.isEmpty())
    }

    @Test
    fun aSettingsTripThatGrantedFinishesTheEnable() = runTest(UnconfinedTestDispatcher()) {
        val h = harness()
        h.sequence.start()
        h.sequence.onAccessResult(granted = false)
        h.sequence.settingsOpened()
        h.sequence.onResume()
        assertEquals("still not granted: nothing changes", 1, h.outcomes.size)

        h.granted = true
        h.sequence.settingsOpened()
        h.sequence.onResume()
        assertEquals(listOf("inspect:none", "commit:none"), h.actions.calls)
        assertEquals(SetupOutcome.On, h.outcomes.last())
    }

    @Test
    fun aSettingsTripForASourceAlreadyOnOnlyRereadsTheOutcome() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(granted = true)
        h.actions.on = true
        h.sequence.settingsOpened()
        h.sequence.onResume()
        assertTrue(h.actions.calls.isEmpty())
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), h.outcomes)
    }

    @Test
    fun moreAccessRereadsTheOutcomeWithoutCommitting() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(afterEnable = SetupOutcome.On)
        h.actions.on = true
        h.sequence.requestMoreAccess()
        assertNotNull(h.sequence.launchRequest.value)
        h.sequence.onAccessResult(granted = true)
        assertTrue(h.actions.calls.isEmpty())
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), h.outcomes)
    }

    @Test
    fun aDialogThatCannotOpenFailsTheEnable() = runTest(UnconfinedTestDispatcher()) {
        val h = harness()
        h.sequence.start()
        h.sequence.onLaunchFailed()
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.Failed(null)), h.outcomes)
        assertEquals(SetupBusy.IDLE, h.sequence.busy.value)
    }

    // --- no avoidable waits ---

    @Test
    fun anEnableAndroidAlreadyAllowsNeverWaitsForAPrompt() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(granted = true)
        h.sequence.start()
        assertNull("no prompt is asked for", h.sequence.launchRequest.value)
        assertFalse("the page never says it is waiting for Android", SetupBusy.WAITING_FOR_SYSTEM in h.busy)
        assertEquals(listOf("inspect:none", "commit:none"), h.actions.calls)
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), h.outcomes)
        assertEquals(SetupBusy.IDLE, h.sequence.busy.value)
    }

    @Test
    fun comingBackFromSettingsWithTheGrantContinuesWithTheChosenOption() = runTest(UnconfinedTestDispatcher()) {
        val h = harness(actions = FakeActions(inspected = ActivationStep.ChoiceRequired(SourceMultiDeviceMode.EXCLUSIVE)))
        h.sequence.start()
        h.actions.inspected = ActivationStep.Ready
        h.sequence.start(ActivationChoice.TAKE_OVER)
        h.sequence.onAccessResult(granted = false)
        assertEquals(SetupOutcome.NotAllowed, h.outcomes.last())

        h.sequence.settingsOpened()
        h.granted = true
        h.sequence.onResume()
        assertEquals("commit:TAKE_OVER", h.actions.calls.last())
        assertEquals(SetupOutcome.On, h.outcomes.last())
    }

    // --- pages, unpairing and saved choices ---

    @Test
    fun leavingThePageDropsAnAgreementOnlyWhenNothingIsUnderWay() = runTest(UnconfinedTestDispatcher()) {
        val memory = FakeMemory()
        val h = harness(kind = SetupAccessKind.ROUND_TRIP, memory = memory)
        h.sequence.start()
        h.sequence.onPageLeft()
        assertTrue("the usage-access screen is still out", memory.pending)

        val restarted = harness(kind = SetupAccessKind.ROUND_TRIP, memory = memory)
        restarted.sequence.onPageLeft()
        assertFalse(memory.pending)
        restarted.granted = true
        restarted.sequence.onResume()
        assertTrue(restarted.actions.calls.isEmpty())
    }

    @Test
    fun resettingCancelsTheCommitAndForgetsEverythingAgreed() = runTest(UnconfinedTestDispatcher()) {
        val memory = FakeMemory()
        val actions = FakeActions().apply { commitGate = CompletableDeferred() }
        val h = harness(actions = actions, memory = memory)
        h.sequence.start()
        h.sequence.markLaunched(h.sequence.launchRequest.value!!.id)
        h.sequence.onAccessResult(granted = true)
        assertEquals(SetupBusy.WORKING, h.sequence.busy.value)

        h.sequence.reset()
        actions.commitGate!!.complete(Unit)

        assertFalse("the commit outlived its pairing", actions.on)
        assertTrue(h.outcomes.isEmpty())
        assertEquals(SetupBusy.IDLE, h.sequence.busy.value)
        assertNull(h.sequence.launchRequest.value)
        assertNull(h.sequence.launchedRequestId)
        assertFalse(memory.pending)
    }

    @Test
    fun aGrantWithNothingWaitingCommitsWithTheChoiceTheAgreementWasMadeWith() = runTest(UnconfinedTestDispatcher()) {
        val memory = FakeMemory()
        harness(kind = SetupAccessKind.ROUND_TRIP, memory = memory).sequence.start(ActivationChoice.TAKE_OVER)
        assertEquals(ActivationChoice.TAKE_OVER, memory.choice)

        val restarted = harness(kind = SetupAccessKind.ROUND_TRIP, memory = memory)
        restarted.granted = true
        restarted.sequence.onResume()
        assertEquals(listOf("commit:TAKE_OVER"), restarted.actions.calls)
        assertNull(memory.choice)

        val dialogMemory = FakeMemory().apply { choice = ActivationChoice.USE_BOTH }
        val dialog = harness(memory = dialogMemory)
        dialog.sequence.onAccessResult(granted = true)
        assertEquals(listOf("commit:USE_BOTH"), dialog.actions.calls)
    }

    @Test
    fun aReplicatedSourceAlsoOffersBothPhones() {
        val options = hostedSourceChoices("Alpha")(SourceMultiDeviceMode.REPLICATED)
        assertEquals(
            listOf(ActivationChoice.KEEP_OTHER.name, ActivationChoice.USE_BOTH.name, ActivationChoice.TAKE_OVER.name),
            options.map { it.id },
        )
        assertEquals("Use both phones", options[1].title)
    }

    // --- status lines ---

    @Test
    fun theStatusLineCountsOnlyWhileSyncingAndOtherwiseReadsTheHeadline() {
        val unit = SetupUnit("record", "records")
        assertEquals(SetupStatusLine.NotSyncedYet, setupStatusLine(null, unit))
        val halfway = SourceSyncStatus("s", state = "syncing", progress = SourceSyncStatus.Progress(processed = 1284, total = 2568))
        assertEquals(SetupStatusLine("1,284 records processed", SetupStatusKind.SYNCING, 0.5f), setupStatusLine(halfway, unit))
        assertEquals("1,284 photos processed", setupStatusLine(halfway.copy(unitName = "photos"), null).text)
        assertEquals("1,284 processed", setupStatusLine(halfway, null).text)
        val starting = SourceSyncStatus("s", state = "syncing", progress = SourceSyncStatus.Progress(processed = 0, total = 10))
        assertEquals("a run that has processed nothing shows its headline", "Syncing…", setupStatusLine(starting, unit).text)
        val synced = SourceSyncStatus("s", state = "synced", progress = SourceSyncStatus.Progress(processed = 1))
        assertEquals(SetupStatusLine("Up to date", SetupStatusKind.UP_TO_DATE), setupStatusLine(synced, unit))
        assertEquals(SetupStatusLine("Syncing…", SetupStatusKind.SYNCING), setupStatusLine(SourceSyncStatus("s", state = "syncing"), unit))
        assertEquals(SetupStatusKind.UP_TO_DATE, setupStatusLine(SourceSyncStatus("s", lastSyncAt = "2026-01-02T10:00:00Z"), unit).kind)
        mapOf(
            "error" to "Last sync failed",
            "needs-auth" to "Needs authorization",
            "auth-expiring" to "Authorization expiring",
            "rate-limited" to "Temporarily limited",
            "stale" to "Not receiving new data",
            "paused" to "Sync paused",
            "disabled" to "Sync paused",
            "unavailable" to "Unavailable",
            "permission-degraded" to "Needs attention",
            "background-access-missing" to "Needs attention",
        ).forEach { (state, headline) ->
            assertEquals(state, SetupStatusLine(headline, SetupStatusKind.ATTENTION), setupStatusLine(SourceSyncStatus("s", state = state), unit))
        }
    }
}
