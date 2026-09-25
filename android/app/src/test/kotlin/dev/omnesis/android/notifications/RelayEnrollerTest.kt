// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class RelayEnrollerTest {
    private lateinit var server: MockWebServer
    private lateinit var context: Context
    private lateinit var enroller: RelayEnroller

    @Before fun setUp() {
        server = MockWebServer().also { it.start() }
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("omnesis_relay_enrolment", Context.MODE_PRIVATE)
            .edit().clear().commit()
        enroller = RelayEnroller(context, OkHttpClient(), allowInsecureForTests = true)
    }

    @After fun tearDown() = server.shutdown()

    @Test fun challenge_is_bound_to_the_pairing_then_verified_once() = runTest {
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"challengeId":"challenge_fictional"}"""))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"credential":"credential_fictional"}"""))
        val relayUrl = server.url("/").toString()

        enroller.begin(relayUrl, "fcm-token-fictional", "dev.omnesis.android", "device-a", "https://gateway.example")
        assertNull(enroller.verify("nonce_fictional", "device-b", "https://gateway.example"))
        val verified = enroller.verify("nonce_fictional", "device-a", "https://gateway.example")
        assertEquals(RelayEnroller.VerifiedRelay(relayUrl, "credential_fictional"), verified)
        assertNull(enroller.verify("nonce_fictional", "device-a", "https://gateway.example"))

        val enrol = server.takeRequest()
        assertEquals("/v1/enrol", enrol.path)
        assertEquals(
            """{"platform":"android","token":"fcm-token-fictional","appId":"dev.omnesis.android"}""",
            enrol.body.readUtf8(),
        )
        val verify = server.takeRequest()
        assertEquals("/v1/enrol/verify", verify.path)
        assertEquals(
            """{"challengeId":"challenge_fictional","nonce":"nonce_fictional"}""",
            verify.body.readUtf8(),
        )
    }

    @Test fun failed_verification_preserves_the_pending_challenge_for_retry() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(202).setBody(
                """{"challengeId":"challenge_retry"}""",
            ),
        )
        server.enqueue(MockResponse().setResponseCode(503).setBody("""{"error":"busy"}"""))
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"credential":"credential_retry"}""",
            ),
        )
        val relayUrl = server.url("/").toString()
        enroller.begin(
            relayUrl,
            "fcm-token-fictional",
            "dev.omnesis.android",
            "device-a",
            "https://gateway.example",
        )

        val failed = runCatching {
            enroller.verify("nonce_retry", "device-a", "https://gateway.example")
        }
        assertTrue(failed.isFailure)
        assertEquals(
            RelayEnroller.VerifiedRelay(relayUrl, "credential_retry"),
            enroller.verify("nonce_retry", "device-a", "https://gateway.example"),
        )
    }

    @Test fun completed_identity_rotates_after_ninety_days_and_survives_pending_failure() {
        var now = 1_000L
        val rotating = RelayEnroller(context, OkHttpClient(), nowMillis = { now })
        val relayUrl = "https://push.example.test"
        rotating.markRegistered(
            relayUrl,
            "fcm-token-fictional",
            "dev.omnesis.android",
            "device-a",
            "https://gateway.example",
        )

        assertTrue(
            !rotating.shouldRotate(
                relayUrl,
                "fcm-token-fictional",
                "dev.omnesis.android",
                "device-a",
                "https://gateway.example",
            ),
        )
        rotating.clearPending()
        assertTrue(
            !rotating.shouldRotate(
                relayUrl,
                "fcm-token-fictional",
                "dev.omnesis.android",
                "device-a",
                "https://gateway.example",
            ),
        )
        now += 90L * 24 * 60 * 60 * 1000
        assertTrue(
            rotating.shouldRotate(
                relayUrl,
                "fcm-token-fictional",
                "dev.omnesis.android",
                "device-a",
                "https://gateway.example",
            ),
        )
    }

    @Test fun lost_challenge_reenrols_at_ten_minute_ttl() = runTest {
        var now = 1_000L
        val expiring = RelayEnroller(
            context,
            OkHttpClient(),
            nowMillis = { now },
            allowInsecureForTests = true,
        )
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"challengeId":"lost"}"""))
        val relayUrl = server.url("/").toString()
        expiring.begin(
            relayUrl,
            "fcm-token-fictional",
            "dev.omnesis.android",
            "device-a",
            "https://gateway.example",
        )

        now += 10L * 60 * 1000 - 1
        assertTrue(
            !expiring.shouldRotate(
                relayUrl,
                "fcm-token-fictional",
                "dev.omnesis.android",
                "device-a",
                "https://gateway.example",
            ),
        )
        now += 1
        assertTrue(
            expiring.shouldRotate(
                relayUrl,
                "fcm-token-fictional",
                "dev.omnesis.android",
                "device-a",
                "https://gateway.example",
            ),
        )
    }

    @Test fun current_plan_keeps_only_a_matching_pending_challenge() = runTest {
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"challengeId":"pending"}"""))
        val relayUrl = server.url("/").toString()
        val token = "fcm-token-fictional"
        val appId = "dev.omnesis.android"
        val deviceId = "device-a"
        val gatewayUrl = "https://gateway.example"
        enroller.begin(relayUrl, token, appId, deviceId, gatewayUrl)

        enroller.reconcilePlan(relayUrl, token, appId, deviceId, gatewayUrl)
        assertTrue(!enroller.shouldRotate(relayUrl, token, appId, deviceId, gatewayUrl))

        enroller.reconcilePlan(null, token, appId, deviceId, gatewayUrl)
        assertTrue(enroller.shouldRotate(relayUrl, token, appId, deviceId, gatewayUrl))
        assertNull(enroller.verify("late-nonce", deviceId, gatewayUrl))
    }

    @Test fun relay_endpoint_change_drops_the_old_pending_challenge() = runTest {
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"challengeId":"pending"}"""))
        val oldRelayUrl = server.url("/").toString()
        val newRelayUrl = "https://new-push.example.test"
        val token = "fcm-token-fictional"
        val appId = "dev.omnesis.android"
        val deviceId = "device-a"
        val gatewayUrl = "https://gateway.example"
        enroller.begin(oldRelayUrl, token, appId, deviceId, gatewayUrl)

        enroller.reconcilePlan(newRelayUrl, token, appId, deviceId, gatewayUrl)

        assertTrue(enroller.shouldRotate(newRelayUrl, token, appId, deviceId, gatewayUrl))
        assertNull(enroller.verify("late-nonce", deviceId, gatewayUrl))
    }

    @Test fun unavailable_plan_invalidates_a_completed_relay_enrollment() {
        val relayUrl = "https://push.example.test"
        val token = "fcm-token-fictional"
        val appId = "dev.omnesis.android"
        val deviceId = "device-a"
        val gatewayUrl = "https://gateway.example"
        enroller.markRegistered(relayUrl, token, appId, deviceId, gatewayUrl)
        assertTrue(!enroller.shouldRotate(relayUrl, token, appId, deviceId, gatewayUrl))

        enroller.reconcilePlan(null, token, appId, deviceId, gatewayUrl)

        assertTrue(enroller.shouldRotate(relayUrl, token, appId, deviceId, gatewayUrl))
    }

    @Test fun production_policy_rejects_cleartext_relay_url() = runTest {
        val secureOnly = RelayEnroller(context, OkHttpClient())
        val failure = runCatching {
            secureOnly.begin(
                server.url("/").toString(),
                "fcm-token-fictional",
                "dev.omnesis.android",
                "device-a",
                "https://gateway.example",
            )
        }
        assertTrue(failure.isFailure)
    }
}
