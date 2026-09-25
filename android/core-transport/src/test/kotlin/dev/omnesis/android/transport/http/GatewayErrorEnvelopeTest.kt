// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.http

import dev.omnesis.android.transport.GatewayException
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * The gateway answers every 4xx/5xx with `{error, code, detail?}`. Several surfaces put the
 * resulting string straight on screen, so the transport unwraps the envelope once instead of
 * each of them rendering the JSON — and keeps `code` for the callers that branch on it.
 */
class GatewayErrorEnvelopeTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer().also { it.start() }
    }

    @After
    fun tearDown() = server.shutdown()

    private fun failWith(status: Int, body: String): GatewayException.ServerError {
        server.enqueue(MockResponse().setResponseCode(status).setBody(body))
        val http = GatewayHttp(OkHttpClient(), server.url("/"), token = null)
        return runCatching {
            runBlocking { http.execute(http.newRequest(http.urlFor("status")).get().build()) }
        }.exceptionOrNull() as GatewayException.ServerError
    }

    @Test
    fun `unwraps the message and keeps the code`() {
        val e = failWith(503, """{"error":"Anthropic API key not configured.","code":"SERVICE_UNAVAILABLE"}""")
        assertEquals("Anthropic API key not configured.", e.body)
        assertEquals("SERVICE_UNAVAILABLE", e.code)
        assertEquals(503, e.status)
    }

    /**
     * The shape that reached a user: an unreachable chat backend, reported with an embedded
     * quoted backend name, so the JSON escaping was part of what the naive rendering showed.
     */
    @Test
    fun `unwraps a message containing escaped quotes`() {
        val e = failWith(
            503,
            """{"error":"Backend \"fireworks\" is unreachable: The operation was aborted due to timeout","code":"SERVICE_UNAVAILABLE"}""",
        )
        assertEquals(
            """Backend "fireworks" is unreachable: The operation was aborted due to timeout""",
            e.body,
        )
    }

    /** The context-window branch reads `code`; it must survive the unwrap. */
    @Test
    fun `exposes the code a caller branches on`() {
        val e = failWith(409, """{"error":"Context window reached.","code":"CONTEXT_WINDOW_EXCEEDED"}""")
        assertEquals("CONTEXT_WINDOW_EXCEEDED", e.code)
        assertEquals("Context window reached.", e.body)
    }

    /**
     * Not everything that fails is the gateway — a reverse proxy or a truncated response can
     * answer with something else. Those pass through unchanged: no worse than before, and never
     * mistaken for a message the gateway wrote.
     */
    @Test
    fun `passes through a body that is not the envelope`() {
        val html = failWith(502, "<html>502 Bad Gateway</html>")
        assertEquals("<html>502 Bad Gateway</html>", html.body)
        assertNull(html.code)

        val empty = failWith(500, "")
        assertEquals("", empty.body)
        assertNull(empty.code)

        val noMessage = failWith(500, """{"code":"NO_MESSAGE"}""")
        assertEquals("""{"code":"NO_MESSAGE"}""", noMessage.body)
        assertNull(noMessage.code)
    }

    /** An envelope without a code is still an envelope; the message still unwraps. */
    @Test
    fun `unwraps a message when the envelope carries no code`() {
        val e = failWith(500, """{"error":"Something broke."}""")
        assertEquals("Something broke.", e.body)
        assertNull(e.code)
    }
}
