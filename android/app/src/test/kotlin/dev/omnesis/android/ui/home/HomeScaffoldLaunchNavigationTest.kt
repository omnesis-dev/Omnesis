// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import dev.omnesis.android.session.SessionManager
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The shell's launch-time navigation on the real graph: what a tapped privacy notification
 * lands on, and how the held answer read on becoming active yields to it.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class HomeScaffoldLaunchNavigationTest {
    @get:Rule(order = 0)
    val hilt = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val hostActivity = HomeScaffoldHostActivityRule()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<HomeScaffoldHostActivity>()

    private lateinit var harness: HomeScaffoldHarness

    @Before
    fun setUp() {
        harness = HomeScaffoldHarness(compose)
        harness.pair()
    }

    @After
    fun tearDown() {
        harness.close()
    }

    @Test
    fun aPrivacyApprovalLaunchLandsOnTheDecisionItNamesWithoutExperimentalMode() {
        harness.composeShell()
        harness.waitUntil { "/status" in harness.gateway.requestPaths }
        assertFalse(harness.session.experimentalEnabled.value)

        harness.launchBus.postPrivacyApproval("approval-launch")
        harness.waitUntil { harness.currentRoute == HomeScaffoldHarness.PRIVACY_APPROVAL_ROUTE }

        assertEquals("approval-launch", harness.currentApprovalId)
        assertEquals("agent", harness.nav.previousBackStackEntry?.destination?.route)
        assertFalse(harness.session.experimentalEnabled.value)
        compose.runOnIdle { assertNull(harness.launchBus.privacyApproval.value) }
    }

    /**
     * ON_START arms the queue read; the launch arrives while the read is in flight; the read's
     * reply lands last. The reply must not stack a second decision on the one the operator
     * asked for — and the session's single presentation must still be available afterwards.
     */
    @Test
    fun anExplicitLaunchHandledBeforeALateQueueReplyWinsAndLeavesThePresentationUnspent() {
        harness.gateway.heldApprovalId = "approval-held"
        val hold = harness.gateway.holdApprovalsReplies()

        harness.composeShell()
        harness.waitUntil { harness.gateway.approvalsReads() == 1 }

        harness.launchBus.postPrivacyApproval("approval-launch")
        harness.waitUntil { harness.currentApprovalId == "approval-launch" }

        hold.release()
        harness.waitUntil { harness.viewModel.privacyPendingCount.value == 1 }
        compose.waitForIdle()

        assertEquals(listOf("approval-launch"), harness.approvalsOpened)
        assertEquals("approval-launch", harness.currentApprovalId)
        assertEquals("agent", harness.nav.previousBackStackEntry?.destination?.route)

        // The presentation was not spent on the dropped offer: the next foreground, with no
        // launch of its own, opens the held answer.
        harness.background()
        harness.foreground()
        harness.waitUntil { harness.currentApprovalId == "approval-held" }

        assertEquals(listOf("approval-launch", "approval-held"), harness.approvalsOpened)
    }

    /**
     * Stopping the session is what ends the background work a paired session starts — the
     * device socket's reconnect loop above all — so the gateway hears nothing more from it.
     */
    @Test
    fun stoppingTheSessionLeavesTheGatewayQuiet() {
        harness.composeShell()
        harness.waitUntil { "/status" in harness.gateway.requestPaths }

        harness.stopSession()
        assertTrue(harness.session.state.value is SessionManager.AppState.Unpaired)
        assertNull(harness.session.session)

        val requestsAtStop = harness.gateway.requestPaths.size
        Thread.sleep(QUIET_WINDOW_MILLIS)
        assertEquals(requestsAtStop, harness.gateway.requestPaths.size)
    }

    /** With no launch, becoming active opens the held answer once per session, and not again. */
    @Test
    fun theHeldAnswerIsPresentedOnForegroundOnceInASession() {
        harness.gateway.heldApprovalId = "approval-held"

        harness.composeShell()
        harness.waitUntil { harness.currentApprovalId == "approval-held" }
        assertEquals("agent", harness.nav.previousBackStackEntry?.destination?.route)

        val readsBefore = harness.gateway.approvalsReads()
        harness.background()
        harness.foreground()
        harness.waitUntil { harness.gateway.approvalsReads() > readsBefore }
        compose.waitForIdle()

        assertTrue(harness.viewModel.privacyPendingCount.value == 1)
        assertEquals(listOf("approval-held"), harness.approvalsOpened)
    }

    private companion object {
        /** Longer than the socket's largest early reconnect backoff, so a surviving loop would show. */
        const val QUIET_WINDOW_MILLIS = 3_000L
    }
}
