// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Route/decode contract for the document-inspector read endpoints (near-dupes + trail). */
class SearchClientInspectorTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() = SearchClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    @Test
    fun near_dupes_decodes_edges_and_hits_route() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """
                {"edges":[
                  {"otherDocId":"d2","otherTitle":"Re: Q4 budget review","otherSourceId":"gmail:user@example.com",
                   "otherDocType":"email","otherSourceUrl":"https://example.com/d2","jaccard":0.91,
                   "pairUniqueDf2":3,"pairUniqueDf5":1,"containmentMin":0.8,"gateFamily":"text"}
                ],"nextCursor":"c1"}
                """.trimIndent(),
            ),
        )
        val resp = client().nearDupes("d1")
        assertEquals(1, resp.edges.size)
        assertEquals("d2", resp.edges[0].otherDocId)
        assertEquals(0.91, resp.edges[0].jaccard, 1e-9)
        assertEquals("text", resp.edges[0].gateFamily)
        assertEquals("c1", resp.nextCursor)
        assertEquals("/documents/d1/near-dupes?limit=20", server.takeRequest().path)
    }

    @Test
    fun near_dupes_tolerates_omitted_optional_fields() = runTest {
        server.enqueue(MockResponse().setBody("""{"edges":[{"otherDocId":"d2"}]}"""))
        val resp = client().nearDupes("d1")
        assertEquals("d2", resp.edges[0].otherDocId)
        assertEquals(0.0, resp.edges[0].jaccard, 1e-9)
        assertTrue(resp.edges[0].otherTitle.isEmpty())
    }

    @Test
    fun graph_and_annotation_pages_decode_and_forward_cursors() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"linkType":"references","rawTarget":"https://example.com/a"}],
                   "pageInfo":{"hasMore":true,"limit":25,"nextCursor":"out/next"}}""",
            ),
        )
        val outbound = client().outboundRefs("d1", cursor = "out/current")
        assertEquals("out/next", outbound.pageInfo.nextCursor)
        assertEquals(
            "/documents/d1/refs/outbound?limit=25&cursor=out%2Fcurrent",
            server.takeRequest().path,
        )

        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"sourceDocId":"d2","sourceSourceId":"notes:local","linkType":"references"}],
                   "pageInfo":{"hasMore":false,"limit":25}}""",
            ),
        )
        assertEquals("d2", client().inboundRefs("d1").items.single().sourceDocId)
        assertEquals("/documents/d1/refs/inbound?limit=25", server.takeRequest().path)

        server.enqueue(
            MockResponse().setBody(
                """{"annotations":[{"id":"a1","claimText":"An invented observation","dependentCount":2}],
                   "pageInfo":{"hasMore":true,"limit":20,"nextCursor":"annotations/next"}}""",
            ),
        )
        val annotations = client().documentAnnotations("d1", cursor = "annotations/current")
        assertEquals(2, annotations.annotations.single().dependentCount)
        assertEquals("annotations/next", annotations.pageInfo.nextCursor)
        assertEquals(
            "/documents/d1/annotations?limit=20&includeDependents=0&cursor=annotations%2Fcurrent",
            server.takeRequest().path,
        )

        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"kind":"brief","id":"b1","title":"Fictional brief"}],
                   "pageInfo":{"hasMore":false,"limit":25}}""",
            ),
        )
        assertEquals(
            "Fictional brief",
            client().annotationDependents("doc", "a1").items.single().title,
        )
        assertEquals(
            "/admin/cognition/annotations/doc/a1/dependents?limit=25",
            server.takeRequest().path,
        )
    }

    @Test
    fun document_trail_decodes_events_and_hits_route() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """
                {"seeds":["d1"],"truncated":false,"events":[
                  {"eventId":"e0","at":"2026-01-02T10:00:00Z","kind":"event",
                   "doc":{"documentId":"d1","title":"Q4 budget review","sourceId":"notes:local","documentType":"note"},
                   "people":[{"personId":"self","name":"You","role":"author","isSelf":true}]}
                ]}
                """.trimIndent(),
            ),
        )
        val trail = client().documentTrail("d1")
        assertEquals(listOf("d1"), trail.seeds)
        assertFalse(trail.truncated)
        assertEquals(1, trail.events.size)
        assertEquals("e0", trail.events[0].eventId)
        assertEquals("Q4 budget review", trail.events[0].doc?.title)
        assertTrue(trail.events[0].people[0].isSelf)
        assertEquals("/documents/d1/trail", server.takeRequest().path)
    }

    @Test
    fun document_trail_empty_decodes_to_empty_trail() = runTest {
        server.enqueue(MockResponse().setBody("""{"seeds":["d1"],"events":[],"truncated":false}"""))
        val trail = client().documentTrail("d1")
        assertTrue(trail.events.isEmpty())
    }
}
