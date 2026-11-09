// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

/** The Omnesis account routes as the app calls them: method, path and body of each, and its refusals. */
class CloudRelayManagementHTTPTest {
    private val status = """{"enabled":true,"enrollment":{"state":"enrolled"},"tunnel":{"state":"online"},"hostname":"g-7f3a91.relay.example.com"}"""

    private fun <T> withClient(vararg responses: MockResponse, block: suspend (AdminClient, MockWebServer) -> T) = runBlocking {
        MockWebServer().use { server ->
            responses.forEach(server::enqueue)
            server.start()
            val transport = OkHttpClient()
            try { block(AdminClient(GatewayHttp(transport, server.url("/").toString(), "synthetic-token")), server) }
            finally { transport.dispatcher.cancelAll(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
        }
    }

    private fun ok() = MockResponse().setBody(status)

    @Test fun `the status is read with the device's token`() {
        withClient(ok()) { client, server ->
            assertEquals("g-7f3a91.relay.example.com", client.cloudRelayStatus().hostname)
            val request = server.takeRequest()
            assertEquals("GET", request.method)
            assertEquals("/admin/cloud-relay", request.path)
            assertEquals("Bearer synthetic-token", request.getHeader("Authorization"))
        }
    }

    @Test fun `connecting accepts the terms and says whether the account is new`() {
        withClient(ok(), ok()) { client, server ->
            client.connectCloudRelay("create")
            client.connectCloudRelay("existing")
            for (intent in listOf("create", "existing")) {
                val request = server.takeRequest()
                assertEquals("POST", request.method)
                assertEquals("/admin/cloud-relay/connect", request.path)
                assertEquals("""{"termsAccepted":true,"intent":"$intent"}""", request.body.readUtf8())
            }
        }
    }

    @Test fun `each bodiless operation posts an empty object to its own path`() {
        val operations = listOf("enable", "disable", "reconnect", "account/unlink")
        withClient(ok(), ok(), ok(), ok(), ok()) { client, server ->
            client.cancelCloudRelayConnect()
            for (operation in operations) client.cloudRelayOperation(operation)
            for (path in listOf("connect/cancel") + operations) {
                val request = server.takeRequest()
                assertEquals("POST", request.method)
                assertEquals("/admin/cloud-relay/$path", request.path)
                assertEquals("{}", request.body.readUtf8())
            }
        }
    }

    @Test fun `the enrollment policy is a PUT`() {
        withClient(ok(), ok()) { client, server ->
            client.setCloudRelayEnrollmentPolicy("automatic")
            client.setCloudRelayEnrollmentPolicy("ask")
            for (policy in listOf("automatic", "ask")) {
                val put = server.takeRequest()
                assertEquals("PUT", put.method)
                assertEquals("/admin/cloud-relay/enrollment", put.path)
                assertEquals("""{"policy":"$policy"}""", put.body.readUtf8())
            }
        }
    }

    @Test fun `a gateway without the feature answers 404 and a device without the scope 403`() {
        withClient(
            MockResponse().setResponseCode(404).setBody("""{"error":"Not found","code":"NOT_FOUND"}"""),
            MockResponse().setResponseCode(403).setBody("""{"error":"Forbidden","code":"FORBIDDEN"}"""),
            MockResponse().setResponseCode(409).setBody("""{"error":"Relay operation was refused.","code":"operation-in-progress"}"""),
        ) { client, _ ->
            try { client.cloudRelayStatus(); fail("404 accepted") } catch (_: GatewayException.NotFound) {}
            try { client.cloudRelayOperation("disable"); fail("403 accepted") }
            catch (e: GatewayException.Forbidden) { assertEquals("FORBIDDEN", e.code) }
            try { client.cloudRelayOperation("reconnect"); fail("409 accepted") }
            catch (e: GatewayException.ServerError) { assertEquals(409, e.status); assertEquals("operation-in-progress", e.code) }
        }
    }
}
