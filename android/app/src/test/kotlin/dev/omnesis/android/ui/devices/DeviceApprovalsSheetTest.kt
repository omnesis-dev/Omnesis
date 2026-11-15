// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.semantics.SemanticsActions
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.pairing.GatewayPairingApprovalController
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.transport.dto.GatewayPairingApproving
import dev.omnesis.android.transport.dto.TailscaleJoinApproving
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import java.net.ConnectException
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Devices approvals sheet with both kinds of request, each kind alone, and each kind's failures. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DeviceApprovalsSheetTest {
    @get:Rule val compose = createComposeRule()

    private val now = Instant.parse("2026-11-14T18:05:00.000Z").toEpochMilli()
    private val phone = GatewayPairingApprovalRequest(
        "00000000-0000-4000-8000-000000000901", "android", "Jamie's phone", "pending", "465 774", now + 600_000, signIn = "google",
    )
    private val studio = TailscaleJoinRequest(
        id = "join-1", name = "Maya's studio Mac", kind = "collector", machine = "studio-mac", os = "macOS",
        login = "maya@example.com", requestedAt = "2026-11-14T18:02:00.000Z", expiresAt = "2026-11-14T18:12:00.000Z",
    )
    private val served = TailscaleJoinRequestsViewModel.State(requests = listOf(studio), loaded = true, available = true)

    private fun content(
        signIns: GatewayPairingApprovalController.State?,
        joins: TailscaleJoinRequestsViewModel.State?,
        onDecide: (GatewayPairingApprovalRequest, Boolean) -> Unit = { _, _ -> },
        onDecideJoin: (TailscaleJoinRequest, Boolean) -> Unit = { _, _ -> },
    ) = compose.setContent {
        OmnesisTheme {
            DeviceApprovalsContent(signIns, now, onRefresh = {}, onDecide = onDecide, onDismiss = {}, joins = joins, onDecideJoin = onDecideJoin)
        }
    }

    @Test fun `both kinds are listed together, each deciding its own way`() {
        val signIns = mutableListOf<Boolean>()
        val joins = mutableListOf<Pair<String, Boolean>>()
        content(
            GatewayPairingApprovalController.State(requests = listOf(phone)), served,
            onDecide = { _, approve -> signIns += approve },
            onDecideJoin = { request, approve -> joins += request.id to approve },
        )
        compose.onNodeWithText("Waiting for your OK").assertExists()
        compose.onNodeWithText("Jamie's phone wants to connect").assertExists()
        compose.onNodeWithText("Android app · signed in with Google").assertExists()
        compose.onNodeWithTag("tailscaleJoin.request").performScrollTo()
        compose.onNodeWithText("Maya's studio Mac wants to connect").assertExists()
        compose.onNodeWithTag("tailscaleJoin.via").assertExists()
        compose.onNodeWithText("Collector · via Tailscale · maya@example.com").assertExists()
        compose.onNodeWithText("On studio-mac (macOS)").assertExists()
        compose.onNodeWithText("Asked 3m ago · expires in 7 min").assertExists()

        compose.onNodeWithTag("tailscaleJoin.approve").performScrollTo().performClick()
        compose.onNodeWithTag("tailscaleJoin.deny").performClick()
        compose.onNodeWithTag("pairingApproval.approve").performScrollTo().performClick()
        assertEquals(listOf("join-1" to true, "join-1" to false), joins)
        assertEquals(listOf(true), signIns)
        compose.onAllNodesWithText(PAIRING_APPROVAL_EMPTY).assertCountEquals(0)
    }

    @Test fun `beside sign-in requests a gateway that answered 404 adds nothing`() {
        content(GatewayPairingApprovalController.State(), TailscaleJoinRequestsViewModel.State(loaded = true, available = false))
        compose.onAllNodesWithTag("tailscaleJoin.request").assertCountEquals(0)
        compose.onNodeWithText(PAIRING_APPROVAL_EMPTY).assertExists()
    }

    @Test fun `beside sign-in requests a Tailscale read still under way changes nothing`() {
        content(GatewayPairingApprovalController.State(), TailscaleJoinRequestsViewModel.State(loading = true))
        compose.onAllNodesWithText("Updating…").assertCountEquals(0)
        compose.onNodeWithText(PAIRING_APPROVAL_EMPTY).assertExists()
    }

    @Test fun `Tailscale alone shows its first read, then its requests`() {
        val state = mutableStateOf(TailscaleJoinRequestsViewModel.State(loading = true))
        compose.setContent {
            OmnesisTheme { DeviceApprovalsContent(null, now, onRefresh = {}, onDecide = { _, _ -> }, onDismiss = {}, joins = state.value) }
        }
        compose.onNodeWithText("Updating…").assertExists()
        compose.onAllNodesWithText(PAIRING_APPROVAL_EMPTY).assertCountEquals(0)
        state.value = served
        compose.waitForIdle()
        compose.onAllNodesWithText("Updating…").assertCountEquals(0)
        compose.onAllNodesWithTag("tailscaleJoin.request").assertCountEquals(1)
        compose.onAllNodesWithTag("pairingApproval.request").assertCountEquals(0)
    }

    @Test fun `a Tailscale step-up refusal keeps the row and names the refusal`() {
        content(null, served.copy(error = GatewayException.ServerError(428, "{}", "STEP_UP_REQUIRED")))
        compose.onNodeWithTag("tailscaleJoin.error").assertExists()
        compose.onNodeWithText("Confirm it's you").assertExists()
        compose.onAllNodesWithTag("tailscaleJoin.request").assertCountEquals(1)
    }

    @Test fun `an unreachable gateway is said once, not once per kind`() {
        val unreachable = GatewayException.Network(ConnectException("unreachable"))
        content(GatewayPairingApprovalController.State(error = unreachable), served.copy(requests = emptyList(), error = unreachable))
        compose.onAllNodesWithTag("tailscaleJoin.error").assertCountEquals(0)
        compose.onAllNodesWithText(PAIRING_APPROVAL_EMPTY).assertCountEquals(0)
    }

    @Test fun `an expired join keeps its card without the actions`() {
        content(null, served.copy(requests = listOf(studio.copy(expiresAt = "2026-11-14T18:04:00.000Z"))))
        compose.onNodeWithText("Expired").assertExists()
        compose.onAllNodesWithTag("tailscaleJoin.approve").assertCountEquals(0)
    }

    @Test fun `the sheet alone reads and decides Tailscale joins, and reports what still waits`() {
        val gateway = object : TailscaleJoinApproving {
            var waiting = listOf(studio.copy(expiresAt = Instant.now().plusSeconds(600).toString()))
            val decisions = mutableListOf<Pair<String, Boolean>>()
            override suspend fun tailscaleJoinRequests() = waiting
            override suspend fun decideTailscaleJoin(id: String, approve: Boolean): String {
                decisions += id to approve
                waiting = waiting.filterNot { it.id == id }
                return "approved"
            }
        }
        val vm = TailscaleJoinRequestsViewModel { gateway }
        val reported = mutableListOf<List<TailscaleJoinRequest>>()
        compose.setContent {
            OmnesisTheme { DeviceApprovalsSheet(client = null, tailscale = vm, onTailscaleRequests = { reported += it }, onDismiss = {}) }
        }
        compose.waitUntil(timeoutMillis = 5_000) { compose.onAllNodesWithTag("tailscaleJoin.approve").fetchSemanticsNodes().isNotEmpty() }
        compose.onAllNodesWithTag("pairingApproval.request").assertCountEquals(0)
        compose.onNodeWithTag("tailscaleJoin.approve").performScrollTo()
        // A bottom sheet's popup takes no synthetic pointer input under Robolectric; its semantics action is the tap.
        compose.onNodeWithTag("tailscaleJoin.approve").performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.waitUntil(timeoutMillis = 5_000) { compose.onAllNodesWithTag("tailscaleJoin.request").fetchSemanticsNodes().isEmpty() }
        assertEquals(listOf("join-1" to true), gateway.decisions)
        compose.onNodeWithText(PAIRING_APPROVAL_EMPTY).assertExists()
        assertEquals(emptyList<TailscaleJoinRequest>(), reported.last())
        assertEquals(1, reported.first().size)
    }

    @Test fun `with both kinds the sheet reads both`() {
        val row = phone.copy(expiresAt = System.currentTimeMillis() + 600_000)
        val signIns = object : GatewayPairingApproving {
            var reads = 0
            override suspend fun pairingApprovalRequests(): List<GatewayPairingApprovalRequest> { reads++; return listOf(row) }
            override suspend fun decidePairingApproval(requestId: String, approve: Boolean, trustSignIn: Boolean) = Unit
        }
        val joins = TailscaleJoinRequestsViewModel {
            object : TailscaleJoinApproving {
                override suspend fun tailscaleJoinRequests() = listOf(studio.copy(expiresAt = Instant.now().plusSeconds(600).toString()))
                override suspend fun decideTailscaleJoin(id: String, approve: Boolean) = "approved"
            }
        }
        compose.setContent { OmnesisTheme { DeviceApprovalsSheet(client = signIns, tailscale = joins, passkey = null, onDismiss = {}) } }
        compose.waitUntil(timeoutMillis = 5_000) {
            compose.onAllNodesWithTag("pairingApproval.request").fetchSemanticsNodes().isNotEmpty() &&
                compose.onAllNodesWithTag("tailscaleJoin.request").fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(1, signIns.reads)
    }
}
