// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import dagger.hilt.EntryPoints
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.devices.DevicesScreen
import dev.omnesis.android.ui.devices.DevicesViewModel
import dev.omnesis.android.ui.home.HomeScaffoldHarnessEntryPoint
import dev.omnesis.android.ui.home.MockGateway
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Real Hilt session, authenticated admin HTTP and the actual sheet-open/dismiss wiring. */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class GoogleDevicesApprovalIntegrationTest {
    @get:Rule(order = 0) val hilt = HiltAndroidRule(this)
    @get:Rule(order = 1) val compose = createComposeRule()
    private val graph get() = EntryPoints.get(ApplicationProvider.getApplicationContext<HiltTestApplication>(), HomeScaffoldHarnessEntryPoint::class.java)
    private val gateway = MockGateway()

    // These cases run the graph as a build with cloud connectivity.
    init { dev.omnesis.android.ui.home.HomeScaffoldTestModule.cloudRelay = true }

    @After fun close() {
        try { graph.sessionManager().beginRepair(); gateway.close() }
        finally { dev.omnesis.android.ui.home.HomeScaffoldTestModule.cloudRelay = false }
    }

    @Test fun admin_device_opens_and_dismisses_requests_and_retirement_removes_the_admin_affordance() {
        runBlocking { graph.sessionManager().pairFromQr("""{"v":4,"gatewayUrl":"${gateway.url.trimEnd('/')}","pairingCode":"ABCD-EFGH","tls":{"mode":"pinned-leaf-strict","fingerprint":"${gateway.fingerprint}"}}""") }
        val vm = DevicesViewModel(graph.sessionManager(), dev.omnesis.android.access.PairingPendingRequests())
        compose.setContent { OmnesisTheme { DevicesScreen(onBack = {}, cloudFeatures = true, vm = vm) } }
        compose.onNodeWithContentDescription("Pairing requests").performClick()
        compose.onNodeWithText("Pairing requests").assertExists()
        compose.onNodeWithText("Done").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { it() }
        compose.mainClock.advanceTimeByFrame(); compose.waitForIdle()
        compose.waitUntil(timeoutMillis = 5000) { compose.onAllNodesWithText("Pairing requests").fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithContentDescription("Pairing requests").performClick()
        compose.onNodeWithText("Pairing requests").assertExists()
        compose.runOnIdle { graph.sessionManager().beginRepair(); vm.load() }
        compose.mainClock.advanceTimeByFrame(); compose.waitForIdle()
        compose.onNodeWithContentDescription("Pairing requests").assertDoesNotExist()
        compose.waitUntil(timeoutMillis = 5000) { compose.onAllNodesWithText("Pairing requests").fetchSemanticsNodes().isEmpty() }
    }
}
