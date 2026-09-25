// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.http

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.Whoami
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class GatewayHttpTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun http(token: String? = "tok") =
        GatewayHttp(OkHttpClient(), server.url("/").toString(), token)

    @Test
    fun get_success_decodes_and_sends_bearer() = runTest {
        server.enqueue(MockResponse().setBody("""{"tokenId":"t1","deviceId":"d1","scopes":["read","write"]}"""))
        val who: Whoami = http().getJson("whoami")
        assertEquals("t1", who.tokenId)
        assertEquals(listOf("read", "write"), who.scopes)

        val recorded = server.takeRequest()
        assertEquals("/whoami", recorded.path)
        assertEquals("Bearer tok", recorded.getHeader("Authorization"))
    }

    @Test
    fun maps_status_codes_to_typed_errors() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        assertEquals(
            GatewayException.Unauthorized::class.java,
            runCatching { http().getJson<Whoami>("whoami") }.exceptionOrNull()?.javaClass,
        )

        server.enqueue(MockResponse().setResponseCode(404))
        assertEquals(
            GatewayException.NotFound::class.java,
            runCatching { http().getJson<Whoami>("whoami") }.exceptionOrNull()?.javaClass,
        )

        server.enqueue(MockResponse().setResponseCode(503).setBody("upstream down"))
        val err = runCatching { http().getJson<Whoami>("whoami") }.exceptionOrNull()
        assertEquals(GatewayException.ServerError::class.java, err?.javaClass)
        assertEquals(503, (err as GatewayException.ServerError).status)
    }

    @Test
    fun malformed_body_maps_to_decoding_error() = runTest {
        server.enqueue(MockResponse().setBody("not json at all"))
        val err = runCatching { http().getJson<Whoami>("whoami") }.exceptionOrNull()
        assertEquals(GatewayException.Decoding::class.java, err?.javaClass)
    }
}
