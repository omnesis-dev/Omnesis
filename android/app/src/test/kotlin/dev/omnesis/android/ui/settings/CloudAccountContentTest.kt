// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.text.AnnotatedString
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_UNLINK_TEXT
import dev.omnesis.android.pairing.CLOUD_ACCOUNT_PORTAL_SENTENCE
import dev.omnesis.android.pairing.CloudAccountSettingsController
import dev.omnesis.android.transport.dto.CloudRelayAbilities
import dev.omnesis.android.transport.dto.CloudRelayAccountLink
import dev.omnesis.android.transport.dto.CloudRelayCertificate
import dev.omnesis.android.transport.dto.CloudRelayConfig
import dev.omnesis.android.transport.dto.CloudRelayConnect
import dev.omnesis.android.transport.dto.CloudRelayEnrollment
import dev.omnesis.android.transport.dto.CloudRelayPublicMcp
import dev.omnesis.android.transport.dto.CloudRelayStatus
import dev.omnesis.android.transport.dto.CloudRelayTunnel
import dev.omnesis.android.transport.dto.DeviceEnrollmentSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.TimeZone

/** What the Omnesis account screen offers in each state, and what each control asks for. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h2400dp-xxhdpi")
class CloudAccountContentTest {
    @get:Rule val compose = createComposeRule()

    private val fresh = CloudRelayStatus(
        enabled = false,
        serviceConfigured = true,
        config = CloudRelayConfig("https://relay.example.com"),
        enrollment = CloudRelayEnrollment("unconfigured"),
    )
    private val connected = CloudRelayStatus(
        enabled = true,
        serviceConfigured = true,
        hostname = "g-7f3a91.relay.example.com",
        config = CloudRelayConfig("https://relay.example.com"),
        enrollment = CloudRelayEnrollment("enrolled"),
        tunnel = CloudRelayTunnel("online"),
        publicMcp = CloudRelayPublicMcp(ready = true, url = "https://g-7f3a91.relay.example.com/mcp"),
        account = CloudRelayAccountLink(activated = true, configured = true, linked = true, canUnlink = true),
        deviceEnrollment = DeviceEnrollmentSettings("automatic"),
        can = CloudRelayAbilities(disable = true, reconnect = true),
    )

    /** What "Copy details" and the address button put on the clipboard. */
    private val copied = mutableListOf<String>()
    private val clipboard = object : ClipboardManager {
        override fun setText(annotatedString: AnnotatedString) { copied += annotatedString.text }
        override fun getText(): AnnotatedString? = copied.lastOrNull()?.let(::AnnotatedString)
    }

    private fun show(
        status: CloudRelayStatus?,
        busy: String? = null,
        connectIntent: String? = null,
        actions: CloudAccountActions = CloudAccountActions(),
    ) {
        val state = CloudAccountSettingsController.State(status = status, loading = false, busy = busy, connectIntent = connectIntent)
        compose.setContent {
            CompositionLocalProvider(LocalInspectionMode provides true, LocalClipboardManager provides clipboard) {
                OmnesisTheme {
                    CloudAccountContent(state, onBack = {}, actions = actions, zone = TimeZone.getTimeZone("UTC"), now = { 1_794_387_600_000 })
                }
            }
        }
    }

    @Test fun `not connected offers both ways in and each sends its intent`() {
        val intents = mutableListOf<String>()
        show(fresh, actions = CloudAccountActions(connect = { intents += it }))
        compose.onNodeWithText("Enroll this gateway in your Omnesis Account").assertExists()
        compose.onNodeWithText(
            "An Omnesis account lets you reach your gateway from your phone and laptop outside your home network and pair new devices by signing in. " +
                "Traffic is encrypted end to end, and the keys never leave this gateway. Connecting gives this gateway a public address and a certificate.",
        ).assertExists()
        // Nothing about terms or a preview follows the two buttons.
        assertEquals(0, compose.onAllNodesWithText("terms of service", substring = true).fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("in preview", substring = true).fetchSemanticsNodes().size)
        compose.onNodeWithTag("cloudAccount.problems").assertDoesNotExist()
        compose.onNodeWithText("Create an Omnesis account").performClick()
        compose.onNodeWithText("I already have one").performClick()
        assertEquals(listOf("create", "existing"), intents)
        assertEquals(0, compose.onAllNodesWithText("Connect").fetchSemanticsNodes().size)
    }

    @Test fun `waiting opens the sign-in again, cancels, and shows the code for another device`() {
        val opened = mutableListOf<String>()
        var cancelled = 0
        show(
            fresh.copy(
                connect = CloudRelayConnect("waiting", "https://relay.example.com/begin?request=req-1", "https://relay.example.com/_relay/connect", null, "KXTP-4M9Q"),
            ),
            actions = CloudAccountActions(openSignIn = { opened += it }, cancelConnect = { cancelled++ }),
        )
        compose.onNodeWithText("Open sign-in").performClick()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(listOf("https://relay.example.com/begin?request=req-1"), opened)
        assertEquals(1, cancelled)
        compose.onNodeWithTag("cloudAccount.code").assertExists()
        compose.onNodeWithText("Or on another device, visit relay.example.com/_relay/connect and enter").assertExists()
        // After the sign-in the gateway moves on by itself: nothing here asks to continue.
        assertEquals(0, compose.onAllNodesWithText("Create an Omnesis account").fetchSemanticsNodes().size)
    }

    @Test fun `trying again after a failure signs in to an existing account`() {
        val intents = mutableListOf<String>()
        val failed = fresh.copy(connect = CloudRelayConnect("failed", error = "expired"))
        show(failed, connectIntent = "create", actions = CloudAccountActions(connect = { intents += it }))
        compose.onNodeWithText("Couldn't connect").assertExists()
        compose.onNodeWithText("Try again").performClick()
        assertEquals(listOf("existing"), intents)
        assertEquals(0, compose.onAllNodesWithText("Create an Omnesis account").fetchSemanticsNodes().size)
    }

    @Test fun `a registered gateway without an account is linked from the portal, not from here`() {
        show(connected.copy(account = CloudRelayAccountLink(activated = true, configured = true, linked = false, canLink = true), deviceEnrollment = null))
        compose.onNodeWithText("This gateway is not linked to an Omnesis account.").assertExists()
        compose.onNodeWithText(CLOUD_ACCOUNT_PORTAL_SENTENCE).assertExists()
        assertEquals(0, compose.onAllNodesWithText("Connect to your Omnesis account").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("Unlink this gateway").fetchSemanticsNodes().size)
        assertEquals(0, compose.onAllNodesWithText("Manage your account").fetchSemanticsNodes().size)
        // Without a linked account the enrollment choice decides nothing.
        compose.onNodeWithTag("cloudAccount.newDevices").assertDoesNotExist()
    }

    @Test fun `a failure only manual setup can fix points at the portal`() {
        show(fresh.copy(enrollment = CloudRelayEnrollment("failed", "invitation-required")))
        compose.onNodeWithText("This relay requires an invitation for this gateway ID. $CLOUD_ACCOUNT_PORTAL_SENTENCE").assertExists()
        compose.onNodeWithText("Try again").assertExists()
        assertEquals(0, compose.onAllNodesWithText("Set up manually").fetchSemanticsNodes().size)
        // The headline says what failed; the box still offers the details.
        compose.onNodeWithText("Something needs your attention").assertExists()
        compose.onNodeWithTag("cloudAccount.copyDetails").performScrollTo().performClick()
        assertTrue(copied.single().startsWith("Omnesis account details\nTime: 2026-11-11T09:00:00.000Z\nPage state: failed\nError codes: invitation-required (registration)\n"))
    }

    @Test fun `connected shows three sections and each control asks for its change`() {
        val operations = mutableListOf<String>()
        val policies = mutableListOf<String>()
        val pages = mutableListOf<String>()
        show(connected, actions = CloudAccountActions(run = { operations += it }, setPolicy = { policies += it }, openPage = { pages += it }))
        compose.onNodeWithText("Connected as").assertExists()
        compose.onNodeWithTag("cloudAccount.hostname").assertTextEquals("g-7f3a91.relay.example.com")
        compose.onNodeWithText("This gateway is linked to your Omnesis account.").assertExists()
        compose.onNodeWithText("Manage your account").performScrollTo().performClick()
        // An address that answers has no line under it, and nothing labels the rows.
        compose.onNodeWithTag("cloudAccount.address").assertTextEquals("https://g-7f3a91.relay.example.com/mcp")
        compose.onNodeWithTag("cloudAccount.addressState").assertDoesNotExist()
        for (gone in listOf("Use it in ChatGPT or another MCP client.", "Status", "On", "Address", "Turn on")) {
            assertEquals(gone, 0, compose.onAllNodesWithText(gone).fetchSemanticsNodes().size)
        }
        compose.onNodeWithText("Turning it off stops access from outside your home network. This gateway keeps its address and stays in your Omnesis account.").assertExists()
        compose.onNodeWithText("Turn off").performScrollTo().performClick()
        compose.onNodeWithText("Ask me first").performScrollTo().performClick()
        assertEquals(listOf("disable"), operations)
        assertEquals(listOf("ask"), policies)
        assertEquals(listOf("https://relay.example.com/_relay/account"), pages)
        // Nothing is wrong, so there is no box; and what the screen no longer has stays gone.
        compose.onNodeWithTag("cloudAccount.problems").assertDoesNotExist()
        for (gone in listOf("Trusted sign-ins", "Remove", "Remove from account", "Connection details", "Sign-in methods", "Manage sign-in methods", "Certificate")) {
            assertEquals(gone, 0, compose.onAllNodesWithText(gone).fetchSemanticsNodes().size)
        }
    }

    @Test fun `unlinking the gateway asks first and says what it means`() {
        val operations = mutableListOf<String>()
        show(connected, actions = CloudAccountActions(run = { operations += it }))
        compose.onNodeWithText("Unlink this gateway").performScrollTo().performClick()
        compose.onNodeWithText("Unlink this gateway from your Omnesis account?").assertExists()
        compose.onNodeWithText(CLOUD_ACCOUNT_UNLINK_TEXT).assertExists()
        compose.onNodeWithText("Cancel").performClick()
        assertEquals(emptyList<String>(), operations)
        compose.onNodeWithText("Unlink this gateway").performScrollTo().performClick()
        compose.onNodeWithText("Unlink").performClick()
        assertEquals(listOf("account/unlink"), operations)
        compose.onNodeWithText(CLOUD_ACCOUNT_UNLINK_TEXT).assertDoesNotExist()
        assertEquals(0, compose.onAllNodesWithText("Disconnect this gateway").fetchSemanticsNodes().size)
    }

    @Test fun `the unlink in flight says so`() {
        show(connected, busy = "account/unlink")
        compose.onNodeWithText("Unlinking…").assertIsNotEnabled()
    }

    @Test fun `remote access off turns on from the headline and keeps the account actions`() {
        val operations = mutableListOf<String>()
        val off = connected.copy(enabled = false, tunnel = CloudRelayTunnel("disabled"), publicMcp = CloudRelayPublicMcp(ready = false, url = "https://g-7f3a91.relay.example.com/mcp"), can = CloudRelayAbilities(enable = true))
        show(off, actions = CloudAccountActions(run = { operations += it }))
        compose.onNodeWithText("Remote access is off").assertExists()
        compose.onNodeWithText("Not reachable while remote access is off.").assertExists()
        compose.onNodeWithText("Turn it on to reach this gateway from outside your home network again, at the same address.").assertExists()
        // The button sits in the headline card, with its footnote, as on iOS and in the portal.
        compose.onNode(hasTestTag("cloudAccount.turnOn") and hasAnyAncestor(hasTestTag("cloudAccount.hero"))).performScrollTo().performClick()
        assertEquals(listOf("enable"), operations)
        compose.onNodeWithText("Manage your account").assertExists()
        compose.onNodeWithText("Unlink this gateway").assertExists()
        assertEquals(0, compose.onAllNodesWithText("Turn off").fetchSemanticsNodes().size)
        compose.onNodeWithTag("cloudAccount.problems").assertDoesNotExist()
    }

    @Test fun `an address still being checked is not a problem`() {
        show(connected.copy(publicMcp = CloudRelayPublicMcp(ready = false, url = "https://g-7f3a91.relay.example.com/mcp")))
        compose.onNodeWithText("Checking that this address answers. This takes up to a minute after the gateway connects.").assertExists()
        compose.onNodeWithTag("cloudAccount.problems").assertDoesNotExist()
    }

    @Test fun `what is wrong is said in one box whose details copy as plain text`() {
        show(
            connected.copy(
                certificate = CloudRelayCertificate("valid", lastError = "certificate-renewal-failed"),
                publicMcp = CloudRelayPublicMcp(ready = false, url = "https://g-7f3a91.relay.example.com/mcp", lastError = "public-endpoint-unreachable"),
            ),
        )
        compose.onNodeWithText("Some things need your attention").assertExists()
        compose.onNodeWithText(
            "Need help? Copy the details and paste them to an assistant or a help forum. They contain no passwords or keys. " +
                "Running omnesis cloud status on this gateway prints the same details.",
        ).assertExists()
        compose.onNodeWithText("The certificate for this gateway's address could not be renewed. The gateway tries again by itself.").assertExists()
        compose.onNodeWithText("This gateway's address does not answer from outside your home network. Check that this gateway is online. It checks again by itself.").assertExists()
        compose.onNodeWithText("This address does not answer right now.").assertExists()
        compose.onNodeWithText("Copy details").performScrollTo().performClick()
        val details = copied.single()
        assertTrue(details, "Error codes: certificate-renewal-failed (certificate), public-endpoint-unreachable (address)\n" in details)
        assertTrue(details, "Address: https://g-7f3a91.relay.example.com/mcp (not answering)\n" in details)
        assertFalse(details, "synthetic" in details || "token" in details.lowercase())
    }

    @Test fun `one change at a time`() {
        show(connected, busy = "reconnect")
        compose.onNodeWithText("Turn off").assertIsNotEnabled()
        compose.onNodeWithText("Unlink this gateway").assertIsNotEnabled()
        compose.onNodeWithText("Ask me first").assertIsNotEnabled()
        // Opening the relay's own page changes nothing on the gateway.
        compose.onNodeWithText("Manage your account").assertIsEnabled()
    }
}
