// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import dev.omnesis.android.transport.http.GatewayHttp

/**
 * Wire contract for the watch runtime's read surface.
 *
 * The cases that matter are the ones where the gateway says less than this
 * build expects. A phone is a client version the operator cannot upgrade in
 * step with their gateway — it is in a pocket — so every field the gateway may
 * omit has to read as "this one does not say" rather than as a decode failure
 * that empties the screen.
 *
 * All fixture data is invented.
 */
class WatchesClientTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() =
        WatchesClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    @Test fun `lists watches and asks the admin route for them`() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """
                {"watches":[
                  {"id":"w_1","name":"an-invoice-arrived","status":"active",
                   "addedAt":"2026-05-04T09:15:00.000Z","firings":3,"fromSeq":41},
                  {"id":"w_2","name":"a-deadline-passed","status":"paused",
                   "note":"node 'mail' failed (provider)","firings":0}
                ]}
                """.trimIndent(),
            ),
        )

        val watches = client().list()

        assertEquals(listOf("w_1", "w_2"), watches.map { it.id })
        assertEquals(3, watches[0].firings)
        assertEquals("node 'mail' failed (provider)", watches[1].note)
        // A paused watch that cannot say why is a watch the operator has to
        // delete to recover, so the note travels even when absent elsewhere.
        assertNull(watches[0].note)
        assertEquals("/admin/watch/watches", server.takeRequest().path)
    }

    @Test fun `a watch an older gateway describes with fewer fields still decodes`() = runTest {
        // `firings`, `addedAt`, `fromSeq` and `note` all absent.
        server.enqueue(MockResponse().setBody("""{"watches":[{"id":"w_1","name":"n","status":"active"}]}"""))

        val watches = client().list()

        assertEquals(1, watches.size)
        assertEquals(0, watches[0].firings)
        assertNull(watches[0].addedAt)
    }

    @Test fun `a firing carries what it read and what delivery did`() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """
                {"watch":"an-invoice-arrived","firings":[
                  {"seq":91,"firedAt":"2026-05-04T09:15:00.000Z",
                   "noticedAt":"2026-05-04T09:15:30.000Z",
                   "delivery":{"kind":"omnesis-notify","delivered":0,"attempted":2,
                               "error":"APNs delivery failed for all 2 device(s)"},
                   "documents":[{"id":"doc_quote","title":"Your quote for the roof",
                                 "sourceId":"gmail:jamie.lopez@example.com"}]}
                ]}
                """.trimIndent(),
            ),
        )

        val page = client().firings("w_1")

        assertEquals("an-invoice-arrived", page.watchName)
        assertEquals(0, page.firings[0].delivery?.delivered)
        assertEquals("Your quote for the roof", page.firings[0].documents[0].title)
        val request = server.takeRequest()
        assertTrue(request.path!!.startsWith("/admin/watch/watches/w_1/firings"))
        assertTrue(request.path!!.contains("limit=50"))
    }

    @Test fun `a firing that was never sent has no delivery block and no evidence`() = runTest {
        // Most watches deliver nowhere, and most firings the runtime reaches
        // through a clock or a row have nothing behind them. Both read as
        // absence, not as failure.
        server.enqueue(
            MockResponse().setBody(
                """{"watch":"a-deadline-passed","firings":[{"seq":7,"firedAt":"2026-05-04T09:15:00.000Z"}]}""",
            ),
        )

        val page = client().firings("w_1")

        assertNull(page.firings[0].delivery)
        assertNull(page.firings[0].noticedAt)
        assertTrue(page.firings[0].documents.isEmpty())
    }

    @Test fun `a watch id stays one path segment`() = runTest {
        // Ids come from the gateway, but the route is built from one, and a
        // value containing a slash would silently address a different route.
        server.enqueue(MockResponse().setBody("""{"watch":"n","firings":[]}"""))

        client().firings("w/../admin")

        assertEquals(
            "/admin/watch/watches/w%2F..%2Fadmin/firings?limit=50",
            server.takeRequest().path,
        )
    }

    @Test fun `the definition comes back as text, not as a decoded shape`() = runTest {
        // The DSL is the runtime's contract, not the app's. Pretty-printing it
        // rather than parsing is what stops the phone needing an upgrade every
        // time the language grows a field.
        server.enqueue(
            MockResponse().setBody(
                """{"watch":{"id":"w_1","status":"active","dsl":{"name":"an-invoice-arrived","nodes":[{"id":"mail"}]}}}""",
            ),
        )

        val text = client().definition("w_1")

        assertTrue(text.contains("\"name\": \"an-invoice-arrived\""))
        assertTrue(text.contains("\"id\": \"mail\""))
        // Only the definition. The record around it is the same status the screen already
        // states in its own words, and printing it again as raw JSON buries what was asked for.
        assertFalse(text.contains("\"status\""))
    }

    @Test fun `a watch that came back without a definition says so`() = runTest {
        server.enqueue(MockResponse().setBody("""{"watch":{"id":"w_1","status":"active"}}"""))

        var failed = false
        try {
            client().definition("w_1")
        } catch (expected: IllegalStateException) {
            failed = true
        }
        assertTrue("a watch with no dsl must not render as an empty definition", failed)
    }

    @Test fun `the disclosure is read from the same route, and its absence is not a failure`() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"watch":{"id":"w_1","disclosure":{"authoredBy":"integration","subscriptionId":"sub_1","status":"active","integrationName":"Hermes","instruction":"Reply on the thread."}}}""",
            ),
        )
        val disclosure = client().disclosure("w_1")
        assertEquals("Hermes", disclosure?.integrationName)
        assertEquals("sub_1", disclosure?.subscriptionId)

        // A watch nobody outside Omnesis hears about carries no disclosure, and an operator
        // reading it must not see that as a broken screen.
        server.enqueue(MockResponse().setBody("""{"watch":{"id":"w_2"}}"""))
        assertNull(client().disclosure("w_2"))

        server.enqueue(MockResponse().setBody("""{"watch":{"id":"w_3","disclosure":null}}"""))
        assertNull(client().disclosure("w_3"))
    }
}
