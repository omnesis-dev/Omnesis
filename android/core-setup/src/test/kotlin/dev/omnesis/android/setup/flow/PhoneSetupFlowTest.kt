// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.flow

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneSetupFlowTest {
    private val store = InMemorySetupKeyValueStore()
    private val record = PhoneSetupRecord(store)

    private val rows = listOf(
        SetupRow("alpha", SetupGroup.SOURCE, SetupAvailability.Available, on = false),
        SetupRow("beta", SetupGroup.SOURCE, SetupAvailability.Available, on = false),
        SetupRow("gamma", SetupGroup.SOURCE, SetupAvailability.Disabled("Not available on this phone"), on = false),
        SetupRow("delta", SetupGroup.SOURCE, SetupAvailability.Available, on = true),
        SetupRow("bell", SetupGroup.ALSO, SetupAvailability.Available, on = false),
    )

    private val known = rows.map { it.id }.toSet()

    private fun firstRun() = PhoneSetupFlow(record, "device-1", PhoneSetupEntry.FIRST_RUN, known)

    private fun present(deviceId: String?, anySourceOn: Boolean) = PhoneSetupPolicy.decide(record, deviceId, anySourceOn)

    // --- when it presents ---

    @Test
    fun aFreshPairingWithNothingOnPresents() {
        assertEquals(FirstRunDecision.PRESENT, present("device-1", anySourceOn = false))
        assertNull(record.completedForDeviceId.value)
    }

    @Test
    fun anExistingUserWithASourceOnIsCompletedSilentlyAndDecidingWritesNothing() {
        assertEquals(FirstRunDecision.COMPLETE_SILENTLY, present("device-1", anySourceOn = true))
        assertNull("deciding is pure; the caller records the completion", record.completedForDeviceId.value)
    }

    @Test
    fun aRepairKeepingTheDeviceIdDoesNotPresentAgain() {
        firstRun().skipForNow()
        assertEquals(FirstRunDecision.SKIP, PhoneSetupPolicy.decide(PhoneSetupRecord(store), "device-1", anySourceOn = false))
    }

    @Test
    fun aDifferentDeviceIdPresentsAgain() {
        firstRun().skipForNow()
        assertEquals(FirstRunDecision.PRESENT, present("device-2", anySourceOn = false))
    }

    @Test
    fun unpairClearsTheCompletion() {
        firstRun().startAsking()
        record.clear()
        assertEquals(FirstRunDecision.PRESENT, present("device-1", anySourceOn = false))
    }

    @Test
    fun noDeviceIdNeverPresentsAndNeverRecords() {
        assertEquals(FirstRunDecision.SKIP, present(null, anySourceOn = false))
        val legacy = PhoneSetupFlow(record, null, PhoneSetupEntry.FIRST_RUN, known)
        legacy.chooseWhatToAdd()
        legacy.skipForNow()
        assertNull(record.completedForDeviceId.value)
        assertNull(store.get(PhoneSetupRecord.KEY_PROGRESS))
    }

    @Test
    fun anUnfinishedFlowResumesEvenAfterItTurnedASourceOn() {
        val flow = firstRun()
        flow.chooseWhatToAdd()
        flow.toggle(rows[0])
        flow.setUp(rows)
        flow.record("alpha", SetupOutcome.On)

        assertEquals(FirstRunDecision.PRESENT, present("device-1", anySourceOn = true))
    }

    @Test
    fun progressSavedForAnotherDeviceDoesNotKeepThisOneFromCompletingSilently() {
        PhoneSetupFlow(record, "device-2", PhoneSetupEntry.FIRST_RUN, known).chooseWhatToAdd()
        assertEquals(FirstRunDecision.COMPLETE_SILENTLY, present("device-1", anySourceOn = true))
    }

    // --- selection and walking ---

    @Test
    fun firstRunStartsAtConnectedAndSettingsAtChoose() {
        assertEquals(PhoneSetupScreen.Connected, firstRun().state.value.screen)
        assertEquals(PhoneSetupScreen.Choose, PhoneSetupFlow(record, "device-1", PhoneSetupEntry.SETTINGS, known).state.value.screen)
    }

    @Test
    fun onlySelectableRowsToggle() {
        val flow = firstRun()
        flow.chooseWhatToAdd()
        rows.forEach(flow::toggle)
        assertEquals(setOf("alpha", "beta", "bell"), flow.state.value.selection)
        assertEquals(3, flow.state.value.selectedCount(rows))
        flow.toggle(rows[1])
        assertEquals(2, flow.state.value.selectedCount(rows))
    }

    @Test
    fun settingUpWalksTheSelectionInRowOrderThenFinishes() {
        val flow = firstRun()
        flow.chooseWhatToAdd()
        flow.toggle(rows[4])
        flow.toggle(rows[1])
        flow.toggle(rows[0])
        flow.setUp(rows)

        assertEquals(listOf("alpha", "beta", "bell"), flow.state.value.plan)
        assertEquals(PhoneSetupScreen.Step("alpha"), flow.state.value.screen)
        assertEquals(0, flow.state.value.stepIndex)
        flow.next()
        assertEquals(PhoneSetupScreen.Step("beta"), flow.state.value.screen)
        flow.next()
        flow.next()
        assertEquals(PhoneSetupScreen.Finish, flow.state.value.screen)
    }

    @Test
    fun settingUpNothingStaysOnChoose() {
        val flow = firstRun()
        flow.chooseWhatToAdd()
        flow.setUp(rows)
        assertEquals(PhoneSetupScreen.Choose, flow.state.value.screen)
    }

    @Test
    fun notNowRecordsASkipAndAdvances() {
        val flow = walking("alpha", "beta")
        flow.record("alpha", SetupOutcome.Skipped)
        assertEquals(PhoneSetupScreen.Step("beta"), flow.state.value.screen)
        assertEquals(SetupOutcome.Skipped, flow.state.value.outcomes["alpha"])
    }

    // --- pages the host inserts before Finish ---

    @Test
    fun aPageInsertedDuringASourceStepComesLastBeforeFinish() {
        val flow = walking("alpha", "beta")
        flow.insertBeforeFinish("wakes")
        assertEquals(listOf("alpha", "beta", "wakes"), flow.state.value.plan)

        flow.record("alpha", SetupOutcome.On)
        flow.next()
        flow.record("beta", SetupOutcome.On)
        flow.next()
        assertEquals(PhoneSetupScreen.Step("wakes"), flow.state.value.screen)
        flow.removeInserted("wakes")
        assertEquals(PhoneSetupScreen.Finish, flow.state.value.screen)
        assertEquals(listOf("alpha", "beta"), flow.state.value.plan)
    }

    @Test
    fun aPageInsertedBeforeChoosingStaysAfterTheChosenSteps() {
        val flow = firstRun()
        flow.chooseWhatToAdd()
        flow.insertBeforeFinish("wakes")
        flow.toggle(rows[0])
        flow.setUp(rows)
        assertEquals(listOf("alpha", "wakes"), flow.state.value.plan)
        assertEquals(PhoneSetupScreen.Step("alpha"), flow.state.value.screen)
    }

    @Test
    fun aWithdrawnPageIsDroppedAndNothingIsInsertedOnceFinishShows() {
        val flow = walking("alpha")
        flow.insertBeforeFinish("wakes")
        flow.removeInserted("wakes")
        assertEquals(listOf("alpha"), flow.state.value.plan)
        assertEquals(PhoneSetupScreen.Step("alpha"), flow.state.value.screen)

        flow.record("alpha", SetupOutcome.On)
        flow.next()
        assertEquals(PhoneSetupScreen.Finish, flow.state.value.screen)
        flow.insertBeforeFinish("wakes")
        assertEquals(listOf("alpha"), flow.state.value.plan)
    }

    @Test
    fun aSingleSourceRunClosesAfterItsInsertedPage() {
        val flow = PhoneSetupFlow(record, "device-1", PhoneSetupEntry.SOURCE, known, focusStepId = "beta")
        flow.insertBeforeFinish("wakes")
        flow.record("beta", SetupOutcome.On)
        flow.next()
        assertEquals(PhoneSetupScreen.Step("wakes"), flow.state.value.screen)
        flow.removeInserted("wakes")
        assertTrue(flow.state.value.closed)
    }

    @Test
    fun onlyAPairingOfTheSameDeviceKeepsTheLocalState() {
        assertTrue("a repair keeps its state", pairingKeepsLocalState("device-1", "device-1"))
        assertFalse("another gateway starts clean", pairingKeepsLocalState("device-1", "device-2"))
        assertFalse("state no pairing recorded starts clean", pairingKeepsLocalState(null, "device-1"))
        assertFalse(pairingKeepsLocalState("device-1", null))
    }

    @Test
    fun onlyANewPairingThatIsNotARepairOfTheRecordedDeviceStartsClean() {
        assertTrue("another gateway", pairingStartsClean(pending = true, repairing = false, recordedDeviceId = "device-1", deviceId = "device-2"))
        assertTrue("state no pairing recorded", pairingStartsClean(pending = true, repairing = false, recordedDeviceId = null, deviceId = "device-1"))
        assertFalse("the recorded device again", pairingStartsClean(pending = true, repairing = false, recordedDeviceId = "device-1", deviceId = "device-1"))
        assertFalse("a repair naming another device", pairingStartsClean(pending = true, repairing = true, recordedDeviceId = "device-1", deviceId = "device-2"))
        assertFalse("a legacy repair naming no device", pairingStartsClean(pending = true, repairing = true, recordedDeviceId = null, deviceId = null))
        assertFalse("a session with no pairing under way", pairingStartsClean(pending = false, repairing = false, recordedDeviceId = null, deviceId = "device-1"))
    }

    @Test
    fun aPairingUnderWayIsRememberedUntilItsSessionSettlesIt() {
        record.beginRepair()
        record.beginPairing()
        assertTrue(record.pairingPending)
        assertTrue(PhoneSetupRecord(store).repairing)
        record.finishPairing()
        assertFalse(record.pairingPending)
        assertFalse(record.repairing)
    }

    @Test
    fun unpairingForgetsWhichDeviceTheLocalStateBelongsTo() {
        record.claimLocalState("device-1")
        assertEquals("device-1", record.localStateDeviceId)
        record.clear()
        assertNull(record.localStateDeviceId)
    }

    @Test
    fun keepingTheOtherDeviceMovesOnAndIsRememberedAsSuch() {
        val flow = walking("alpha", "beta")
        flow.record("alpha", SetupOutcome.KeptOther)
        assertEquals(PhoneSetupScreen.Step("beta"), flow.state.value.screen)

        val resumed = PhoneSetupFlow(PhoneSetupRecord(store), "device-1", PhoneSetupEntry.FIRST_RUN, known).state.value
        assertEquals(SetupOutcome.KeptOther, resumed.outcomes["alpha"])
        assertFalse("a kept device is not this phone contributing", resumed.contributing)
    }

    @Test
    fun everyOtherOutcomeStaysOnItsPageUntilNext() {
        listOf(
            SetupOutcome.On,
            SetupOutcome.Limited,
            SetupOutcome.Partial,
            SetupOutcome.NotAllowed,
            SetupOutcome.Unavailable("Missing", "Install it.", "Install"),
            SetupOutcome.ChoiceRequired(listOf(SetupChoice("KEEP_OTHER", "Keep using the other device", "Nothing changes."))),
            SetupOutcome.Failed("The gateway could not prepare this phone."),
        ).forEach { outcome ->
            record.clear()
            val flow = walking("alpha", "beta")
            flow.record("alpha", outcome)
            assertEquals(PhoneSetupScreen.Step("alpha"), flow.state.value.screen)
            assertEquals(outcome, flow.state.value.outcomes["alpha"])
        }
    }

    @Test
    fun aClearedOutcomeMakesTheStepUnresolvedAgain() {
        val flow = walking("alpha")
        flow.record("alpha", SetupOutcome.Unavailable("Missing", "Install it.", "Install"))
        flow.record("alpha", null)
        assertNull(flow.state.value.outcomes["alpha"])
    }

    @Test
    fun anOutcomeRecordedForAnEarlierStepDoesNotMoveTheCurrentPage() {
        val flow = walking("alpha", "beta")
        flow.next()
        flow.record("alpha", SetupOutcome.Skipped)
        assertEquals(PhoneSetupScreen.Step("beta"), flow.state.value.screen)
    }

    @Test
    fun backWalksToThePreviousPageAndStopsAtTheRoot() {
        val flow = walking("alpha", "beta")
        flow.next()
        flow.next()
        assertEquals(PhoneSetupScreen.Finish, flow.state.value.screen)
        assertTrue(flow.back())
        assertEquals(PhoneSetupScreen.Step("beta"), flow.state.value.screen)
        assertTrue(flow.back())
        assertTrue(flow.back())
        assertEquals(PhoneSetupScreen.Choose, flow.state.value.screen)
        assertTrue(flow.back())
        assertEquals(PhoneSetupScreen.Connected, flow.state.value.screen)
        assertFalse(flow.back())
    }

    @Test
    fun backFromChooseOpenedInSettingsIsTheHostsToHandle() {
        val flow = PhoneSetupFlow(record, "device-1", PhoneSetupEntry.SETTINGS, known)
        assertFalse(flow.back())
    }

    @Test
    fun goingBackToChooseKeepsResolvedOutcomes() {
        val flow = walking("alpha", "beta")
        flow.record("alpha", SetupOutcome.On)
        flow.back()
        flow.toggle(rows[1])
        flow.setUp(rows)
        assertEquals(listOf("alpha"), flow.state.value.plan)
        assertEquals(SetupOutcome.On, flow.state.value.outcomes["alpha"])
    }

    @Test
    fun contributingAndTheHintFollowTheWalkedOutcomes() {
        val flow = walking("alpha", "beta")
        assertFalse(flow.state.value.contributing)
        flow.record("alpha", SetupOutcome.NotAllowed)
        flow.record("beta", SetupOutcome.Limited)
        assertTrue(flow.state.value.contributing)
        assertNull(flow.state.value.firstOnStepId)
        flow.record("alpha", SetupOutcome.On)
        assertEquals("alpha", flow.state.value.firstOnStepId)
    }

    // --- completion ---

    @Test
    fun skipAndStartAskingCloseAndComplete() {
        val skipped = firstRun()
        skipped.chooseWhatToAdd()
        skipped.skipForNow()
        assertTrue(skipped.state.value.closed)
        assertEquals("device-1", record.completedForDeviceId.value)
        assertNull(record.progress("device-1"))

        record.clear()
        val finished = walking("alpha")
        finished.next()
        finished.startAsking()
        assertTrue(finished.state.value.closed)
        assertEquals("device-1", record.completedForDeviceId.value)
    }

    @Test
    fun aClosedFlowIgnoresFurtherInput() {
        val flow = walking("alpha")
        flow.startAsking()
        flow.back()
        flow.next()
        assertTrue(flow.state.value.closed)
        assertEquals(PhoneSetupScreen.Step("alpha"), flow.state.value.screen)
    }

    // --- resume after the app is killed ---

    @Test
    fun aKilledFirstRunResumesAtTheSameStepWithItsOutcomes() {
        val flow = walking("alpha", "beta", "bell")
        flow.record("alpha", SetupOutcome.Limited)
        flow.next()
        flow.record("beta", SetupOutcome.ChoiceRequired(emptyList()))

        val resumed = PhoneSetupFlow(PhoneSetupRecord(store), "device-1", PhoneSetupEntry.FIRST_RUN, known).state.value
        assertEquals(PhoneSetupScreen.Step("beta"), resumed.screen)
        assertEquals(listOf("alpha", "beta", "bell"), resumed.plan)
        assertEquals(setOf("alpha", "beta", "bell"), resumed.selection)
        assertEquals(SetupOutcome.Limited, resumed.outcomes["alpha"])
        assertNull("a pending choice is asked again", resumed.outcomes["beta"])
    }

    @Test
    fun aPositionSavedForAnotherDeviceIsNotResumed() {
        walking("alpha")
        val other = PhoneSetupFlow(PhoneSetupRecord(store), "device-2", PhoneSetupEntry.FIRST_RUN, known)
        assertEquals(PhoneSetupScreen.Connected, other.state.value.screen)
    }

    @Test
    fun aSettingsFlowSavesNoPosition() {
        val flow = PhoneSetupFlow(record, "device-1", PhoneSetupEntry.SETTINGS, known)
        flow.toggle(rows[0])
        flow.setUp(rows)
        assertNull(record.progress("device-1"))
        flow.next()
        flow.startAsking()
        assertTrue(flow.state.value.closed)
        assertNull("a flow opened from Settings never changes the record", record.completedForDeviceId.value)
    }

    @Test
    fun anUnreadableSavedPositionStartsOver() {
        store.put(PhoneSetupRecord.KEY_PROGRESS, "{not json")
        assertEquals(PhoneSetupScreen.Connected, firstRun().state.value.screen)
        assertNull(store.get(PhoneSetupRecord.KEY_PROGRESS))
    }

    @Test
    fun aSavedPositionDropsStepsThisBuildNoLongerHas() {
        walking("alpha", "beta")
        val narrower = PhoneSetupFlow(PhoneSetupRecord(store), "device-1", PhoneSetupEntry.FIRST_RUN, setOf("beta", "bell")).state.value
        assertEquals(listOf("beta"), narrower.plan)
        assertEquals(setOf("beta"), narrower.selection)
        assertEquals("the saved page was a step that is gone", PhoneSetupScreen.Choose, narrower.screen)
    }

    // --- one source opened from its Settings card ---

    @Test
    fun aSingleSourceFlowShowsOnlyThatPageAndClosesAfterItWithoutRecording() {
        val flow = PhoneSetupFlow(record, "device-1", PhoneSetupEntry.SOURCE, known, focusStepId = "beta")
        assertEquals(PhoneSetupScreen.Step("beta"), flow.state.value.screen)
        assertEquals(listOf("beta"), flow.state.value.plan)
        assertFalse("back returns to Settings", flow.back())
        flow.record("beta", SetupOutcome.On)
        flow.next()
        assertTrue(flow.state.value.closed)
        assertNull(record.completedForDeviceId.value)
    }

    @Test
    fun notNowOnASingleSourceFlowClosesIt() {
        val flow = PhoneSetupFlow(record, "device-1", PhoneSetupEntry.SOURCE, known, focusStepId = "alpha")
        flow.record("alpha", SetupOutcome.Skipped)
        assertTrue(flow.state.value.closed)
    }

    @Test
    fun aSingleSourceFlowForAnUnknownStepClosesAtOnce() {
        assertTrue(PhoneSetupFlow(record, "device-1", PhoneSetupEntry.SOURCE, known, focusStepId = "gone").state.value.closed)
    }

    // --- the presentation gate ---

    @Test
    fun theGateStaysUpUntilEveryHolderDismisses() {
        val gate = PhoneSetupGate()
        assertFalse(gate.presenting.value)
        gate.present("first-run")
        gate.present("settings")
        gate.dismiss("first-run")
        assertTrue(gate.presenting.value)
        gate.dismiss("settings")
        assertFalse(gate.presenting.value)
    }

    @Test
    fun aKilledFlowOnAnInsertedPageReopensAtFinishWithoutIt() {
        val flow = walking("alpha")
        flow.insertBeforeFinish("wakes")
        flow.record("alpha", SetupOutcome.On)
        flow.next()
        assertEquals(PhoneSetupScreen.Step("wakes"), flow.state.value.screen)

        val reopened = firstRun().state.value
        assertEquals(PhoneSetupScreen.Finish, reopened.screen)
        assertEquals(listOf("alpha"), reopened.plan)
        assertTrue(reopened.inserted.isEmpty())
    }

    @Test
    fun aKilledFlowBeforeFinishWalksAnInsertedPageOnlyOnceTheHostInsertsItAgain() {
        walking("alpha", "beta").insertBeforeFinish("wakes")

        val reopened = firstRun()
        assertEquals(listOf("alpha", "beta"), reopened.state.value.plan)
        assertEquals(PhoneSetupScreen.Step("alpha"), reopened.state.value.screen)
        reopened.insertBeforeFinish("wakes")
        assertEquals(listOf("alpha", "beta", "wakes"), reopened.state.value.plan)
    }

    @Test
    fun aSourceUntickedBeforeTheAppDiedIsNotWalked() {
        val flow = walking("alpha", "beta")
        assertTrue(flow.back())
        assertEquals(PhoneSetupScreen.Choose, flow.state.value.screen)
        flow.toggle(rows[1])

        val reopened = firstRun()
        reopened.setUp(rows)
        assertEquals(listOf("alpha"), reopened.state.value.plan)
        reopened.next()
        assertEquals(PhoneSetupScreen.Finish, reopened.state.value.screen)
    }

    @Test
    fun aSkipOnASingleSourcePageMovesOnToTheInsertedPage() {
        val flow = PhoneSetupFlow(record, "device-1", PhoneSetupEntry.SOURCE, known, focusStepId = "beta")
        flow.insertBeforeFinish("wakes")
        flow.record("beta", SetupOutcome.Skipped)
        assertEquals(PhoneSetupScreen.Step("wakes"), flow.state.value.screen)
        assertFalse(flow.state.value.closed)
    }

    private fun walking(vararg ids: String): PhoneSetupFlow {
        val flow = firstRun()
        flow.chooseWhatToAdd()
        rows.filter { it.id in ids }.forEach(flow::toggle)
        flow.setUp(rows)
        return flow
    }
}
