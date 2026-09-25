// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import dev.omnesis.android.session.RelayConsentActions
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.flow.InMemorySetupKeyValueStore
import dev.omnesis.android.setup.flow.PhoneSetupEntry
import dev.omnesis.android.setup.flow.PhoneSetupFlow
import dev.omnesis.android.setup.flow.PhoneSetupRecord
import dev.omnesis.android.setup.flow.PhoneSetupScreen
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SetupRow
import dev.omnesis.android.ui.root.relayConsentDialogVisible
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A relay request inside phone setup: a page before Finish whenever one is
 * waiting, with notifications on, before the flow closes; gone once withdrawn
 * or once notifications are off; and answered there the way the standalone
 * sheet answers it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RelayConsentSetupTest {
    private class FakeConsent : RelayConsentActions {
        override val relayConsentPrompt = MutableStateFlow<SessionManager.RelayConsentPrompt?>(null)
        var granted = 0
        var dismissed = 0

        /** Where an allow runs, as the session's own scope does; null settles it at once. */
        var sessionScope: CoroutineScope? = null
        val gatewayAnswer = CompletableDeferred<Unit>()

        override fun allowRelayConsent() {
            val waiting = relayConsentPrompt.value ?: return
            val scope = sessionScope ?: return settle()
            relayConsentPrompt.value = waiting.copy(requesting = true)
            scope.launch {
                gatewayAnswer.await()
                settle()
            }
        }

        private fun settle() {
            granted += 1
            relayConsentPrompt.value = null
        }

        override fun dismissRelayConsent() {
            dismissed += 1
            relayConsentPrompt.value = null
        }

        fun request() {
            relayConsentPrompt.value = SessionManager.RelayConsentPrompt("device-1", "dev.example.omnesis")
        }
    }

    private val rows = listOf(
        SetupRow("photos", SetupGroup.SOURCE, SetupAvailability.Available, on = false),
        SetupRow("notifications", SetupGroup.ALSO, SetupAvailability.Available, on = false),
    )
    private val consent = FakeConsent()
    private val flow = PhoneSetupFlow(
        PhoneSetupRecord(InMemorySetupKeyValueStore()),
        "device-1",
        PhoneSetupEntry.FIRST_RUN,
        rows.map { it.id }.toSet() + RELAY_CONSENT_STEP_ID,
    )
    private val setup = RelayConsentSetup(flow, consent)

    /** What the flow's view model does: every change of the request, or of notifications, reaches the flow. */
    private fun follow(notificationsOn: Boolean = true) = setup.onPrompt(consent.relayConsentPrompt.value, notificationsOn)

    private fun walkBoth() {
        flow.chooseWhatToAdd()
        rows.forEach(flow::toggle)
        flow.setUp(rows)
    }

    /** Walks both steps with a request waiting, onto the relay page. */
    private fun onTheRelayPage() {
        walkBoth()
        consent.request()
        follow()
        flow.next()
        flow.next()
        assertEquals(PhoneSetupScreen.Step(RELAY_CONSENT_STEP_ID), flow.state.value.screen)
    }

    /** Whether the root would show the standalone sheet once the flow has closed. */
    private fun standaloneSheetShows(): Boolean =
        relayConsentDialogVisible(firstRunSetup = false, setupPresenting = false) && consent.relayConsentPrompt.value != null

    @Test
    fun aRequestArrivingDuringASourceStepIsAskedRightBeforeFinish() {
        walkBoth()
        consent.request()
        follow()

        assertEquals(listOf("photos", "notifications", RELAY_CONSENT_STEP_ID), flow.state.value.plan)
        flow.record("photos", SetupOutcome.On)
        flow.next()
        flow.record("notifications", SetupOutcome.On)
        flow.next()
        assertEquals(PhoneSetupScreen.Step(RELAY_CONSENT_STEP_ID), flow.state.value.screen)
    }

    @Test
    fun notNowInTheFlowDefersTheRequestAsTheSheetDoesAndMovesToFinish() {
        onTheRelayPage()

        setup.notNow()
        follow()

        assertEquals(1, consent.dismissed)
        assertEquals(PhoneSetupScreen.Finish, flow.state.value.screen)
        flow.startAsking()
        assertTrue(flow.state.value.closed)
        assertFalse("the deferred request has nothing for the sheet to show on this visit", standaloneSheetShows())
    }

    @Test
    fun afterNotNowTheRelayPageIsNotAddedAgainInTheSameFlow() {
        onTheRelayPage()
        setup.notNow()
        follow()
        assertTrue(flow.back())

        // Back from a trip to system Settings, the app's next visit may raise the request again.
        consent.request()
        follow()

        assertEquals(listOf("photos", "notifications"), flow.state.value.plan)
        flow.next()
        assertEquals(PhoneSetupScreen.Finish, flow.state.value.screen)
    }

    @Test
    fun allowedInTheFlowTheRequestIsGrantedOnceAndTheWalkMovesOn() {
        onTheRelayPage()

        setup.allow()
        follow()

        assertEquals(1, consent.granted)
        assertEquals(PhoneSetupScreen.Finish, flow.state.value.screen)
        assertFalse("allowing settles the request on the gateway", standaloneSheetShows())
    }

    @Test
    fun leavingThePageDoesNotCancelAnAllowUnderWay() = runTest {
        consent.sessionScope = CoroutineScope(Job() + UnconfinedTestDispatcher(testScheduler))
        onTheRelayPage()

        val page = CoroutineScope(Job() + UnconfinedTestDispatcher(testScheduler))
        page.launch { setup.allow() }
        assertTrue(consent.relayConsentPrompt.value!!.requesting)
        page.coroutineContext[Job]!!.cancel()

        consent.gatewayAnswer.complete(Unit)
        runCurrent()
        assertEquals(1, consent.granted)
        assertNull(consent.relayConsentPrompt.value)
    }

    @Test
    fun aRequestArrivingAfterTheFlowClosedIsLeftToTheStandaloneSheet() {
        walkBoth()
        flow.next()
        flow.next()
        flow.startAsking()

        consent.request()
        follow()

        assertTrue(standaloneSheetShows())
        assertFalse(RELAY_CONSENT_STEP_ID in flow.state.value.plan)
    }

    @Test
    fun aWithdrawnRequestTakesItsPageOutOfTheWalk() {
        walkBoth()
        consent.request()
        follow()
        consent.relayConsentPrompt.value = null
        follow()

        assertEquals(listOf("photos", "notifications"), flow.state.value.plan)
    }

    @Test
    fun withNotificationsSkippedAWaitingRequestAddsNoPage() {
        walkBoth()
        consent.request()
        follow(notificationsOn = false)
        flow.record("photos", SetupOutcome.On)
        flow.next()
        flow.record("notifications", SetupOutcome.Skipped)
        follow(notificationsOn = false)

        assertEquals(PhoneSetupScreen.Finish, flow.state.value.screen)
        assertEquals(listOf("photos", "notifications"), flow.state.value.plan)
    }

    @Test
    fun notificationsTurnedOffInSettingsMidFlowTakeTheRelayPageOut() = runTest {
        val notificationsOn = MutableStateFlow(true)
        walkBoth()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { setup.follow(consent.relayConsentPrompt, notificationsOn) }
        consent.request()
        assertTrue(RELAY_CONSENT_STEP_ID in flow.state.value.plan)

        notificationsOn.value = false

        assertEquals(listOf("photos", "notifications"), flow.state.value.plan)
    }

    @Test
    fun notificationsTurnedOnInSettingsMidFlowAddTheRelayPageWithoutWalkingTheirStep() = runTest {
        val notificationsOn = MutableStateFlow(false)
        walkBoth()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { setup.follow(consent.relayConsentPrompt, notificationsOn) }
        consent.request()
        assertFalse(RELAY_CONSENT_STEP_ID in flow.state.value.plan)

        notificationsOn.value = true

        assertEquals(listOf("photos", "notifications", RELAY_CONSENT_STEP_ID), flow.state.value.plan)
        assertEquals(PhoneSetupScreen.Step("photos"), flow.state.value.screen)
    }
}
