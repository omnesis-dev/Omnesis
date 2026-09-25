// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import android.content.ComponentName
import android.os.Bundle
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import dagger.hilt.EntryPoint
import dagger.hilt.EntryPoints
import dagger.hilt.InstallIn
import dagger.hilt.android.AndroidEntryPoint
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.feature.photos.PhotosSettings
import dev.omnesis.android.notifications.NotificationLaunchBus
import dev.omnesis.android.pairing.PairingService
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.flow.PhoneSetupEntry
import dev.omnesis.android.setup.flow.PhoneSetupGate
import dev.omnesis.android.setup.flow.PhoneSetupRecord
import dev.omnesis.android.ui.capture.CaptureLaunchBus
import dev.omnesis.android.ui.capture.CaptureSurface
import dev.omnesis.android.ui.home.HomeScaffold
import dev.omnesis.android.ui.home.HomeScaffoldHarness
import dev.omnesis.android.ui.home.MockGateway
import dev.omnesis.android.ui.home.PHONE_SETUP_ROUTE_PATTERN
import dev.omnesis.android.ui.home.SETTINGS_ROUTE
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

/** A shell that composes itself on creation, so a recreated activity rebuilds it the way the app's own does. */
@AndroidEntryPoint
class PhoneSetupShellActivity : ComponentActivity() {
    lateinit var nav: NavHostController

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            val controller = rememberNavController()
            nav = controller
            HomeScaffold(nav = controller)
        }
    }
}

@EntryPoint
@InstallIn(SingletonComponent::class)
interface PhoneSetupGateEntryPoint {
    fun pairingService(): PairingService
    fun notificationLaunchBus(): NotificationLaunchBus
    fun captureLaunchBus(): CaptureLaunchBus
    fun sessionManager(): SessionManager
    fun phoneSetupRecord(): PhoneSetupRecord
    fun phoneSetupGate(): PhoneSetupGate
    fun photosSettings(): PhotosSettings
}

/**
 * Phone setup reopened from Settings, on the real graph: launches that arrive
 * while it shows wait and land once it closes, including after the activity
 * is recreated under it; Back, Skip and Finish return to Settings and leave
 * the first-run record alone; a source card's "Set up" shows only that
 * source's page and returns.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PhoneSetupGateTest {
    @get:Rule(order = 0)
    val hilt = HiltAndroidRule(this)

    @get:Rule(order = 1)
    val compose = createEmptyComposeRule()

    private val gateway = MockGateway()
    private lateinit var scenario: ActivityScenario<PhoneSetupShellActivity>

    private val graph: PhoneSetupGateEntryPoint
        get() = EntryPoints.get(ApplicationProvider.getApplicationContext<HiltTestApplication>(), PhoneSetupGateEntryPoint::class.java)

    @Before
    fun setUp() {
        val application = ApplicationProvider.getApplicationContext<HiltTestApplication>()
        shadowOf(application.packageManager).addActivityIfNotPresent(ComponentName(application, PhoneSetupShellActivity::class.java))
        runBlocking { graph.pairingService().pairManually(gateway.url, "ABCD-EFGH", gateway.fingerprint) }
        scenario = ActivityScenario.launch(PhoneSetupShellActivity::class.java)
        waitFor { "/status" in gateway.requestPaths }
    }

    @After
    fun tearDown() {
        runCatching { graph.sessionManager().beginRepair() }
        scenario.close()
        gateway.close()
    }

    @Test
    fun aPrivacyApprovalWaitsBehindTheFlowAndLandsOnceItCloses() {
        openSetupFromSettings()
        graph.notificationLaunchBus().postPrivacyApproval("approval-launch")
        settle()

        assertEquals(PHONE_SETUP_ROUTE_PATTERN, route())
        assertEquals("approval-launch", graph.notificationLaunchBus().privacyApproval.value?.approvalId)

        compose.onNodeWithText("Skip for now").performClick()
        waitFor { route() == HomeScaffoldHarness.PRIVACY_APPROVAL_ROUTE }
        assertNull(graph.phoneSetupRecord().completedForDeviceId.value)
    }

    @Test
    fun aCaptureLaunchWaitsBehindTheFlowAndOpensOnceItCloses() {
        openSetupFromSettings()
        graph.captureLaunchBus().post(CaptureSurface.APP)
        settle()

        assertEquals(PHONE_SETUP_ROUTE_PATTERN, route())

        compose.onNodeWithText("Skip for now").performClick()
        waitFor { route()?.startsWith("capture") == true }
    }

    @Test
    fun theFlowKeepsHoldingLaunchesAcrossActivityRecreation() {
        openSetupFromSettings()
        graph.notificationLaunchBus().postPrivacyApproval("approval-launch")
        settle()

        scenario.recreate()
        waitFor { showing("What should this phone add?") }

        assertEquals(PHONE_SETUP_ROUTE_PATTERN, route())
        assertTrue(graph.phoneSetupGate().presenting.value)
        assertEquals("approval-launch", graph.notificationLaunchBus().privacyApproval.value?.approvalId)

        compose.onNodeWithText("Skip for now").performClick()
        waitFor { route() == HomeScaffoldHarness.PRIVACY_APPROVAL_ROUTE }
        waitFor { !graph.phoneSetupGate().presenting.value }
    }

    @Test
    fun backFromChooseReturnsToSettingsAndReleasesTheGate() {
        openSetupFromSettings()
        scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }

        waitFor { route() == SETTINGS_ROUTE }
        waitFor { !graph.phoneSetupGate().presenting.value }
        assertNull(graph.phoneSetupRecord().completedForDeviceId.value)
    }

    @Test
    fun skippingReturnsToSettingsWithoutRecordingAnything() {
        openSetupFromSettings()
        compose.onNodeWithText("Skip for now").performClick()

        waitFor { route() == SETTINGS_ROUTE }
        assertNull(graph.phoneSetupRecord().completedForDeviceId.value)
    }

    @Test
    fun finishingReturnsToSettingsWithoutRecordingAnything() {
        openSetupFromSettings()
        compose.onNodeWithText("Photos").performClick()
        waitFor { compose.onAllNodes(hasText("Set up 1") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Set up 1").performClick()
        waitFor { showing("Not now") }
        compose.onNodeWithText("Not now").performClick()
        waitFor { showing("Start asking") }
        compose.onNodeWithText("Start asking").performClick()

        waitFor { route() == SETTINGS_ROUTE }
        assertNull(graph.phoneSetupRecord().completedForDeviceId.value)
        assertFalse(graph.photosSettings().photosEnabled)
    }

    @Test
    fun aSourceCardOpensOnlyThatSourcesPageAndReturnsToSettings() {
        navigate(SETTINGS_ROUTE)
        waitFor { showing("Set up Photos") }
        compose.onNodeWithText("Set up Photos").performScrollTo().performClick()

        waitFor { showing("Agree & continue") }
        assertFalse(showing("What should this phone add?"))
        assertEquals(PHONE_SETUP_ROUTE_PATTERN, route())
        assertEquals(PhoneSetupEntry.SOURCE.name, entryArgument())
        assertTrue(graph.phoneSetupGate().presenting.value)

        compose.onNodeWithText("Not now").performClick()
        waitFor { route() == SETTINGS_ROUTE }
        assertFalse(graph.photosSettings().photosEnabled)
        assertNull(graph.phoneSetupRecord().completedForDeviceId.value)
    }

    private fun openSetupFromSettings() {
        navigate(SETTINGS_ROUTE)
        waitFor { showing("Set up this phone") }
        compose.onNodeWithText("Set up this phone").performScrollTo().performClick()
        waitFor { showing("What should this phone add?") }
        assertTrue(setupShowing())
    }

    private fun navigate(route: String) {
        scenario.onActivity { it.nav.navigate(route) { launchSingleTop = true } }
        settle()
    }

    private fun route(): String? {
        var current: String? = null
        scenario.onActivity { current = it.nav.currentBackStackEntry?.destination?.route }
        return current
    }

    private fun entryArgument(): String? {
        var entry: String? = null
        scenario.onActivity { entry = it.nav.currentBackStackEntry?.arguments?.getString(PHONE_SETUP_ENTRY_ARGUMENT) }
        return entry
    }

    private fun showing(text: String): Boolean = compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()

    private fun setupShowing(): Boolean = compose.onAllNodesWithTag(PHONE_SETUP_TEST_TAG).fetchSemanticsNodes().isNotEmpty()

    private fun settle() {
        shadowOf(Looper.getMainLooper()).idle()
        compose.waitForIdle()
    }

    private fun waitFor(condition: () -> Boolean) {
        compose.waitUntil(WAIT_TIMEOUT_MILLIS) {
            shadowOf(Looper.getMainLooper()).idle()
            condition()
        }
        compose.waitForIdle()
    }

    private companion object {
        const val WAIT_TIMEOUT_MILLIS = 30_000L
    }
}
