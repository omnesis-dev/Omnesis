// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Tasks bar's Tell Omnesis button on the real shell: a tap opens the same capture
 * destination as the menu's Tell Omnesis entry, and closing it returns to Tasks.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class HomeScaffoldTasksCaptureTest {
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
    fun theTasksBarsTellOmnesisButtonOpensCapture() {
        harness.composeShell()
        harness.waitUntil { "/status" in harness.gateway.requestPaths }
        compose.runOnUiThread { harness.nav.navigate("tasks") }
        harness.waitUntil { harness.currentRoute == "tasks" }

        val button = compose.onNodeWithTag("tasks.tellOmnesis")
        button.assertIsDisplayed()
        button.assertContentDescriptionEquals("Tell Omnesis")
        button.performClick()

        harness.waitUntil { harness.currentRoute == CAPTURE_ROUTE }
        assertEquals("tasks", harness.nav.previousBackStackEntry?.destination?.route)
        assertTrue(
            "the capture screen is not headed Tell Omnesis",
            compose.onAllNodes(hasText("Tell Omnesis")).fetchSemanticsNodes().isNotEmpty(),
        )

        compose.onNodeWithContentDescription("Cancel").performClick()
        harness.waitUntil { harness.currentRoute == "tasks" }
        compose.onNodeWithTag("tasks.tellOmnesis").assertIsDisplayed()
    }

    @Test
    fun externalLaunchStartsUnifiedCaptureAndKeepsTheInAppDraftUnderneath() {
        harness.composeShell()
        harness.waitUntil { "/status" in harness.gateway.requestPaths }
        compose.runOnUiThread { harness.nav.navigate("capture?surface=android-app") }
        harness.waitUntil { harness.currentRoute == CAPTURE_ROUTE }
        compose.onNode(hasSetTextAction()).performTextInput("Keep this unfinished note")
        val previousEntry = harness.nav.currentBackStackEntry!!.id

        compose.runOnUiThread { harness.captureLaunchBus.post(dev.omnesis.android.ui.capture.CaptureSurface.TILE) }
        harness.waitUntil { harness.nav.currentBackStackEntry?.id != previousEntry }
        assertEquals("android-tile", harness.nav.currentBackStackEntry?.arguments?.getString("surface"))
        assertTrue(compose.onAllNodes(hasText("Ask")).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText("Tell")).fetchSemanticsNodes().isNotEmpty())

        compose.onNodeWithContentDescription("Cancel").performClick()
        harness.waitUntil { harness.nav.currentBackStackEntry?.id == previousEntry }
        compose.onNode(hasSetTextAction()).assertTextContains("Keep this unfinished note")
    }

    @Test
    fun externalCaptureUsesTheWatchDecisionGateWithoutASeparatePhoneCapability() {
        harness.gateway.statusJson = """{
            "documents":{"total":0,"bySource":{}},
            "watchCapture":{"supported":true,"enabled":true,"active":true}
        }"""
        harness.composeShell()
        compose.runOnUiThread { harness.captureLaunchBus.post(dev.omnesis.android.ui.capture.CaptureSurface.TILE) }
        harness.waitUntil { harness.currentRoute == CAPTURE_ROUTE }
        harness.waitUntil { compose.onAllNodes(hasText("Send")).fetchSemanticsNodes().isNotEmpty() }
        assertTrue(compose.onAllNodes(hasText("Ask")).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasText("Tell")).fetchSemanticsNodes().isEmpty())

        compose.onNodeWithContentDescription("Cancel").performClick()
        harness.waitUntil { harness.currentRoute != CAPTURE_ROUTE }
        harness.gateway.statusJson = """{
            "documents":{"total":0,"bySource":{}},
            "watchCapture":{"supported":true,"enabled":false,"active":false},
            "capture":{"supported":true,"enabled":true,"active":true}
        }"""
        compose.runOnUiThread { harness.captureLaunchBus.post(dev.omnesis.android.ui.capture.CaptureSurface.TILE) }
        harness.waitUntil { harness.currentRoute == CAPTURE_ROUTE }
        assertTrue(compose.onAllNodes(hasText("Ask")).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText("Tell")).fetchSemanticsNodes().isNotEmpty())
        assertTrue(compose.onAllNodes(hasText("Send")).fetchSemanticsNodes().isEmpty())
    }

    private companion object {
        const val CAPTURE_ROUTE = "capture?surface={surface}"
    }
}
