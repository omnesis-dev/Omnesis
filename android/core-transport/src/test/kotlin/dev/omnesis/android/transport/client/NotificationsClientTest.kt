// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class NotificationsClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: NotificationsClient

    @Before fun setUp() {
        server = MockWebServer().also { it.start() }
        client = NotificationsClient(GatewayHttp(OkHttpClient(), server.url("/"), "device-token"))
    }

    @After fun tearDown() = server.shutdown()

    @Test fun claim_decodes_the_device_scoped_envelope() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"id":"11111111-1111-4111-8111-111111111111","kind":"source-permission","targetId":"fictional-source:local","title":"Permission needed","body":"Repair access","collapseId":"source-permission:example","remaining":2,"affectedDeviceId":"device-affected","route":{"kind":"source-permission"}}""",
        ))

        val claimed = client.claim()!!
        assertEquals("source-permission", claimed.kind)
        assertEquals("fictional-source:local", claimed.targetId)
        assertEquals("device-affected", claimed.affectedDeviceId)
        assertEquals(2, claimed.remaining)
        assertEquals("source-permission", claimed.route?.get("kind")?.jsonPrimitive?.contentOrNull)
        val request = server.takeRequest()
        assertEquals("/notifications/claim", request.path)
        assertEquals("Bearer device-token", request.getHeader("Authorization"))
        assertEquals("{}", request.body.readUtf8())
    }

    @Test fun empty_queue_maps_204_to_null() = runTest {
        server.enqueue(MockResponse().setResponseCode(204))
        assertNull(client.claim())
    }

    @Test fun confirm_echoes_only_the_lease_delivery_id() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        client.confirm("11111111-1111-4111-8111-111111111111")
        val request = server.takeRequest()
        assertEquals("/notifications/confirm", request.path)
        assertEquals(
            """{"id":"11111111-1111-4111-8111-111111111111"}""",
            request.body.readUtf8(),
        )
    }

    @Test fun broad_pairing_token_only_provisions_and_claim_uses_the_narrow_token() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody(
            """{"id":"token-id","deviceId":"device-id","scopes":["push:claim"],"name":"Android notifications","token":"narrow-push-token"}""",
        ))
        server.enqueue(MockResponse().setResponseCode(204))
        val broadHttp = GatewayHttp(OkHttpClient(), server.url("/"), "broad-pairing-token")
        val minted = AdminClient(broadHttp).createToken(
            deviceId = "device-id",
            scopes = listOf("push:claim"),
            name = "Android notifications",
        )
        val narrow = NotificationsClient(
            GatewayHttp(OkHttpClient(), server.url("/"), minted.token),
        )
        assertNull(narrow.claim())

        val provision = server.takeRequest()
        assertEquals("Bearer broad-pairing-token", provision.getHeader("Authorization"))
        assertEquals("/admin/tokens", provision.path)
        assertEquals(
            """{"deviceId":"device-id","scopes":["push:claim"],"name":"Android notifications"}""",
            provision.body.readUtf8(),
        )
        val claim = server.takeRequest()
        assertEquals("Bearer narrow-push-token", claim.getHeader("Authorization"))
        assertEquals("/notifications/claim", claim.path)
    }
}
