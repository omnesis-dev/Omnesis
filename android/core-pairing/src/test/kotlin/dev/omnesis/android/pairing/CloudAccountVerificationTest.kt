// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.CloudRelayConnect
import dev.omnesis.android.transport.dto.CloudRelayManaging
import dev.omnesis.android.transport.dto.CloudRelayStatus
import dev.omnesis.android.transport.dto.CloudRelayVerification
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloudAccountVerificationTest {
    private val check = "https://dns.example.com/_dns/v2/enroll?ticket=fictional"
    private val signIn = "https://relay.example.com/_relay/v3/signup/begin?request=fictional"

    @Test fun `security check decodes milliseconds and precedes sign in`() {
        val status = Json.decodeFromString<CloudRelayStatus>(
            """{"connect":{"state":"waiting","authorizeUrl":"$signIn","verification":{"url":"$check","expiresAt":1900000120000}}}""",
        )
        assertEquals(CloudAccountPhase.Waiting, cloudAccountPhase(status))
        assertEquals(check, cloudAccountConnectUrl(status.connect, 1_900_000_000_000))
        assertEquals(check, cloudAccountConnectUrl(CloudRelayConnect(verification =
            CloudRelayVerification(check, JsonPrimitive(1_900_000_650_000))), 1_900_000_000_000))
    }

    @Test fun `invalid expired or unbounded security checks never fall through to sign in`() {
        for ((url, expiry) in listOf("http://dns.example.com/check" to 1_900_000_120_000,
            check to 1_899_999_999_000, check to 1_900_000_661_000)) {
            val pending = CloudRelayConnect(state = "waiting", authorizeUrl = signIn,
                verification = CloudRelayVerification(url, JsonPrimitive(expiry)))
            assertNull(cloudAccountConnectUrl(pending, 1_900_000_000_000))
        }
        assertEquals(signIn, cloudAccountConnectUrl(CloudRelayConnect(authorizeUrl = signIn)))
    }

    @Test fun `browser continues from security check to sign in once and cancellation prevents reopening`(): Unit = runBlocking {
        val gateway = Gateway(CloudRelayStatus(connect = CloudRelayConnect(state = "waiting",
            verification = CloudRelayVerification(check, JsonPrimitive(System.currentTimeMillis() + 300_000)))))
        val controller = CloudAccountSettingsController()
        controller.connect(gateway, "create")
        assertEquals(check, controller.state.value.launchUrl)
        controller.launched()
        gateway.reply = CloudRelayStatus(connect = CloudRelayConnect(state = "waiting"))
        controller.refresh(gateway)
        assertNull(controller.state.value.launchUrl)
        gateway.reply = CloudRelayStatus(connect = CloudRelayConnect(state = "waiting", authorizeUrl = signIn))
        controller.refresh(gateway)
        assertEquals(signIn, controller.state.value.launchUrl)
        controller.launched()
        controller.refresh(gateway)
        assertNull(controller.state.value.launchUrl)
        gateway.reply = CloudRelayStatus()
        controller.cancelConnect(gateway)
        gateway.reply = CloudRelayStatus(connect = CloudRelayConnect(state = "waiting", authorizeUrl = signIn))
        controller.refresh(gateway)
        assertNull(controller.state.value.launchUrl)
    }

    private class Gateway(var reply: CloudRelayStatus) : CloudRelayManaging {
        override suspend fun cloudRelayStatus() = reply
        override suspend fun connectCloudRelay(intent: String) = reply
        override suspend fun cancelCloudRelayConnect() = reply
        override suspend fun cloudRelayOperation(operation: String) = reply
        override suspend fun setCloudRelayEnrollmentPolicy(policy: String) = reply
    }
}
