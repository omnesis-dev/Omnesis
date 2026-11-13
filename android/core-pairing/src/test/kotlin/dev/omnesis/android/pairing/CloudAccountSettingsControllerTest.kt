// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.CloudRelayManaging
import dev.omnesis.android.transport.dto.CloudRelayStatus
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class CloudAccountSettingsControllerTest {
    /** A gateway that answers each call with [answer] and records what it was asked. */
    private class Gateway(var answer: String = CloudAccountFixtures.notConnected) : CloudRelayManaging {
        var failure: Exception? = null
        val calls = mutableListOf<String>()
        /** When set, the next status read waits here before answering. */
        var hold: CompletableDeferred<Unit>? = null

        private fun reply(call: String): CloudRelayStatus {
            calls += call
            failure?.let { throw it }
            return CloudAccountFixtures.decode(answer)
        }

        override suspend fun cloudRelayStatus(): CloudRelayStatus {
            val body = answer
            hold?.await()
            calls += "status"
            failure?.let { throw it }
            return CloudAccountFixtures.decode(body)
        }
        override suspend fun connectCloudRelay(intent: String) = reply("connect:$intent")
        override suspend fun cancelCloudRelayConnect() = reply("connect/cancel")
        override suspend fun cloudRelayOperation(operation: String) = reply(operation)
        override suspend fun setCloudRelayEnrollmentPolicy(policy: String) = reply("enrollment:$policy")
    }

    @Test fun `the first read replaces loading with the gateway's phase`(): Unit = runBlocking {
        val gateway = Gateway(); val controller = CloudAccountSettingsController()
        assertTrue(controller.state.value.loading)
        assertNull(controller.state.value.phase)
        controller.refresh(gateway)
        assertFalse(controller.state.value.loading)
        assertEquals(CloudAccountPhase.NotConnected, controller.state.value.phase)
    }

    @Test fun `both ways to connect send their intent and open the sign-in once`(): Unit = runBlocking {
        for (intent in listOf("create", "existing")) {
            val gateway = Gateway(); val controller = CloudAccountSettingsController()
            controller.refresh(gateway)
            gateway.answer = CloudAccountFixtures.waiting
            controller.connect(gateway, intent)
            assertEquals(listOf("status", "connect:$intent"), gateway.calls)
            assertEquals(CloudAccountPhase.Waiting, controller.state.value.phase)
            assertEquals(intent, controller.state.value.connectIntent)
            assertEquals("https://relay.example.com/_relay/v3/signup/begin?request=req-1", controller.state.value.launchUrl)
            controller.launched()
            // The poll that follows the sign-in moves the screen on without opening anything again.
            gateway.answer = CloudAccountFixtures.registering
            controller.refresh(gateway)
            assertEquals(CloudAccountPhase.Registering, controller.state.value.phase)
            gateway.answer = CloudAccountFixtures.connected
            controller.refresh(gateway)
            assertEquals(CloudAccountPhase.Connected, controller.state.value.phase)
            assertNull(controller.state.value.launchUrl)
        }
    }

    @Test fun `a sign-in address that is not HTTPS is never opened`(): Unit = runBlocking {
        val gateway = Gateway(); val controller = CloudAccountSettingsController()
        gateway.answer = CloudAccountFixtures.fresh(connect = """{"state":"waiting","authorizeUrl":"intent://relay.example.com/begin"}""")
        controller.connect(gateway, "create")
        assertEquals(CloudAccountPhase.Waiting, controller.state.value.phase)
        assertNull(controller.state.value.launchUrl)
    }

    @Test fun `each action reaches its operation and shows the gateway's answer`(): Unit = runBlocking {
        val gateway = Gateway(CloudAccountFixtures.connected); val controller = CloudAccountSettingsController()
        controller.refresh(gateway)
        controller.cancelConnect(gateway)
        controller.run(gateway, "disable")
        controller.run(gateway, "enable")
        controller.run(gateway, "reconnect")
        controller.run(gateway, "account/unlink")
        controller.setPolicy(gateway, "automatic")
        // The policy already in force and a value the gateway does not have are not sent.
        controller.setPolicy(gateway, "ask")
        controller.setPolicy(gateway, "sometimes")
        assertEquals(
            listOf("status", "connect/cancel", "disable", "enable", "reconnect", "account/unlink", "enrollment:automatic"),
            gateway.calls,
        )
        gateway.answer = CloudAccountFixtures.off
        controller.run(gateway, "disable")
        assertEquals(CloudAccountPhase.Off, controller.state.value.phase)
        assertNull(controller.state.value.busy)
        assertNull(controller.state.value.error)
    }

    @Test fun `a 404 marks the settings absent, on a read and on a change`(): Unit = runBlocking {
        val gateway = Gateway(CloudAccountFixtures.connected); val controller = CloudAccountSettingsController()
        gateway.failure = GatewayException.NotFound()
        controller.refresh(gateway)
        assertTrue(controller.state.value.absent)
        assertNull(controller.state.value.status)
        assertFalse(cloudAccountOffered(gateway))
        gateway.failure = null
        controller.refresh(gateway)
        assertFalse(controller.state.value.absent)
        assertTrue(cloudAccountOffered(gateway))
        gateway.failure = GatewayException.NotFound()
        controller.run(gateway, "disable")
        assertTrue(controller.state.value.absent)
        assertNull(controller.state.value.status)
    }

    /** Every route asks for the same admin scope, so a 403 is a failure like any other, never a state of its own. */
    @Test fun `a refused read offers no screen and a refused change reads as a failed one`(): Unit = runBlocking {
        val gateway = Gateway(CloudAccountFixtures.connected); val controller = CloudAccountSettingsController()
        gateway.failure = GatewayException.Forbidden("admin scope required")
        assertFalse(cloudAccountOffered(gateway))
        controller.refresh(gateway)
        assertTrue(controller.state.value.unreachable)
        gateway.failure = null
        controller.refresh(gateway)
        gateway.failure = GatewayException.Forbidden("Forbidden", "FORBIDDEN")
        controller.setPolicy(gateway, "automatic")
        assertEquals(CLOUD_ACCOUNT_REQUEST_FAILED, controller.state.value.error)
        assertEquals(CloudAccountPhase.Connected, controller.state.value.phase)
    }

    @Test fun `a refusal the portal names reads as it does there, anything else as a connection problem`(): Unit = runBlocking {
        val gateway = Gateway(CloudAccountFixtures.connected); val controller = CloudAccountSettingsController()
        controller.refresh(gateway)
        gateway.failure = GatewayException.ServerError(409, "Relay operation was refused.", "operation-in-progress")
        controller.run(gateway, "reconnect")
        assertEquals("Another change is in progress. Wait for it to finish and try again.", controller.state.value.error)
        gateway.failure = GatewayException.ServerError(503, "Relay management is unavailable. Try again.", "relay-management-unavailable")
        controller.run(gateway, "reconnect")
        assertEquals(CLOUD_ACCOUNT_REQUEST_FAILED, controller.state.value.error)
        gateway.failure = GatewayException.Network(IOException("offline"))
        controller.run(gateway, "reconnect")
        assertEquals(CLOUD_ACCOUNT_REQUEST_FAILED, controller.state.value.error)
        assertEquals(CloudAccountPhase.Connected, controller.state.value.phase)
        // The next change that works clears it.
        gateway.failure = null
        controller.run(gateway, "reconnect")
        assertNull(controller.state.value.error)
    }

    @Test fun `a failed poll keeps the last answer and a failed first read asks to try again`(): Unit = runBlocking {
        val gateway = Gateway(CloudAccountFixtures.connected); val controller = CloudAccountSettingsController()
        gateway.failure = GatewayException.Network(IOException("offline"))
        controller.refresh(gateway)
        assertTrue(controller.state.value.unreachable)
        assertFalse(controller.state.value.loading)
        assertFalse(cloudAccountOffered(gateway))
        gateway.failure = null
        controller.refresh(gateway)
        assertFalse(controller.state.value.unreachable)
        gateway.failure = GatewayException.Network(IOException("offline"))
        controller.refresh(gateway)
        assertFalse(controller.state.value.unreachable)
        assertEquals(CloudAccountPhase.Connected, controller.state.value.phase)
    }

    @Test fun `a change outranks a status read that was already on its way`(): Unit = runBlocking {
        val gateway = Gateway(CloudAccountFixtures.connected); val controller = CloudAccountSettingsController()
        controller.refresh(gateway)
        val hold = CompletableDeferred<Unit>()
        gateway.hold = hold
        // This read captures the connected answer, then waits.
        val stale = async { controller.refresh(gateway) }
        yield()
        gateway.hold = null
        gateway.answer = CloudAccountFixtures.off
        controller.run(gateway, "disable")
        assertEquals(CloudAccountPhase.Off, controller.state.value.phase)
        hold.complete(Unit)
        stale.await()
        assertEquals(CloudAccountPhase.Off, controller.state.value.phase)
    }
}
