// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.unit.Density
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.pairing.GatewayPairingApprovalController
import dev.omnesis.android.pairing.GatewayPasskeySigner
import dev.omnesis.android.transport.dto.GatewayPasskeyCeremony
import dev.omnesis.android.transport.dto.GatewayPasskeyLocation
import dev.omnesis.android.transport.dto.GatewayPairingApproving
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.ui.devices.GatewayPairingApprovalContent
import dev.omnesis.android.ui.devices.PAIRING_APPROVAL_TEXT
import dev.omnesis.android.ui.devices.GatewayPairingApprovalSheet
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class GooglePairingApprovalPresentationTest {
    @get:Rule val compose = createComposeRule()
    private fun request(expiry: Long = 1_100_000) = GatewayPairingApprovalRequest(
        "00000000-0000-4000-8000-000000000901", "android", "Test phone", "pending", "465 774", expiry)

    @Test fun full_code_comparison_and_actions_remain_accessible_at_large_font_and_busy_expired_empty_states() {
        val row = request()
        val state = mutableStateOf(GatewayPairingApprovalController.State(requests = listOf(row)))
        val decisions = mutableListOf<Boolean>()
        var refreshes = 0
        var dismisses = 0
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 2f)) {
                OmnesisTheme {
                    GatewayPairingApprovalContent(state.value, 1_000_000,

                        onRefresh = { refreshes++ }, onDecide = { _, approve -> decisions += approve }, onDismiss = { dismisses++ })
                }
            }
        }
        compose.onNodeWithTag("pairingApproval.code").performScrollTo().assertTextEquals(row.verificationCode)
        compose.onNodeWithTag("pairingApproval.compare").assertDoesNotExist()
        compose.onNodeWithTag("pairingApproval.approve").performScrollTo().assertIsEnabled().performClick()
        compose.onNodeWithText("Approve").assertExists()
        compose.onNodeWithText(PAIRING_APPROVAL_TEXT).assertExists()
        // Nothing else explains the request: the one sentence, the code and the two actions.
        for (gone in listOf("Reject request", "Codes match — approve device", "Signed in to your Omnesis account with Google")) compose.onNodeWithText(gone).assertDoesNotExist()
        compose.onNodeWithText("Compare every code group", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Deny").performScrollTo().performClick()
        assertEquals(listOf(true, false), decisions)
        compose.runOnIdle { state.value = state.value.copy(busy = true) }
        compose.onNodeWithTag("pairingApproval.approve").assertIsNotEnabled()
        compose.onNodeWithText("Updating…").performScrollTo().assertExists()
        compose.runOnIdle { state.value = state.value.copy(busy = false, requests = listOf(row.copy(expiresAt = 999_999))) }
        compose.onNodeWithText("Expired").performScrollTo().assertExists()
        compose.onNodeWithTag("pairingApproval.approve").assertDoesNotExist()
        compose.runOnIdle { state.value = state.value.copy(requests = listOf(row.copy(status = "approved"))) }
        compose.onNodeWithText("Approved").performScrollTo().assertExists()
        val connectivityError = dev.omnesis.android.transport.GatewayException.Network(java.net.ConnectException("Test connection failure"))
        compose.runOnIdle { state.value = state.value.copy(error = connectivityError) }
        compose.onNodeWithText("Couldn't connect to gateway").performScrollTo().assertExists()
        compose.onNodeWithText("Approved").performScrollTo().assertExists() // cached trusted rows survive the refresh failure
        compose.runOnIdle { state.value = GatewayPairingApprovalController.State(busy = true) }
        compose.onNodeWithText("Updating…").performScrollTo().assertExists()
        compose.onNodeWithText("No pending pairing requests.").assertDoesNotExist()
        compose.runOnIdle { state.value = GatewayPairingApprovalController.State(error = connectivityError) }
        compose.onNodeWithText("Couldn't connect to gateway").performScrollTo().assertExists()
        compose.onNodeWithText("No pending pairing requests.").assertDoesNotExist()
        compose.onNodeWithText("Refresh").performScrollTo().performClick()
        compose.onNodeWithText("Done").performClick()
        assertEquals(1, refreshes)
        assertEquals(1, dismisses)
    }

    @Test fun real_sheet_composes_controller_callbacks_provider_requests_and_lifecycle_cleanup() {
        val row = request(System.currentTimeMillis() + 600_000)
        val client = object : GatewayPairingApproving {
            var rows = listOf(row)
            val decisions = mutableListOf<Boolean>()
            override suspend fun pairingApprovalRequests() = rows
            override suspend fun decidePairingApproval(requestId: String, approve: Boolean, trustSignIn: Boolean) {
                assertEquals(row.requestId, requestId)
                decisions += approve
                rows = emptyList()
            }
        }
        val visible = mutableStateOf(true)
        compose.setContent { OmnesisTheme { if (visible.value) GatewayPairingApprovalSheet(client) { visible.value = false } } }
        compose.onNodeWithTag("pairingApproval.compare").assertDoesNotExist()
        compose.onNodeWithTag("pairingApproval.approve").performScrollTo().assertIsEnabled()
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { it() }
        compose.waitUntil(timeoutMillis = 5000) { client.decisions == listOf(true) }
        compose.waitForIdle()
        compose.onNodeWithTag("pairingApproval.list").performScrollToNode(hasText("No pending pairing requests."))
        compose.onNodeWithText("No pending pairing requests.").assertExists()
        compose.mainClock.advanceTimeBy(1100)
        compose.onNodeWithTag("pairingApproval.list").performScrollToNode(hasText("Refresh"))
        compose.onNodeWithText("Refresh").performClick()
        assertEquals(listOf(true), client.decisions)
        compose.onNodeWithText("Done").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { it() }
        compose.mainClock.advanceTimeByFrame()
        compose.waitForIdle()
        compose.runOnIdle { assertFalse(visible.value) }
        compose.onNodeWithText("Pairing requests").assertDoesNotExist()
    }
    @Test fun sheet_error_settings_action_dismisses_before_opening_settings() {
        val client = object : GatewayPairingApproving {
            override suspend fun pairingApprovalRequests(): List<GatewayPairingApprovalRequest> =
                throw dev.omnesis.android.transport.GatewayException.Unauthorized()
            override suspend fun decidePairingApproval(requestId: String, approve: Boolean, trustSignIn: Boolean) = Unit
        }
        val visible = mutableStateOf(true)
        var settings = 0
        compose.setContent { OmnesisTheme {
            if (visible.value) GatewayPairingApprovalSheet(client,
                onOpenSettings = { assertFalse(visible.value); settings++ }, onDismiss = { visible.value = false })
        } }
        compose.onNodeWithTag("pairingApproval.list").performScrollToNode(hasText("Open Settings"))
        compose.onNodeWithText("Open Settings").performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { it() }
        compose.mainClock.advanceTimeByFrame(); compose.waitForIdle()
        assertEquals(1, settings)
        assertFalse(visible.value)
    }

    @Test fun real_sheet_approves_an_app_request_with_a_passkey_signed_in_the_app() {
        val row = request(System.currentTimeMillis() + 600_000)
        val app = "android:apk-key-hash:" + "A".repeat(43)
        val client = object : GatewayPairingApproving {
            var rows = listOf(row)
            val approvals = mutableListOf<kotlinx.serialization.json.JsonObject>()
            override suspend fun pairingApprovalRequests() = rows
            override suspend fun decidePairingApproval(requestId: String, approve: Boolean, trustSignIn: Boolean) = fail("Approved without the passkey")
            override suspend fun pairingPasskeyLocation() = GatewayPasskeyLocation("relay.example.test", "https://g-abcdefgh.relay.example.test")
            override suspend fun pairingApprovalCeremony(requestId: String) = GatewayPasskeyCeremony(
                "approve-request", "relay.example.test", null, "c".repeat(43), "b".repeat(43), null, System.currentTimeMillis() + 120_000)
            override suspend fun approvePairingWithPasskey(requestId: String, proof: kotlinx.serialization.json.JsonObject, trustSignIn: Boolean) {
                assertEquals(row.requestId, requestId); approvals += proof; rows = emptyList()
            }
        }
        val prompts = mutableListOf<String>()
        val signer = GatewayPasskeySigner("relay.example.test", app) { options ->
            prompts += options
            val challenge = org.json.JSONObject(options).getString("challenge")
            val clientData = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                """{"type":"webauthn.get","challenge":"$challenge","origin":"$app"}""".toByteArray())
            """{"id":"cred","rawId":"cred","type":"public-key","clientExtensionResults":{},"response":{"clientDataJSON":"$clientData","authenticatorData":"e30","signature":"e30","userHandle":"dXNlcg"}}"""
        }
        compose.setContent { OmnesisTheme { GatewayPairingApprovalSheet(client, passkey = signer) {} } }
        compose.onNodeWithTag("pairingApproval.approveWithPasskey").performScrollTo().assertIsEnabled()
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick) { it() }
        compose.waitUntil(timeoutMillis = 5000) { client.approvals.size == 1 }
        assertEquals(1, prompts.size)
        assertEquals("gateway-passkey", client.approvals.single()["type"].toString().trim('"'))
    }
}
