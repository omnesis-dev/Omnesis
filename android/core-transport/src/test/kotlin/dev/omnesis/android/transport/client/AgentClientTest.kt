// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import java.time.ZoneId
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AgentClientTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() = AgentClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    /**
     * The device's zone rides the session-create body so the agent renders
     * wall-clock times in the clock the phone is showing — the gateway sits on
     * a machine that stays home while the phone travels.
     */
    @Test
    fun create_session_sends_the_device_time_zone() = runTest {
        server.enqueue(MockResponse().setBody("""{"sessionId":"s_one","model":"m","backend":"b"}"""))

        client().createSession(timeZone = "Asia/Tokyo")

        val req = server.takeRequest()
        assertEquals("POST", req.method)
        val body = req.body.readUtf8()
        assertTrue(body.contains("\"timeZone\":\"Asia/Tokyo\""))
        assertTrue(body.contains("\"profile\":\"interactive\""))
    }

    /** A visual resume must switch a still-live Watch/Siri voice session back onto Timeline tools. */
    @Test
    fun resume_session_explicitly_requests_the_interactive_profile() = runTest {
        server.enqueue(MockResponse().setBody("""{"sessionId":"voice-thread","model":"m","backend":"b"}"""))

        client().createSession(resumeFromId = "voice-thread", timeZone = "Europe/London")

        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"resumeFromId\":\"voice-thread\""))
        assertTrue(body.contains("\"profile\":\"interactive\""))
    }

    /** A headless assistant ask selects the concise voice prompt without changing visual defaults. */
    @Test
    fun voice_session_requests_voice_profile_and_empty_transcript() = runTest {
        server.enqueue(MockResponse().setBody("""{"sessionId":"voice-thread","model":"m","backend":"b"}"""))

        client().createSession(
            resumeFromId = "voice-thread",
            transcriptLimit = 0,
            timeZone = "Europe/London",
            profile = AgentSessionProfile.VOICE,
        )

        val request = server.takeRequest()
        assertEquals("/agent/sessions?transcriptLimit=0", request.path)
        val body = OmnesisJson.parseToJsonElement(request.body.readUtf8()).jsonObject
        assertEquals("voice-thread", body["resumeFromId"]?.jsonPrimitive?.content)
        assertEquals("voice", body["profile"]?.jsonPrimitive?.content)
        assertEquals("Europe/London", body["timeZone"]?.jsonPrimitive?.content)
    }

    /** Unresolvable on this device → the key is dropped and the gateway falls back. */
    @Test
    fun create_session_omits_an_absent_time_zone() = runTest {
        server.enqueue(MockResponse().setBody("""{"sessionId":"s_one","model":"m","backend":"b"}"""))

        client().createSession(timeZone = null)

        assertTrue(!server.takeRequest().body.readUtf8().contains("timeZone"))
    }

    /** The default argument reads the running device's zone rather than nothing. */
    @Test
    fun create_session_defaults_to_the_running_device_zone() = runTest {
        server.enqueue(MockResponse().setBody("""{"sessionId":"s_one","model":"m","backend":"b"}"""))

        client().createSession()

        val body = server.takeRequest().body.readUtf8()
        assertTrue(body.contains("\"timeZone\":\"" + ZoneId.systemDefault().id + "\""))
    }

    /** Plain visual sends retain their old, minimal request body exactly. */
    @Test
    fun default_send_omits_all_optional_flags() = runTest {
        server.enqueue(MockResponse().setBody("""{"messageId":"m-one"}"""))

        client().sendMessage("s-one", "What changed?")

        assertEquals("""{"text":"What changed?"}""", server.takeRequest().body.readUtf8())
    }

    /** A bounded voice wait arms both the slow-answer push and its read-state lease. */
    @Test
    fun voice_send_includes_notify_and_viewing_budgets_without_deep_research() = runTest {
        server.enqueue(MockResponse().setBody("""{"messageId":"m-one"}"""))

        client().sendMessage(
            sessionId = "s-one",
            text = "What changed?",
            notifyAfterMs = 20_000,
            viewingForMs = 30_000,
        )

        val body = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
        assertEquals("What changed?", body["text"]?.jsonPrimitive?.content)
        assertEquals("20000", body["notifyAfterMs"]?.jsonPrimitive?.content)
        assertEquals("30000", body["viewingForMs"]?.jsonPrimitive?.content)
        assertTrue("deepResearch must stay absent", "deepResearch" !in body)
    }

    @Test
    fun conversation_page_sends_limit_and_cursor_and_decodes_next_cursor() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"conversations":[
                  {"id":"s_one","title":"Q4 budget review","model":"m","backend":"b",
                   "createdAt":"2026-01-01T00:00:00.000Z",
                   "updatedAt":"2026-01-02T00:00:00.000Z","messageCount":2}
                ],"nextCursor":"cursor-2"}""",
            ),
        )

        val page = client().conversationPage(limit = 25, cursor = "cursor-1")
        assertEquals("cursor-2", page.nextCursor)
        assertEquals(1, page.conversations.size)
        assertEquals("s_one", page.conversations[0].sessionId)

        val req = server.takeRequest()
        assertEquals("GET", req.method)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        val path = req.path ?: ""
        assertTrue(path.startsWith("/agent/conversations"))
        assertTrue(path.contains("limit=25"))
        assertTrue(path.contains("cursor=cursor-1"))
    }

    @Test
    fun set_pinned_sends_patch_with_pinned_body() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))

        client().setPinned("s_one", true)

        val req = server.takeRequest()
        assertEquals("PATCH", req.method)
        assertEquals("/agent/conversations/s_one", req.path)
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertTrue(req.body.readUtf8().contains("\"pinned\":true"))
    }

    @Test
    fun conversation_summary_decodes_pinned_with_back_compat() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"conversations":[
                  {"id":"p","title":"t","model":"m","backend":"b","createdAt":"x","updatedAt":"y","messageCount":1,"pinned":true},
                  {"id":"u","title":"t","model":"m","backend":"b","createdAt":"x","updatedAt":"y","messageCount":1}
                ],"nextCursor":null}""",
            ),
        )

        val page = client().conversationPage()
        assertTrue("explicit pinned decodes true", page.conversations[0].pinned)
        assertEquals("omitted pinned defaults to false", false, page.conversations[1].pinned)
    }

    @Test
    fun bounded_session_and_older_messages_use_separate_cursor_queries() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"sessionId":"s_one","messages":[],"messagesAreVisible":true,
                   "origin":{"kind":"brief","runId":"run-example","brief":{"title":"Invented brief"},"seedMessageCount":2},
                   "messagePageInfo":{"hasMore":true,"limit":25,"nextCursor":"older/cursor"}}""",
            ),
        )
        val session = client().createSession("s_one", transcriptLimit = 25)
        assertEquals("older/cursor", session.messagePageInfo?.nextCursor)
        assertEquals("brief", session.origin?.kind)
        assertEquals(2, session.origin?.seedMessageCount)
        assertTrue(session.origin?.brief != null)
        server.takeRequest().also {
            assertEquals("POST", it.method)
            assertEquals("/agent/sessions?transcriptLimit=25", it.path)
            assertTrue(it.body.readUtf8().contains("\"resumeFromId\":\"s_one\""))
        }

        server.enqueue(
            MockResponse().setBody(
                """{"messages":[],"messagesAreVisible":true,"messageCount":75,
                   "messagePageInfo":{"hasMore":false,"limit":25}}""",
            ),
        )
        val older = client().conversationMessages("s_one", limit = 25, cursor = "older/cursor")
        assertEquals(75, older.messageCount)
        assertEquals(false, older.messagePageInfo.hasMore)
        assertEquals(
            "/agent/conversations/s_one/messages?limit=25&cursor=older%2Fcursor",
            server.takeRequest().path,
        )
    }
}
