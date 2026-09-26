// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.journeys

import android.Manifest
import android.content.Intent
import android.os.Build
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import dev.omnesis.android.MainActivity
import java.util.UUID
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.rules.TestRule
import org.junit.runner.RunWith

/**
 * The app's main journeys, driven the way a person drives them — launch, tap,
 * type, read what appears — against a real synthetic gateway.
 *
 * `scripts/run-mobile-journeys.sh android` boots the gateway (the `default`
 * universe, with the replay agent standing in for a model) and runs this class
 * on an emulator. The test orchestrator clears the app's data before every
 * journey, so each one starts from a fresh install: pairing drives the pairing
 * screen, and the others pair through the DEBUG launch seam with a code of
 * their own, so one broken journey does not cascade into the rest.
 *
 * The data the journeys look for is invented and lives in
 * `evals/universes/default/`: the Granola note "Acme Q3 Planning" and the
 * replayed `temporal-recall` agent scenario.
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@LargeTest
class MobileJourneyTest {
    private val compose: ComposeTestRule = createEmptyComposeRule()

    @get:Rule
    val rules: TestRule = RuleChain
        .outerRule(notificationPermission())
        .around(JourneyFailureCapture(compose))
        .around(compose)

    private val gateway = JourneyGateway.fromInstrumentationArguments()
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private var scenario: ActivityScenario<MainActivity>? = null

    @After
    fun closeApp() {
        scenario?.close()
    }

    /**
     * Onboarding → pairing screen → decline the camera → paste the QR payload
     * the gateway minted → confirm the host → phone setup's "You're connected"
     * page, and the gateway lists the new phone.
     */
    @Test
    fun pairingWithTheGatewaysPayload() {
        val deviceName = "Journey Android ${UUID.randomUUID().toString().take(8)}"
        val pairing = gateway.mintPairing(deviceName)
        scenario = ActivityScenario.launch(MainActivity::class.java)

        tap("onboarding.pair")
        // The scanner asks for the camera first; a person pairing by code declines.
        device.wait(Until.findObject(By.res("com.android.permissioncontroller", "permission_deny_button")), 10_000)
            ?.click()
        tap("pairing.manual")
        waitForTag("pairing.pasteJSON.field")
        compose.onNodeWithTag("pairing.pasteJSON.field").performTextInput(pairing.payload)
        tap("pairing.pasteJSON.submit")

        waitFor(hasText(gateway.hostAndPort), "the confirmation sheet never named ${gateway.hostAndPort}")
        tap("pairing.confirm")

        waitFor(hasText("Connection verified"), "pairing never reached phone setup's connected page", PAIRING_TIMEOUT_MS)
        assertTrue("the gateway does not list $deviceName", gateway.hasDevice(deviceName, "android"))

        skipPhoneSetup()
        waitForTag("agentComposer")
    }

    /** Menu → Search → type a query → the matching document is listed. */
    @Test
    fun searchListsAMatchingDocument() {
        launchPaired()
        search(DOCUMENT_TITLE)
        waitFor(searchResult(DOCUMENT_TITLE), "searching for \"$DOCUMENT_TITLE\" did not list the document")
    }

    /** Search → tap a result → the document opens with its content. */
    @Test
    fun openingASearchResultShowsTheDocument() {
        launchPaired()
        search(DOCUMENT_TITLE)
        waitFor(searchResult(DOCUMENT_TITLE), "searching for \"$DOCUMENT_TITLE\" did not list the document")
        compose.onAllNodes(searchResult(DOCUMENT_TITLE)).onFirst().performClick()
        waitFor(hasText(DOCUMENT_LINE, substring = true), "the opened document does not show \"$DOCUMENT_LINE\"")
    }

    /**
     * Ask screen → type a question → send → the agent's answer streams in. The
     * gateway's replay backend answers from a recorded scenario, so no model runs.
     */
    @Test
    fun askingTheAgentShowsItsAnswer() {
        launchPaired()
        waitForTag("agentComposer")
        compose.onNodeWithTag("agentComposer").performTextInput(AGENT_QUESTION)
        tap("agentSendButton")
        waitFor(hasText(AGENT_ANSWER, substring = true), "the agent's answer did not mention \"$AGENT_ANSWER\"", AGENT_TIMEOUT_MS)
    }

    // --- steps ---

    /** Launches the app paired through the DEBUG seam, which runs the real code exchange. */
    private fun launchPaired() {
        val pairing = gateway.mintPairing("Journey Android ${UUID.randomUUID().toString().take(8)}")
        val intent = Intent(ApplicationProvider.getApplicationContext(), MainActivity::class.java)
            .putExtra("seed_url", gateway.url)
            .putExtra("seed_code", pairing.code)
            .putExtra("seed_fingerprint", gateway.fingerprint)
        scenario = ActivityScenario.launch(intent)
        waitFor(hasText("Connection verified"), "the seeded pairing never reached phone setup", PAIRING_TIMEOUT_MS)
        skipPhoneSetup()
    }

    private fun skipPhoneSetup() {
        tap("phoneSetup.choose")
        tap("phoneSetup.skip")
    }

    private fun search(query: String) {
        tap("menu.toggle")
        tap("menu.search")
        waitForTag("search.field")
        compose.onNodeWithTag("search.field").performTextInput(query)
        compose.onNodeWithTag("search.field").performImeAction()
    }

    private fun searchResult(title: String): SemanticsMatcher =
        hasTestTag("search.result") and hasText(title, substring = true)

    private fun tap(tag: String) {
        waitForTag(tag)
        compose.onAllNodesWithTag(tag).onFirst().performClick()
    }

    private fun waitForTag(tag: String) = waitFor(hasTestTag(tag), "$tag never appeared")

    private fun waitFor(matcher: SemanticsMatcher, failure: String, timeoutMs: Long = STEP_TIMEOUT_MS) {
        try {
            compose.waitUntilAtLeastOneExists(matcher, timeoutMs)
        } catch (timeout: androidx.compose.ui.test.ComposeTimeoutException) {
            throw AssertionError(failure, timeout)
        }
    }

    private fun notificationPermission(): TestRule =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            RuleChain.emptyRuleChain()
        }

    private companion object {
        const val DOCUMENT_TITLE = "Acme Q3 Planning"
        const val DOCUMENT_LINE = "Draft the migration plan by Friday"
        const val AGENT_QUESTION = "Where was I on September 2?"
        const val AGENT_ANSWER = "Studio Northstar"
        const val STEP_TIMEOUT_MS = 30_000L
        const val PAIRING_TIMEOUT_MS = 60_000L
        const val AGENT_TIMEOUT_MS = 60_000L
    }
}
