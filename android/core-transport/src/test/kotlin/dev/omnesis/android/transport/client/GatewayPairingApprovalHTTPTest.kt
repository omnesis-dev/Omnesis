// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class GatewayPairingApprovalHTTPTest {
    @Test fun `paired admin list approval and rejection share the same bearer generation and gateway`() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("""{"items":[{"requestId":"00000000-0000-4000-8000-000000000901","kind":"ios","name":"Test phone","status":"pending","verificationCode":"465 774","expiresAt":1100000}]}"""))
            server.enqueue(MockResponse().setBody("""{"ok":true}"""))
            server.enqueue(MockResponse().setBody("""{"ok":true}"""))
            server.start()
            val transport = OkHttpClient()
            try {
                val client = AdminClient(GatewayHttp(transport, server.url("/").toString(), "synthetic-token", "synthetic-generation"))
                val rows = client.pairingApprovalRequests()
                assertEquals("465 774", rows.single().verificationCode)
                client.decidePairingApproval(rows.single().requestId, true)
                client.decidePairingApproval(rows.single().requestId, false)
                val requests = List(3) { server.takeRequest() }
                assertEquals(listOf("GET", "POST", "POST"), requests.map { it.method })
                assertEquals(listOf("/admin/cloud-pairing/requests", "/admin/cloud-pairing/decision", "/admin/cloud-pairing/decision"), requests.map { it.path })
                for (request in requests) {
                    assertEquals("Bearer synthetic-token", request.getHeader("Authorization"))
                    assertEquals("synthetic-generation", request.getHeader("Omnesis-Pairing-Generation"))
                }
                for ((request, approve) in requests.drop(1).zip(listOf(true, false))) {
                    val body = Json.parseToJsonElement(request.body.readUtf8()).jsonObject
                    assertEquals(rows.single().requestId, body["requestId"]!!.jsonPrimitive.content)
                    assertEquals(approve, body["approve"]!!.jsonPrimitive.boolean)
                }
            } finally { transport.dispatcher.cancelAll(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
        }
    }

    private fun <T> withClient(vararg responses: MockResponse, block: suspend (AdminClient, MockWebServer) -> T) = runBlocking {
        MockWebServer().use { server ->
            responses.forEach(server::enqueue)
            server.start()
            val transport = OkHttpClient()
            try { block(AdminClient(GatewayHttp(transport, server.url("/").toString(), "synthetic-token")), server) }
            finally { transport.dispatcher.cancelAll(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
        }
    }

    @Test fun `trustSignIn is sent only when chosen and request rows decode the sign-in`() {
        withClient(
            MockResponse().setBody("""{"items":[{"requestId":"r","kind":"android","name":"Test phone","status":"pending","verificationCode":"465 774","expiresAt":1,"signIn":"passkey","canTrustSignIn":true}]}"""),
            MockResponse().setBody("""{"ok":true}"""), MockResponse().setBody("""{"ok":true}"""),
        ) { client, server ->
            val row = client.pairingApprovalRequests().single()
            assertTrue(row.canTrustSignIn); assertEquals("passkey", row.signIn)
            client.decidePairingApproval("r", true, trustSignIn = true)
            client.decidePairingApproval("r", true)
            server.takeRequest()
            assertEquals("""{"requestId":"r","approve":true,"trustSignIn":true}""", server.takeRequest().body.readUtf8())
            assertEquals("""{"requestId":"r","approve":true}""", server.takeRequest().body.readUtf8())
        }
    }

    @Test fun `a 403 keeps the gateway's message and code, and device rows decode their enrollment`() {
        withClient(
            MockResponse().setResponseCode(403).setBody("""{"error":"Forbidden","code":"FORBIDDEN"}"""),
            MockResponse().setBody("""{"items":[{"id":"d","enrollment":{"method":"automatic","signIn":"google","joinedAt":5}},{"id":"e"}]}"""),
        ) { client, _ ->
            try { client.cloudRelayStatus(); fail("403 accepted") }
            catch (e: dev.omnesis.android.transport.GatewayException.Forbidden) {
                assertEquals("Forbidden", e.body); assertEquals("FORBIDDEN", e.code)
            }
            val rows = client.devices()
            assertEquals("google", rows[0].enrollment?.signIn); assertEquals(5L, rows[0].enrollment?.joinedAt)
            assertNull(rows[1].enrollment)
        }
    }
}
