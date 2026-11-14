// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.*
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonArray
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
    @Test fun theEditorDecodesEveryFieldStateAndKeepsAStateItDoesNotKnow() = runTest {
        server.enqueue(MockResponse().setBody("""
            {"sourceId":"gmail:one/account","sourceType":"gmail","devices":[{"id":"dev_studio","name":"Studio Mac"}],"showDeviceLevel":false,"retryAfterMs":1500,
             "profile":"declared","profileText":null,"connected":true,
             "resync":{"state":"needs-resync","fields":["extra.labelIds","${'$'}people"],"text":"Label and people filters need Gmail to be resynced."},
             "fields":[
              {"field":"${'$'}people","capability":"person","noun":{"one":"person","many":"people"},"picker":"search","scope":"global","identifiers":["email","domain"],
               "state":{"status":"ready"},"counts":{"status":"ready","tooOld":0,"unmatched":2,"tooOldText":null,"unmatchedText":"2 records can’t be matched to a person and stay hidden."}},
              {"field":"extra.labelIds","capability":"membership","noun":{"one":"label","many":"labels"},"picker":"tree","scope":"global",
               "levels":[{"one":"label","many":"labels"}],"inside":{"one":"label","many":"labels"},"insideText":"Includes the labels inside.",
               "state":{"status":"needs-resync","cost":"This reads about 95,000 messages a day.","text":"Label filters need Gmail to be resynced. Search keeps working meanwhile. This reads about 95,000 messages a day."},
               "counts":{"status":"pending"}},
              {"field":"extra.folderId","capability":"tree","noun":{"one":"folder","many":"folders"},"picker":"tree","scope":"device",
               "state":{"status":"resyncing","processed":212000,"total":900000,"text":"Resyncing Gmail: 212,000 of about 900,000."},"counts":{"status":"pending"}},
              {"field":"extra.chatId","capability":"membership","noun":{"one":"chat","many":"chats"},"picker":"search","scope":"global",
               "state":{"status":"collector-behind","devices":[{"id":"dev_studio","name":"Studio Mac"}],"text":"Update Omnesis on Studio Mac to use these filters."},"counts":{"status":"pending"}},
              {"field":"extra.later","capability":"membership","noun":{"one":"thing","many":"things"},"state":{"status":"something-new","text":"A later state."}}
             ]}
        """.trimIndent()))
        val editor = client().filterEditor("gmail:one/account")
        val request = server.takeRequest()
        assertTrue(request.path!!.endsWith("/admin/access/source-filters/gmail:one%2Faccount") || request.path!!.endsWith("/admin/access/source-filters/gmail%3Aone%2Faccount"))
        assertEquals("no-store", request.getHeader("Cache-Control"))
        assertEquals(1500L, editor.retryAfterMs)
        assertEquals("declared", editor.profile); assertNull(editor.profileText); assertTrue(editor.connected)
        assertEquals(listOf("extra.labelIds", FilterRef.PEOPLE_FIELD), editor.resync?.fields)
        assertEquals(FilterFieldState(FilterFieldState.NEEDS_RESYNC, text = "Label and people filters need Gmail to be resynced."), editor.resync?.fieldState)
        assertEquals(listOf("ready", "needs-resync", "resyncing", "collector-behind", "something-new"), editor.fields.map { it.state.status })
        assertTrue(editor.fields[0].state.ready)
        assertEquals("2 records can’t be matched to a person and stay hidden.", editor.fields[0].counts.unmatchedText)
        assertEquals("This reads about 95,000 messages a day.", editor.fields[1].state.cost)
        assertTrue(editor.fields[1].counts.pending)
        assertTrue(editor.fields[1].tree)
        assertEquals(212000L to 900000L, editor.fields[2].state.processed to editor.fields[2].state.total)
        assertEquals("device", editor.fields[2].scope)
        assertEquals(listOf("Studio Mac"), editor.fields[3].state.devices?.map { it.name })
        assertFalse(editor.fields[4].state.ready)
        assertEquals("A later state.", editor.fields[4].state.text)
        assertTrue(editor.fields[4].counts.pending)
    }
    @Test fun choicesKeepAccountQueryAndDeviceSeparateAndPendingCountsDecodeAsNull() = runTest {
        server.enqueue(MockResponse().setBody("""{"sourceId":"files:one/account","field":"extra.projectDir","retryAfterMs":1500,"nextCursor":"next-page","items":[
            {"ref":{"capability":"tree","field":"extra.projectDir","id":"~/work/atlas-api","device":"dev_studio"},"label":"~/work/atlas-api","shortLabel":"atlas-api","count":214,"parentId":"~/work","hasChildren":true,"depth":1},
            {"ref":{"capability":"tree","field":"extra.projectDir","id":"~/work/ledger","device":"dev_studio"},"label":"~/work/ledger","shortLabel":"ledger","count":null,"parentId":"~/work","hasChildren":false,"depth":1}]}"""))
        val options = client().filterOptions("files:one/account", "extra.projectDir", "Cedar & archive", "~/work", "dev_studio", "page+two")
        val request = server.takeRequest()
        assertTrue(request.path!!.contains("files:one%2Faccount/options") || request.path!!.contains("files%3Aone%2Faccount/options"))
        assertEquals("extra.projectDir", request.requestUrl!!.queryParameter("field"))
        assertEquals("Cedar & archive", request.requestUrl!!.queryParameter("q"))
        assertEquals("~/work", request.requestUrl!!.queryParameter("parentId"))
        assertEquals("dev_studio", request.requestUrl!!.queryParameter("device"))
        assertEquals("page+two", request.requestUrl!!.queryParameter("cursor"))
        assertEquals("Bearer fictional-owner", request.getHeader("Authorization"))
        assertEquals(listOf(214L, null), options.items.map { it.count })
        assertEquals("atlas-api", options.items.first().shortLabel)
        assertEquals("dev_studio", options.items.first().ref.device)
        assertEquals(1500L, options.retryAfterMs)
    }
    @Test fun aPreviewIsPendingOrReadyAndAPersonIsSentWithOnlyItsOwnKeys() = runTest {
        server.enqueue(MockResponse().setBody("""{"status":"pending","retryAfterMs":1500}"""))
        server.enqueue(MockResponse().setBody("""{"status":"ready","sourceId":"chat:one","total":3,"visible":1,"hidden":2,"tooOld":0,"unmatched":1,"tooOldText":null,
            "unmatchedText":"1 record can’t be matched to a chat and stay hidden.","connected":true,"items":[{"ref":{"capability":"membership","field":"extra.chatId","id":"chat-1"},"label":"chat-1","count":0,"missing":true,"reason":"not-in-list"}]}"""))
        val person = FilterRef.person("Maya", listOf(FilterIdentifier("phone", "+15550100123")))
        val policy = SourceFilter.empty("chat:one", "new", "answer").copy(rules = listOf(FilterRule(listOf(person, FilterRef.item(FilterRef.MEMBERSHIP, "extra.chatId", "chat-1")), "hide")))
        val pending = client().filterPreview(policy)
        assertTrue(pending.pending); assertEquals(1500L, pending.retryAfterMs)
        val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        val match = body.getValue("policy").jsonObject.getValue("rules").jsonArray.single().jsonObject.getValue("match").jsonArray
        assertEquals(setOf("capability", "label", "identifiers"), match[0].jsonObject.keys)
        assertEquals(setOf("capability", "field", "id"), match[1].jsonObject.keys)
        val ready = client().filterPreview(policy)
        assertFalse(ready.pending)
        assertEquals(2L, ready.hidden); assertEquals(1L, ready.unmatched)
        assertNull(ready.tooOldText)
        assertEquals(true, ready.items.single().missing)
        assertEquals(FilterPreviewItem.NOT_IN_LIST, ready.items.single().reason)
        assertTrue(ready.connected)
        assertEquals(2, server.requestCount)
    }
    @Test fun aTypedAddressIsCheckedByTheGatewayWhichNamesTheProblem() = runTest {
        server.enqueue(MockResponse().setBody("""{"identifier":{"type":"phone","value":"+15550100142"}}"""))
        server.enqueue(MockResponse().setBody("""{"error":"Enter a valid phone number. Include the international country code."}"""))
        assertEquals(FilterIdentifier("phone", "+15550100142"), client().checkFilterIdentifier("phone", "00 1 (555) 010-0142").identifier)
        val sent = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("phone", sent.getValue("type").jsonPrimitive.content)
        assertEquals("00 1 (555) 010-0142", sent.getValue("value").jsonPrimitive.content)
        val refused = client().checkFilterIdentifier("phone", "+44 (0)7700 900123")
        assertNull(refused.identifier)
        assertEquals("Enter a valid phone number. Include the international country code.", refused.error)
        assertTrue(server.takeRequest().path!!.endsWith("/admin/access/source-filters/identifiers"))
    }
    @Test fun aResyncInPlaceAsksForThatModeOnTheResyncRoute() = runTest {
        server.enqueue(MockResponse().setBody("""{"mode":"in-place"}"""))
        client().resyncSource("gmail:one", ResyncMode.IN_PLACE)
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertTrue(request.path!!.endsWith("/resync"))
        assertEquals("in-place", OmnesisJson.parseToJsonElement(request.body.readUtf8()).jsonObject.getValue("mode").jsonPrimitive.content)
    }
    @Test fun aDocumentsFilterDetailsAndWhoCanReadItDecode() = runTest {
        server.enqueue(MockResponse().setBody("""{"documentId":"doc_8d1e","sourceVersion":2,"fields":[
            {"field":"extra.labelIds","noun":{"one":"label","many":"labels"},"state":"present","stateText":"","items":[{"id":"Label_12","label":"Finance","listed":true},{"id":"Label_99","label":"Label_99","listed":false}]},
            {"field":"extra.folderId","noun":{"one":"folder","many":"folders"},"state":"too-old","stateText":"Written before this source recorded its folders. Resync the source to add them.","items":[]}]}"""))
        server.enqueue(MockResponse().setBody("""{"documentId":"doc_8d1e","title":"Q4 budget review","sourceId":"whatsapp-messages:+15550100123","sourceName":"WhatsApp","accountLabel":"+1 (555) 010-0123","sourceVersion":2,
            "notes":{"answer":"“Can read” under Answer means Omnesis may use this document when answering that agent.","owner":"This page is for you, the owner."},
            "levels":[{"id":"lvl_7c21","name":"Coding assistant","agents":[{"id":"grt_51aa","name":"Claude Code on Studio Mac","kind":"connection"},{"id":"dev_1","name":"Kitchen speaker","kind":"device"}],
              "answer":{"readable":true,"code":"readable","text":"This account is shared with all content"},"direct":{"readable":false,"code":"hidden-by-item","text":"Hidden by: label Finance"}},
             {"id":"lvl_90fe","name":"Travel planner","agents":[],"answer":{"readable":false,"code":"account-not-shared","text":"This account is not shared"},
              "direct":{"readable":false,"code":"permission-not-granted","text":"Direct is not granted on this level"}}]}"""))
        val details = client().documentFilterDetails("doc/8d1e")
        assertTrue(server.takeRequest().path!!.contains("/admin/documents/doc%2F8d1e/filter-details"))
        assertEquals(2, details.sourceVersion)
        assertEquals(listOf(true, false), details.fields.first().items.map { it.listed })
        assertEquals(DocumentFilterField.TOO_OLD, details.fields.last().state)
        val audit = client().documentAccess("doc_8d1e")
        assertTrue(server.takeRequest().path!!.endsWith("/admin/documents/doc_8d1e/access"))
        assertEquals("+1 (555) 010-0123", audit.accountLabel)
        assertEquals(listOf("Coding assistant", "Travel planner"), audit.levels.map { it.name })
        assertEquals(listOf(false, true), audit.levels.first().agents.map { it.integration })
        assertEquals("Hidden by: label Finance", audit.levels.first().direct.text)
        assertTrue(audit.levels.last().agents.isEmpty())
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
    @Test fun deletingALevelSendsOneDeleteAndSurfacesTheInUseRefusal() = runTest {
        server.enqueue(MockResponse().setBody("""{"removed":true}"""))
        client().deleteAccessLevel("level/example")
        val request = server.takeRequest()
        assertEquals("DELETE", request.method)
        assertEquals("/admin/access/levels/level%2Fexample", request.path)
        assertEquals("Bearer fictional-owner", request.getHeader("Authorization"))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"error":"level-in-use"}"""))
        try {
            client().deleteAccessLevel("level-example")
            fail("A level in use must be refused")
        } catch (error: GatewayException.ServerError) { assertEquals(409, error.status) }
        assertEquals(2, server.requestCount)
    }
}
