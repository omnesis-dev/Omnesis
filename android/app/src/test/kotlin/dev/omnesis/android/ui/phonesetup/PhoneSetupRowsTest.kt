// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.core.content.UnusedAppRestrictionsConstants
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.SetupStatusKind
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.SetupStepController
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.flow.FirstRunDecision
import dev.omnesis.android.setup.flow.InMemorySetupKeyValueStore
import dev.omnesis.android.setup.flow.PhoneSetupEntry
import dev.omnesis.android.setup.flow.PhoneSetupGate
import dev.omnesis.android.setup.flow.PhoneSetupRecord
import dev.omnesis.android.setup.flow.PhoneSetupScreen
import dev.omnesis.android.setup.flow.PhoneSetupState
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SetupRow
import dev.omnesis.android.setup.ui.SetupChooseRowState
import dev.omnesis.android.ui.root.relayConsentDialogVisible
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneSetupRowsTest {
    private class FakeStep(
        override val id: String,
        override val group: SetupGroup,
        private val available: SetupAvailability = SetupAvailability.Available,
        private val on: Boolean = false,
        private val reread: suspend (SetupOutcome) -> SetupOutcome? = { it },
    ) : PhoneSetupStep {
        override val order: Int = 0
        override val sourceId: String? = null
        override val copy = SetupStepCopy(
            name = id,
            glyph = Icons.Outlined.Sync,
            tint = Color(0xFF4B9BFF),
            row = "row",
            value = "value",
            permissionLabel = "access",
            onBody = "on",
        )
        override val outcomes: Flow<SetupOutcome?> = emptyFlow()

        override fun availability(): SetupAvailability = available

        override fun isOn(): Boolean = on

        override suspend fun refreshOutcome(previous: SetupOutcome): SetupOutcome? = reread(previous)

        @Composable
        override fun rememberController(): SetupStepController = error("not rendered")
    }

    private val steps = listOf(
        FakeStep("offered", SetupGroup.SOURCE),
        FakeStep("already-on", SetupGroup.SOURCE, on = true),
        FakeStep("unsupported", SetupGroup.SOURCE, SetupAvailability.Disabled("Needs Google Play services")),
        FakeStep("absent", SetupGroup.SOURCE, SetupAvailability.Hidden),
        FakeStep("bell", SetupGroup.ALSO, SetupAvailability.Disabled("Off in Settings")),
        FakeStep("battery", SetupGroup.ALSO),
    )

    private fun rows() = steps.map { SetupRow(it.id, it.group, it.availability(), it.isOn()) }

    @Test
    fun chooseLeavesOutHiddenStepsAndShowsOnDisabledAndSelectableRows() {
        val chosen = chooseRows(steps, rows(), selection = setOf("battery"))
        assertEquals(listOf("offered", "already-on", "unsupported", "bell", "battery"), chosen.map { it.id })
        assertEquals(SetupChooseRowState.Selectable(false), chosen[0].state)
        assertEquals(SetupChooseRowState.On, chosen[1].state)
        assertEquals(SetupChooseRowState.Disabled("Needs Google Play services"), chosen[2].state)
        assertEquals(SetupChooseRowState.Disabled("Off in Settings"), chosen[3].state)
        assertEquals(SetupChooseRowState.Selectable(true), chosen[4].state)
    }

    @Test
    fun finishShowsEveryHostableSourceAndOnlyTheOtherStepsThatWereWalked() {
        val state = PhoneSetupState(
            entry = PhoneSetupEntry.FIRST_RUN,
            screen = PhoneSetupScreen.Finish,
            plan = listOf("offered", "battery"),
            outcomes = mapOf("offered" to SetupOutcome.Limited, "battery" to SetupOutcome.On),
        )
        val finished = finishRows(steps, rows(), state, statusLines = mapOf("already-on" to SetupStatusLine("12 items processed", SetupStatusKind.SYNCING)))

        assertEquals(listOf("offered", "already-on", "battery"), finished.map { it.id })
        assertEquals("a source turned on here has not synced yet", SetupStatusLine.NotSyncedYet, finished[0].status)
        assertEquals("12 items processed", finished[1].status?.text)
        assertEquals("On", finished[2].status?.text)
    }

    @Test
    fun aSourceThatEndedOffReadsAsNotSetUp() {
        val state = PhoneSetupState(
            entry = PhoneSetupEntry.FIRST_RUN,
            screen = PhoneSetupScreen.Finish,
            plan = listOf("offered", "battery"),
            outcomes = mapOf("offered" to SetupOutcome.NotAllowed, "battery" to SetupOutcome.Skipped),
        )
        val finished = finishRows(steps, rows(), state, emptyMap())
        assertNull(finished.first { it.id == "offered" }.status)
        assertNull(finished.first { it.id == "battery" }.status)
    }

    @Test
    fun aSourceWhoseOtherDeviceWasKeptSaysSoWithoutAStatus() {
        val state = PhoneSetupState(
            entry = PhoneSetupEntry.FIRST_RUN,
            screen = PhoneSetupScreen.Finish,
            plan = listOf("offered"),
            outcomes = mapOf("offered" to SetupOutcome.KeptOther),
        )
        val row = finishRows(steps, rows(), state, emptyMap()).first { it.id == "offered" }
        assertNull(row.status)
        assertEquals("Sent by another device", row.note)
    }

    @Test
    fun theSettingsSummaryCountsSourcesOnOutOfThoseThisPhoneCanHost() {
        val coordinator = PhoneSetupCoordinator(PhoneSetupRecord(InMemorySetupKeyValueStore()), PhoneSetupGate(), steps.toSet())
        assertEquals(PhoneSetupSummary(on = 1, total = 2), coordinator.summary())
    }

    @Test
    fun decidingTheFirstRunWritesNothingAndSilentCompletionIsItsOwnCall() {
        val record = PhoneSetupRecord(InMemorySetupKeyValueStore())
        val coordinator = PhoneSetupCoordinator(record, PhoneSetupGate(), steps.toSet())
        assertEquals(FirstRunDecision.COMPLETE_SILENTLY, coordinator.firstRunDecision("device-a"))
        assertNull(record.completedForDeviceId.value)

        coordinator.completeSilentlyIfContributing("device-a")
        assertEquals("device-a", record.completedForDeviceId.value)
        assertEquals(FirstRunDecision.SKIP, coordinator.firstRunDecision("device-a"))

        val fresh = PhoneSetupCoordinator(PhoneSetupRecord(InMemorySetupKeyValueStore()), PhoneSetupGate(), setOf(FakeStep("offered", SetupGroup.SOURCE)))
        assertEquals(FirstRunDecision.PRESENT, fresh.firstRunDecision("device-a"))
    }

    @Test
    fun aPairingWithoutADeviceIdIsNeverPresentedOrRecorded() {
        val record = PhoneSetupRecord(InMemorySetupKeyValueStore())
        val coordinator = PhoneSetupCoordinator(record, PhoneSetupGate(), steps.toSet())
        assertEquals(FirstRunDecision.SKIP, coordinator.firstRunDecision(null))
        coordinator.completeSilentlyIfContributing(null)
        assertNull(record.completedForDeviceId.value)
    }

    @Test
    fun movingOnSaysNextWhileAPageFollowsThenDoneForASingleSourceOrFinish() {
        assertEquals("Done", stepNextLabel(PhoneSetupEntry.SOURCE, index = 0, planSize = 1))
        assertEquals("Next", stepNextLabel(PhoneSetupEntry.SOURCE, index = 0, planSize = 2))
        assertEquals("Done", stepNextLabel(PhoneSetupEntry.SOURCE, index = 1, planSize = 2))
        assertEquals("Finish", stepNextLabel(PhoneSetupEntry.SETTINGS, index = 1, planSize = 2))
        assertEquals("Next", stepNextLabel(PhoneSetupEntry.FIRST_RUN, index = 0, planSize = 2))
    }

    @Test
    fun aRefreshRereadsOnlyTheStepsWhoseOutcomeChanged() = runBlocking {
        val stepsOnResume = listOf(
            FakeStep("notifications", SetupGroup.ALSO, reread = { notificationsRefreshedOutcome(it, granted = true) }),
            FakeStep("background", SetupGroup.ALSO, reread = { backgroundSyncingRefreshedOutcome(it, BackgroundSyncingState.ON) }),
            FakeStep("installed-meanwhile", SetupGroup.SOURCE, reread = { null }),
            FakeStep("unchanged", SetupGroup.SOURCE),
            FakeStep("unreadable", SetupGroup.SOURCE, reread = { error("the phone did not answer") }),
        )
        val changed = rereadOutcomes(
            stepsOnResume,
            mapOf(
                "notifications" to SetupOutcome.NotAllowed,
                "background" to SetupOutcome.NotAllowed,
                "installed-meanwhile" to SetupOutcome.Unavailable("Not installed", "Install it, then come back.", "Install"),
                "unchanged" to SetupOutcome.On,
                "unreadable" to SetupOutcome.Limited,
                "gone" to SetupOutcome.On,
            ),
        )
        assertEquals(
            mapOf("notifications" to SetupOutcome.On, "background" to SetupOutcome.On, "installed-meanwhile" to null),
            changed,
        )
    }

    @Test
    fun notificationsReadAgainFollowTheGrantButADeclinedPageStaysDeclined() {
        assertEquals(SetupOutcome.On, notificationsRefreshedOutcome(SetupOutcome.NotAllowed, granted = true))
        assertEquals(SetupOutcome.NotAllowed, notificationsRefreshedOutcome(SetupOutcome.On, granted = false))
        assertEquals(SetupOutcome.Skipped, notificationsRefreshedOutcome(SetupOutcome.Skipped, granted = true))
    }

    @Test
    fun backgroundSyncingReadAgainFollowsTheRestriction() {
        assertEquals(SetupOutcome.On, backgroundSyncingRefreshedOutcome(SetupOutcome.NotAllowed, BackgroundSyncingState.ON))
        assertEquals(SetupOutcome.NotAllowed, backgroundSyncingRefreshedOutcome(SetupOutcome.On, BackgroundSyncingState.LIMITED))
        assertEquals(SetupOutcome.Skipped, backgroundSyncingRefreshedOutcome(SetupOutcome.Skipped, BackgroundSyncingState.LIMITED))
        assertEquals(SetupOutcome.NotAllowed, backgroundSyncingRefreshedOutcome(SetupOutcome.NotAllowed, null))
    }

    @Test
    fun theRelayDialogWaitsForFirstRunAndForAnyShowingOfSetup() {
        assertFalse(relayConsentDialogVisible(firstRunSetup = true, setupPresenting = false))
        assertFalse(relayConsentDialogVisible(firstRunSetup = false, setupPresenting = true))
        assertTrue(relayConsentDialogVisible(firstRunSetup = false, setupPresenting = false))
    }

    @Test
    fun backgroundSyncingNamesTheSettingAsTheRunningAndroidShowsIt() {
        val remove = "In App permissions, turn off Remove permissions if app isn't used."
        val pause = "Turn off Pause app activity if unused."
        assertEquals("the Play services backport", remove, backgroundSyncingSettingsSteps(sdkInt = 29))
        assertEquals(remove, backgroundSyncingSettingsSteps(sdkInt = 30))
        assertEquals(pause, backgroundSyncingSettingsSteps(sdkInt = 31))
        assertEquals(pause, backgroundSyncingSettingsSteps(sdkInt = 34))

        val copy = backgroundSyncingSetupCopy(sdkInt = 34)
        assertEquals("the fine print before the round trip names it", pause, copy.fine)
        assertEquals("the still-limited outcome names it", pause, copy.settingsSteps)
        assertFalse("the off body names no differently worded setting", copy.offBody!!.contains("Pause"))
    }

    @Test
    fun backgroundSyncingIsOfferedOnlyWhileUnusedAppRestrictionsApply() {
        listOf(
            UnusedAppRestrictionsConstants.API_30_BACKPORT,
            UnusedAppRestrictionsConstants.API_30,
            UnusedAppRestrictionsConstants.API_31,
        ).forEach { assertEquals(BackgroundSyncingState.LIMITED, backgroundSyncingState(it)) }
        assertEquals(BackgroundSyncingState.ON, backgroundSyncingState(UnusedAppRestrictionsConstants.DISABLED))
        assertNull(backgroundSyncingState(UnusedAppRestrictionsConstants.FEATURE_NOT_AVAILABLE))
        assertNull(backgroundSyncingState(UnusedAppRestrictionsConstants.ERROR))
        assertNull(backgroundSyncingState(null))
    }
}
