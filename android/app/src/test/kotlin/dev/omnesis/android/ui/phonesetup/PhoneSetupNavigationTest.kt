// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import android.os.Looper
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import dagger.hilt.EntryPoint
import dagger.hilt.EntryPoints
import dagger.hilt.InstallIn
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSettings
import dev.omnesis.android.feature.photos.PhotosSettings
import dev.omnesis.android.pairing.PairingService
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.flow.PhoneSetupRecord
import dev.omnesis.android.ui.home.HomeScaffoldHarness
import dev.omnesis.android.ui.home.HomeScaffoldHostActivity
import dev.omnesis.android.ui.home.HomeScaffoldHostActivityRule
import dev.omnesis.android.ui.root.RootScreen
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@EntryPoint
@InstallIn(SingletonComponent::class)
interface PhoneSetupNavigationEntryPoint {
    fun phoneSetupRecord(): PhoneSetupRecord
    fun photosSettings(): PhotosSettings
    fun activitySegmentsSettings(): ActivitySegmentsSettings
    fun pairingService(): PairingService
}

/**
 * When the phone setup flow appears, on the real graph: a newly paired phone
 * with nothing on is walked through it; finishing or skipping lands on the
 * shell and is remembered for that device, so a repair of the same device does
 * not show it again; unpairing forgets what the phone contributed and offers
 * it again on the next pairing; and a
 * phone that already has a source on never sees it.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PhoneSetupNavigationTest {
    @get:Rule(order = 0)
    val hilt = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val hostActivity = HomeScaffoldHostActivityRule()

    @get:Rule(order = 2)
    val compose = createAndroidComposeRule<HomeScaffoldHostActivity>()

    private lateinit var harness: HomeScaffoldHarness

    private val graph: PhoneSetupNavigationEntryPoint
        get() = EntryPoints.get(
            ApplicationProvider.getApplicationContext<HiltTestApplication>(),
            PhoneSetupNavigationEntryPoint::class.java,
        )

    @Before
    fun setUp() {
        harness = HomeScaffoldHarness(compose)
        harness.pair()
    }

    @After
    fun tearDown() {
        runCatching { harness.session.beginRepair() }
        harness.close()
    }

    @Test
    fun aNewlyPairedPhoneWithNothingOnIsWalkedThroughSetup() {
        showRoot()
        waitFor { showing("You're connected") }
        assertFalse(showing("Start asking"))
    }

    @Test
    fun finishingLandsOnTheShellAndARepairOfTheSameDeviceDoesNotShowItAgain() {
        showRoot()
        waitFor { showing("Choose what to add") }
        compose.onNodeWithText("Choose what to add").performClick()
        waitFor { showing("What should this phone add?") }
        compose.onNodeWithText("Photos").performClick()
        waitFor { compose.onAllNodes(hasText("Set up 1") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Set up 1").performClick()
        waitFor { showing("Not now") }
        compose.onNodeWithText("Not now").performClick()
        waitFor { showing("Start asking") }
        compose.onNodeWithText("Start asking").performClick()
        waitFor { !setupShowing() }

        assertEquals(PAIRED_DEVICE_ID, graph.phoneSetupRecord().completedForDeviceId.value)
        assertNull("the shell never asked for the notification permission on its own", shadowOf(compose.activity).lastRequestedPermission)

        harness.session.beginRepair()
        waitFor { harness.session.state.value is SessionManager.AppState.Unpaired }
        pairAgain()
        waitFor { harness.session.state.value is SessionManager.AppState.Paired }
        compose.waitForIdle()
        assertFalse(setupShowing())
    }

    @Test
    fun skippingIsRememberedForTheDevice() {
        showRoot()
        waitFor { showing("Choose what to add") }
        compose.onNodeWithText("Choose what to add").performClick()
        waitFor { showing("Skip for now") }
        compose.onNodeWithText("Skip for now").performClick()
        waitFor { !setupShowing() }

        assertEquals(PAIRED_DEVICE_ID, graph.phoneSetupRecord().completedForDeviceId.value)
    }

    @Test
    fun unpairingOffersSetupAgainOnTheNextPairing() {
        showRoot()
        waitFor { showing("Choose what to add") }
        compose.onNodeWithText("Choose what to add").performClick()
        waitFor { showing("Skip for now") }
        compose.onNodeWithText("Skip for now").performClick()
        waitFor { !setupShowing() }

        graph.photosSettings().photosEnabled = true
        harness.session.unpair()
        waitFor { harness.session.state.value is SessionManager.AppState.Unpaired }
        assertNull(graph.phoneSetupRecord().completedForDeviceId.value)
        assertFalse("unpairing forgets what this phone contributed", graph.photosSettings().photosEnabled)

        pairAgain()
        waitFor { showing("You're connected") }
    }

    @Test
    fun aPhoneWithASourceAlreadyOnIsRecordedAsDoneWithoutSeeingSetup() {
        graph.photosSettings().photosEnabled = true
        showRoot()
        waitFor { graph.phoneSetupRecord().completedForDeviceId.value == PAIRED_DEVICE_ID }
        compose.waitForIdle()
        assertFalse(setupShowing())
    }

    @Test
    fun pairingAnotherDeviceStartsFromCleanSourcesAndOffersSetup() {
        // Left behind by a gateway this phone was paired with before, by an app that kept it on unpair.
        graph.phoneSetupRecord().claimLocalState("device-from-another-gateway")
        graph.phoneSetupRecord().markCompleted("device-from-another-gateway")
        graph.photosSettings().photosEnabled = true

        pairAgain()

        assertFalse("the new pairing starts with every source off", graph.photosSettings().photosEnabled)
        assertEquals(PAIRED_DEVICE_ID, graph.phoneSetupRecord().localStateDeviceId)
        assertNull(graph.phoneSetupRecord().completedForDeviceId.value)
        showRoot()
        waitFor { showing("You're connected") }
        assertTrue(
            "nothing is registered for a source the user has not turned on here",
            harness.gateway.requestPaths.none { it.contains("permission-health") || it.contains("/members") },
        )
    }

    @Test
    fun upgradingFromABuildThatKeptOptInsOnUnpairStartsCleanOnTheNextPairing() {
        // What an older build left behind: it unpaired without resetting anything and never recorded whose state this is.
        graph.pairingService().unpair()
        graph.phoneSetupRecord().clear()
        graph.photosSettings().photosEnabled = true
        graph.activitySegmentsSettings().activitySegmentsEnabled = true
        harness.gateway.requests.clear()

        pairAgain()

        assertFalse(graph.photosSettings().photosEnabled)
        assertFalse(graph.activitySegmentsSettings().activitySegmentsEnabled)
        assertEquals(PAIRED_DEVICE_ID, graph.phoneSetupRecord().localStateDeviceId)
        showRoot()
        waitFor { showing("You're connected") }
        assertTrue(
            "no source was registered or joined: ${harness.gateway.requests}",
            harness.gateway.requests.none {
                it == "POST /admin/sources" || (it.startsWith("POST /admin/sources/") && it.endsWith("/members"))
            },
        )
    }

    @Test
    fun aPairingPersistedByAProcessThatDiedBeforeItsSessionStillStartsClean() {
        graph.phoneSetupRecord().claimLocalState("device-from-another-gateway")
        graph.photosSettings().photosEnabled = true
        // The marker a pairing writes before its exchange, and the pairing that exchange persisted; the process died before the session was built.
        graph.phoneSetupRecord().beginPairing()
        runBlocking { graph.pairingService().pairManually(harness.gateway.url, "ABCD-EFGH", harness.gateway.fingerprint) }

        // The next session to be built settles it.
        harness.session.updateGatewayUrl(harness.gateway.url)

        assertFalse(graph.photosSettings().photosEnabled)
        assertEquals(PAIRED_DEVICE_ID, graph.phoneSetupRecord().localStateDeviceId)
        assertFalse(graph.phoneSetupRecord().pairingPending)
    }

    @Test
    fun aRepairKeepsItsSourcesWhateverDeviceTheStateWasRecordedFor() {
        harness.session.state.value
        graph.phoneSetupRecord().claimLocalState("device-recorded-by-an-older-pairing")
        graph.photosSettings().photosEnabled = true

        harness.session.beginRepair()
        waitFor { harness.session.state.value is SessionManager.AppState.Unpaired }
        pairAgain()

        assertTrue(graph.photosSettings().photosEnabled)
        assertFalse(graph.phoneSetupRecord().repairing)
    }

    @Test
    fun repairingTheSameDeviceKeepsItsSources() {
        harness.session.state.value
        assertEquals("the paired install's first session owns its state", PAIRED_DEVICE_ID, graph.phoneSetupRecord().localStateDeviceId)
        graph.photosSettings().photosEnabled = true

        harness.session.beginRepair()
        waitFor { harness.session.state.value is SessionManager.AppState.Unpaired }
        pairAgain()

        assertTrue(graph.photosSettings().photosEnabled)
        assertEquals(PAIRED_DEVICE_ID, graph.phoneSetupRecord().localStateDeviceId)
    }

    private fun showRoot() {
        compose.setContent { RootScreen() }
        compose.waitForIdle()
    }

    private fun pairAgain() {
        runBlocking { harness.session.pairManually(harness.gateway.url, "ABCD-EFGH", harness.gateway.fingerprint) }
    }

    private fun showing(text: String): Boolean = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

    private fun setupShowing(): Boolean = compose.onAllNodesWithTag(PHONE_SETUP_TEST_TAG).fetchSemanticsNodes().isNotEmpty()

    private fun waitFor(condition: () -> Boolean) {
        compose.waitUntil(WAIT_TIMEOUT_MILLIS) {
            shadowOf(Looper.getMainLooper()).idle()
            condition()
        }
        compose.waitForIdle()
    }

    private companion object {
        /** The device id the harness's mock gateway assigns on every pairing. */
        const val PAIRED_DEVICE_ID = "device-test"
        const val WAIT_TIMEOUT_MILLIS = 30_000L
    }
}
