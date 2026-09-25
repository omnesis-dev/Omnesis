// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.RecentItemsResponse
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Route/shape contract for the people merge-rules / merge-candidates surface
 * (OkHttp MockWebServer). Parity twin of the iOS `SearchClientTests` people
 * cases — asserts the same envelopes, query params, and bodies the portal uses.
 */
class SearchClientTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() = SearchClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    @Test
    fun merge_rules_unwraps_rules_envelope_and_sends_query_flags() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"rules":[
                  {"id":"r1","kind":"user","winnerSide":"a",
                   "sideA":{"aliasType":"email","alias":"maya@example.com"},
                   "sideB":{"aliasType":"email","alias":"m.reeves@example.org"},
                   "reason":"same person","createdAt":"2026-01-02T00:00:00Z","groupId":"g1"}
                ]}""",
            ),
        )
        val rules = client().mergeRules()
        assertEquals(1, rules.size)
        assertEquals("r1", rules[0].id)
        assertEquals("user", rules[0].kind)
        assertEquals("a", rules[0].winnerSide)
        assertEquals("maya@example.com", rules[0].sideA.alias)
        assertEquals("g1", rules[0].groupId)

        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        val path = req.path ?: ""
        assertTrue(path.startsWith("/people/merge-rules"))
        assertTrue(path.contains("active=1"))
        assertTrue(path.contains("resolve=1"))
        assertTrue(path.contains("details=1"))
        assertTrue(path.contains("preMerge=1"))
    }

    @Test
    fun merge_candidates_decodes_items_and_counts_with_status_and_limit() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[
                  {"id":"c1","clusterId":"cl1",
                   "resolvedSideA":[{"id":"p1","canonicalName":"Maya Reeves"}],
                   "resolvedSideB":[{"id":"p2","canonicalName":"M. Reeves"}]}
                ],"counts":{"pending":3,"accepted":1,"denied":2}}""",
            ),
        )
        val page = client().mergeCandidates()
        assertEquals(1, page.items.size)
        assertEquals("c1", page.items[0].id)
        assertEquals("cl1", page.items[0].clusterId)
        assertEquals("Maya Reeves", page.items[0].resolvedSideA.first().canonicalName)
        assertEquals(3, page.counts.pending)
        assertEquals(1, page.counts.accepted)
        assertEquals(2, page.counts.denied)

        val req = server.takeRequest()
        assertEquals("GET", req.method)
        val path = req.path ?: ""
        assertTrue(path.startsWith("/people/merge-candidates"))
        assertTrue(path.contains("status=pending"))
        assertTrue(path.contains("clusterLimit="))
    }

    @Test
    fun merge_cluster_posts_person_ids_and_reason_and_decodes_result() = runTest {
        server.enqueue(MockResponse().setBody("""{"rulesCreated":2,"anchorId":"p1","groupId":"g9"}"""))
        val result = client().mergeCluster(listOf("p1", "p2", "p3"), "same person")
        assertEquals(2, result.rulesCreated)
        assertEquals("p1", result.anchorId)
        assertEquals("g9", result.groupId)

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/people/merge-candidates/merge-cluster", req.path)
        assertEquals(
            """{"personIds":["p1","p2","p3"],"reason":"same person"}""",
            req.body.readUtf8(),
        )
    }

    @Test
    fun people_stats_decodes_summary_and_merge_counts() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"totalPeople":420,"totalAliases":1200,"totalLinks":9000,
                   "selfDetected":true,"pendingMergeCandidates":133,"mergeRules":415}""",
            ),
        )
        val stats = client().peopleStats()
        assertEquals(420, stats.totalPeople)
        assertEquals(true, stats.selfDetected)
        assertEquals(133, stats.pendingMergeCandidates)
        assertEquals(415, stats.mergeRules)

        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("/people/stats", req.path)
    }

    @Test
    fun deny_merge_candidate_posts_to_deny_route() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        client().denyMergeCandidate("c1")
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/people/merge-candidates/c1/deny", req.path)
    }

    @Test
    fun delete_document_issues_delete_to_document_route() = runTest {
        server.enqueue(MockResponse().setBody("""{"deleted":2}"""))
        client().deleteDocument("doc-42")
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/documents/doc-42", req.path)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
    }

    @Test
    fun delete_document_copy_only_asks_the_gateway_to_skip_the_tombstone() = runTest {
        server.enqueue(MockResponse().setBody("""{"deleted":1}"""))
        client().deleteDocument("doc-42", keepCopy = true)
        val req = server.takeRequest()
        assertEquals("DELETE", req.method)
        assertEquals("/documents/doc-42?tombstone=0", req.path)
    }

    @Test
    fun delete_document_maps_forbidden_to_typed_error() = runTest {
        server.enqueue(MockResponse().setResponseCode(403))
        val err = runCatching { client().deleteDocument("doc-42") }.exceptionOrNull()
        assertEquals(GatewayException.Forbidden::class.java, err?.javaClass)
    }

    @Test
    fun recent_items_decodes_analytics_rows_for_instance_source_id() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"kind":"analytics","table":"location_visits","displayName":"Location visits",
                   "columns":["place","duration_minutes","active"],
                   "rows":[["Studio Northstar",42.5,true],["Riverside Estate",18,false]]}""",
            ),
        )

        val response = client().recent("core-location-visits:local", limit = 30)
        assertTrue(response is RecentItemsResponse.Analytics)
        response as RecentItemsResponse.Analytics
        assertEquals(listOf("place", "duration_minutes", "active"), response.columns)
        assertEquals(2, response.rows.size)
        assertEquals("Studio Northstar", response.rows[0][0].jsonPrimitive.content)
        assertEquals("42.5", response.rows[0][1].jsonPrimitive.content)
        assertEquals("true", response.rows[0][2].jsonPrimitive.content)

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/sources/core-location-visits:local/recent?limit=30", request.path)
        assertEquals("Bearer tok", request.getHeader("Authorization"))
    }

    @Test
    fun growing_people_and_merge_cards_decode_page_info_and_forward_cursors() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"id":"p1","canonicalName":"Maya Reeves"}],
                   "pageInfo":{"hasMore":true,"limit":50,"nextCursor":"people/next"}}""",
            ),
        )
        val people = client().peoplePage(query = "maya", cursor = "people/current")
        assertEquals("p1", people.items.single().id)
        assertEquals("people/next", people.pageInfo.nextCursor)
        assertEquals(
            "/people?q=maya&limit=50&cursor=people%2Fcurrent",
            server.takeRequest().path,
        )

        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"key":"identity-1","name":"Maya Reeves","kinds":["user"],
                   "latest":"2026-01-02T00:00:00Z"}],
                   "pageInfo":{"hasMore":true,"limit":25,"nextCursor":"rules/next"}}""",
            ),
        )
        val groups = client().mergeRuleGroups(
            cursor = "rules/current",
            query = "maya",
            kind = "user",
        )
        assertEquals("identity-1", groups.items.single().key)
        assertEquals("rules/next", groups.pageInfo.nextCursor)
        assertEquals(
            "/people/merge-rule-groups?limit=25&cursor=rules%2Fcurrent&q=maya&kind=user",
            server.takeRequest().path,
        )
    }

    @Test
    fun recent_items_forwards_cursor_and_decodes_page_info() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"kind":"documents","documents":[],"pageInfo":
                   {"hasMore":true,"limit":30,"nextCursor":"recent/next"}}""",
            ),
        )

        val page = client().recent("notes:local", limit = 30, cursor = "recent/current")

        assertEquals("recent/next", page.pageInfo.nextCursor)
        assertEquals(
            "/sources/notes:local/recent?limit=30&cursor=recent%2Fcurrent",
            server.takeRequest().path,
        )
    }
}
