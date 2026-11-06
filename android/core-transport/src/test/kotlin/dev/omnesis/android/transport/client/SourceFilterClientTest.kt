// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.*
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class SourceFilterClientTest {
    private lateinit var server: MockWebServer
    @Before fun setup() { server = MockWebServer(); server.start() }
    @After fun cleanup() { server.shutdown() }
    private fun client() = AdminClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "fictional-owner"))
    @Test fun pickerKeepsAccountAndQueryComponentsSeparate() = runTest {
        server.enqueue(MockResponse().setBody("""{"sourceId":"scope-chat:one/account","sourceType":"scope-chat","scopes":{"items":[]},"readiness":[],"items":[],"nextCursor":"next-page"}"""))
        assertEquals("next-page", client().scopeOptions("scope-chat:one/account", "folder", "Cedar & archive", "folder/one", "page+two").nextCursor)
        val request = server.takeRequest()
        assertTrue(request.path!!.contains("scope-chat:one%2Faccount/options") || request.path!!.contains("scope-chat%3Aone%2Faccount/options"))
        assertEquals("Cedar & archive", request.requestUrl!!.queryParameter("q"))
        assertEquals("folder/one", request.requestUrl!!.queryParameter("parentId"))
        assertEquals("no-store", request.getHeader("Cache-Control"))
        assertEquals("Bearer fictional-owner", request.getHeader("Authorization"))
    }
    @Test fun previewKeepsUnknownHiddenAndNeverSavesPersonPointers() = runTest {
        server.enqueue(MockResponse().setBody("""{"sourceId":"scope-chat:one","total":3,"visible":1,"hidden":2,"unknown":1,"items":[],"samples":[],"readiness":[]}"""))
        val policy = ScopePolicy.empty("scope-chat:one", "new", "answer").copy(rules = listOf(ScopeRule(listOf(ScopeRef("participant", label = "Maya", identifiers = listOf(ScopeIdentifier("phone", "+15550100123")))), "hide")))
        val result = client().scopePreview(policy)
        assertEquals(2L, result.hidden); assertEquals(1L, result.unknown)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertFalse(request.body.readUtf8().contains("personId"))
    }
    @Test fun staleUpdateCarriesRemovedCapabilityRevisionsWithoutRetrying() = runTest {
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"stale-filter-revision"}"""))
        try {
            client().updateAccessLevel("level-example", AccessLevelUpdateBody("Research assistant", listOf(AccessGrantRule.notes()), 7, mapOf("answer" to 4, "direct" to 2)))
            fail("Stale edits must be refused")
        } catch (error: GatewayException.ServerError) { assertEquals(409, error.status) }
        val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("7", body["expectedRevision"]!!.jsonPrimitive.content)
        assertEquals("4", body["expectedFilterRevisions"]!!.jsonObject["answer"]!!.jsonPrimitive.content)
        assertEquals("2", body["expectedFilterRevisions"]!!.jsonObject["direct"]!!.jsonPrimitive.content)
        assertEquals(1, server.requestCount)
    }
}
