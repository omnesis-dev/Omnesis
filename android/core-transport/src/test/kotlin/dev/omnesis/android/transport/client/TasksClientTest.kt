// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.http.GatewayHttp
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The `/tasks*` requests, byte for byte where the gateway's strict schemas care. */
class TasksClientTest {

    private lateinit var server: MockWebServer

    @Before fun setUp() { server = MockWebServer(); server.start() }

    @After fun tearDown() { server.shutdown() }

    private fun client() = TasksClient(GatewayHttp(OkHttpClient(), server.url("/").toString(), "tok"))

    private fun body(): JsonObject = OmnesisJson.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

    private val receipt = """{"task":{"id":"loop_a","title":"Invented"},"receipt":{"text":"Done: Invented","undoSeq":5}}"""

    @Test
    fun a_view_is_read_for_the_device_day() = runTest {
        server.enqueue(MockResponse().setBody("""{"view":"month","day":"2026-10-12","tasks":[]}"""))

        val view = client().view(TaskView.MONTH, "2026-10-12")

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/tasks?view=month&date=2026-10-12", request.path)
        assertEquals("2026-10-12", view.day)
    }

    @Test
    fun a_task_id_is_one_encoded_path_segment() = runTest {
        server.enqueue(MockResponse().setBody("""{"task":{"id":"loop/odd id"},"history":[]}"""))

        client().detail("loop/odd id")

        assertEquals("/tasks/loop%2Fodd%20id", server.takeRequest().path)
    }

    @Test
    fun counts_are_read_for_the_device_day_without_a_view() = runTest {
        server.enqueue(MockResponse().setBody("""{"day":"2026-10-12","counts":{"today":4,"suggested":2}}"""))

        val counts = client().counts("2026-10-12")

        val request = server.takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/tasks/counts?date=2026-10-12", request.path)
        assertEquals(4, counts.counts.today)
        assertEquals(2, counts.counts.suggested)
    }

    @Test
    fun actions_send_exactly_the_fields_the_gateway_accepts() = runTest {
        repeat(8) { server.enqueue(MockResponse().setBody(receipt)) }
        val tasks = client()

        tasks.act("loop_a", TaskAction.Complete(note = "  "))
        val complete = server.takeRequest()
        assertEquals("/tasks/loop_a/actions", complete.path)
        assertEquals("""{"action":"complete"}""", complete.body.readUtf8())

        tasks.act("loop_a", TaskAction.Complete(note = "Paid by card"))
        assertEquals("Paid by card", body()["note"]?.jsonPrimitive?.content)

        tasks.act("loop_a", TaskAction.Migrate("2026-11"))
        assertEquals("""{"action":"migrate","to":"2026-11"}""", server.takeRequest().body.readUtf8())

        tasks.act("loop_a", TaskAction.Accept())
        assertEquals("""{"action":"accept"}""", server.takeRequest().body.readUtf8())

        tasks.act("loop_a", TaskAction.Keep)
        assertEquals("""{"action":"keep"}""", server.takeRequest().body.readUtf8())

        tasks.act("loop_a", TaskAction.Ignore())
        assertEquals("""{"action":"ignore"}""", server.takeRequest().body.readUtf8())

        // Accepting with a note sends the note with its id; a blank note sends neither.
        tasks.act("loop_a", TaskAction.Accept("2026-11", note = " The form is in the glovebox ", noteId = "6f1c2a3e-0000-4000-8000-000000000001"))
        assertEquals(
            """{"action":"accept","scheduledFor":"2026-11","note":"The form is in the glovebox","noteId":"6f1c2a3e-0000-4000-8000-000000000001"}""",
            server.takeRequest().body.readUtf8(),
        )
        tasks.act("loop_a", TaskAction.Accept(note = "  ", noteId = "6f1c2a3e-0000-4000-8000-000000000002"))
        assertEquals("""{"action":"accept"}""", server.takeRequest().body.readUtf8())
    }

    /** Clearing a schedule is an explicit null; leaving a field alone omits it. */
    @Test
    fun an_edit_tells_clear_apart_from_keep() = runTest {
        server.enqueue(MockResponse().setBody(receipt))

        client().act(
            "loop_a",
            TaskAction.Edit(
                title = "Renamed",
                scheduledFor = FieldChange.Clear,
                deadline = FieldChange.Set(TaskDeadlineInput.by("2026-10-20")),
            ),
        )

        val sent = body()
        assertEquals("edit", sent["action"]?.jsonPrimitive?.content)
        assertEquals("Renamed", sent["title"]?.jsonPrimitive?.content)
        assertTrue("scheduledFor" in sent)
        assertEquals(JsonNull, sent["scheduledFor"])
        assertEquals("by", sent["deadline"]?.jsonObject?.get("type")?.jsonPrimitive?.content)
        assertEquals("2026-10-20", sent["deadline"]?.jsonObject?.get("date")?.jsonPrimitive?.content)
        assertFalse("description" in sent)
    }

    @Test
    fun undo_posts_the_receipt_sequence() = runTest {
        server.enqueue(MockResponse().setBody(receipt))

        val result = client().undo(5)

        val request = server.takeRequest()
        assertEquals("/tasks/undo", request.path)
        assertEquals("""{"seq":5}""", request.body.readUtf8())
        assertEquals(5L, result.receipt.undoSeq)
    }

    /**
     * Every read of the journal reaches the gateway: a cached view or count would show a task
     * as it was before the change the user just made.
     */
    @Test
    fun journal_reads_are_never_served_from_a_cache() = runTest {
        server.enqueue(MockResponse().setBody("""{"view":"today","day":"2026-10-12","tasks":[]}"""))
        server.enqueue(MockResponse().setBody("""{"day":"2026-10-12","counts":{}}"""))
        server.enqueue(MockResponse().setBody("""{"task":{"id":"loop_a"},"history":[]}"""))
        val tasks = client()

        tasks.view(TaskView.TODAY, "2026-10-12")
        tasks.counts("2026-10-12")
        tasks.detail("loop_a")

        repeat(3) { assertEquals("no-store", server.takeRequest().getHeader("Cache-Control")) }
    }
}
