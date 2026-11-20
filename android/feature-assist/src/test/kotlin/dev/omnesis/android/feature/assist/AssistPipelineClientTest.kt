// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Collections

/**
 * The client against a scripted Home Assistant WebSocket that speaks the
 * Assist pipeline protocol, every reply invented for the test.
 */
class AssistPipelineClientTest {
    private lateinit var server: MockWebServer
    private val http = OkHttpClient()

    @Before fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After fun tearDown() {
        server.shutdown()
    }

    /** What the scripted instance received. */
    private class Heard {
        val texts: MutableList<String> = Collections.synchronizedList(mutableListOf())
        val binaries: MutableList<ByteString> = Collections.synchronizedList(mutableListOf())
    }

    /**
     * A Home Assistant that asks for the token, accepts [token] only, and
     * answers the run with [afterAudio] once the audio's end marker arrives.
     */
    private fun homeAssistant(
        heard: Heard,
        token: String = "valid-token",
        refuseRun: Boolean = false,
        afterAudio: List<String> = listOf(intentEnd("action_done", "Turned on the light")),
    ) {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""{"type":"auth_required","ha_version":"2026.11.0"}""")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    heard.texts += text
                    val message = Json.parseToJsonElement(text).jsonObject
                    when (message["type"]!!.jsonPrimitive.content) {
                        "auth" -> webSocket.send(
                            if (message["access_token"]!!.jsonPrimitive.content == token) {
                                """{"type":"auth_ok","ha_version":"2026.11.0"}"""
                            } else {
                                """{"type":"auth_invalid","message":"Invalid access token or password"}"""
                            },
                        )
                        "assist_pipeline/run" -> {
                            val id = message["id"]!!.jsonPrimitive.int
                            if (refuseRun) {
                                webSocket.send("""{"id":$id,"type":"result","success":false,"error":{"code":"pipeline-not-found","message":"no"}}""")
                                return
                            }
                            webSocket.send("""{"id":$id,"type":"result","success":true,"result":null}""")
                            webSocket.send(event(id, """{"type":"run-start","data":{"pipeline":"p1","language":"en","runner_data":{"stt_binary_handler_id":7,"timeout":300}}}"""))
                            webSocket.send(event(id, """{"type":"stt-start","data":{"engine":"stt.fake"}}"""))
                        }
                        "assist_pipeline/pipeline/list" -> webSocket.send(
                            """{"id":${message["id"]!!.jsonPrimitive.int},"type":"result","success":true,"result":{"pipelines":[{"id":"p1","name":"Home","language":"en"},{"id":"p2","name":"Casa","language":"it"}],"preferred_pipeline":"p2"}}""",
                        )
                    }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    heard.binaries += bytes
                    if (bytes.size == 1) afterAudio.forEach { webSocket.send(event(1, it)) }
                }
            }),
        )
    }

    private fun config(token: String = "valid-token", pipeline: String? = null) =
        AssistConfig(baseUrl = server.url("/").toString(), token = token, pipelineId = pipeline)

    private val speech = ShortArray(4_000) { (it % 100).toShort() }

    @Test fun aCommandIsSignedInRunFromSpeechToIntentAndDone() = runBlocking {
        val heard = Heard()
        homeAssistant(heard)

        val outcome = AssistPipelineClient(http).run(config(), speech)

        assertEquals(AssistOutcome.Done("Turned on the light"), outcome)
        val run = heard.texts.map { Json.parseToJsonElement(it).jsonObject }.single { it["type"]!!.jsonPrimitive.content == "assist_pipeline/run" }
        assertEquals("stt", run["start_stage"]!!.jsonPrimitive.content)
        assertEquals("intent", run["end_stage"]!!.jsonPrimitive.content)
        assertEquals(16_000, run["input"]!!.jsonObject["sample_rate"]!!.jsonPrimitive.int)
        assertNull(run["pipeline"])
        assertEquals("/api/websocket", server.takeRequest().path)

        // Every audio message carries the handler id first; the last one is the id alone.
        assertTrue(heard.binaries.all { it[0] == 7.toByte() })
        assertEquals(1, heard.binaries.last().size)
        val audioBytes = heard.binaries.dropLast(1).sumOf { it.size - 1 }
        assertEquals(speech.size * 2, audioBytes)
        // Little-endian 16-bit samples.
        val first = heard.binaries.first()
        assertEquals(speech[1].toInt(), (first[3].toInt() and 0xFF) or (first[4].toInt() shl 8))
    }

    @Test fun theChosenPipelineIsAskedFor() = runBlocking {
        val heard = Heard()
        homeAssistant(heard)
        AssistPipelineClient(http).run(config(pipeline = "p2"), speech)
        val run = heard.texts.map { Json.parseToJsonElement(it).jsonObject }.single { it["type"]!!.jsonPrimitive.content == "assist_pipeline/run" }
        assertEquals("p2", run["pipeline"]!!.jsonPrimitive.content)
    }

    @Test fun aQuestionAnsweredCountsAsDone() = runBlocking {
        homeAssistant(Heard(), afterAudio = listOf(intentEnd("query_answer", "The front door is closed")))
        assertEquals(AssistOutcome.Done("The front door is closed"), AssistPipelineClient(http).run(config(), speech))
    }

    @Test fun wordsThatMatchNoIntentAreNotUnderstood() = runBlocking {
        homeAssistant(Heard(), afterAudio = listOf(intentEnd("error", "Sorry, I couldn't understand that", code = "no_intent_match")))
        assertEquals(AssistOutcome.NotUnderstood("no_intent_match"), AssistPipelineClient(http).run(config(), speech))
    }

    @Test fun noWordsHeardIsNotUnderstood() = runBlocking {
        homeAssistant(Heard(), afterAudio = listOf("""{"type":"error","data":{"code":"stt-no-text-recognized","message":"No text recognized"}}"""))
        assertEquals(AssistOutcome.NotUnderstood("stt-no-text-recognized"), AssistPipelineClient(http).run(config(), speech))
    }

    @Test fun aBrokenStageFails() = runBlocking {
        homeAssistant(Heard(), afterAudio = listOf("""{"type":"error","data":{"code":"stt-stream-failed","message":"Speech-to-text failed"}}"""))
        assertEquals(AssistOutcome.Failed("stt-stream-failed"), AssistPipelineClient(http).run(config(), speech))
    }

    @Test fun aRefusedTokenFailsAndSendsNoAudio() = runBlocking {
        val heard = Heard()
        homeAssistant(heard)
        assertEquals(AssistOutcome.Failed("bad token"), AssistPipelineClient(http).run(config(token = "wrong"), speech))
        assertTrue(heard.binaries.isEmpty())
    }

    @Test fun aRefusedRunFails() = runBlocking {
        homeAssistant(Heard(), refuseRun = true)
        assertEquals(AssistOutcome.Failed("pipeline-not-found"), AssistPipelineClient(http).run(config(pipeline = "gone"), speech))
    }

    @Test fun anInstanceThatNeverAnswersTimesOut() = runBlocking {
        homeAssistant(Heard(), afterAudio = emptyList())
        assertEquals(AssistOutcome.Failed("timeout"), AssistPipelineClient(http, timeoutMs = 1_000).run(config(), speech))
    }

    @Test fun anUnreachableInstanceFails() = runBlocking {
        val url = server.url("/").toString()
        server.shutdown()
        val outcome = AssistPipelineClient(http).run(AssistConfig(url, "valid-token"), speech)
        assertEquals(AssistOutcome.Failed("unreachable"), outcome)
    }

    @Test fun theConnectionTestListsThePipelines() = runBlocking {
        homeAssistant(Heard())
        val check = AssistPipelineClient(http).check(config())
        assertEquals(
            AssistCheck.Ok(
                version = "2026.11.0",
                pipelines = listOf(AssistPipeline("p1", "Home", "en"), AssistPipeline("p2", "Casa", "it")),
                preferred = "p2",
            ),
            check,
        )
    }

    @Test fun theConnectionTestReportsABadToken() = runBlocking {
        homeAssistant(Heard())
        assertEquals(AssistCheck.BadToken, AssistPipelineClient(http).check(config(token = "wrong")))
    }

    @Test fun addressesBecomeTheWebSocketEndpoint() {
        assertEquals("wss://home.example.com/api/websocket", AssistPipelineClient.webSocketUrl("https://home.example.com/"))
        assertEquals("ws://192.0.2.10:8123/api/websocket", AssistPipelineClient.webSocketUrl(" http://192.0.2.10:8123 "))
        assertNull(AssistPipelineClient.webSocketUrl("home.example.com"))
        assertNull(AssistPipelineClient.webSocketUrl("https://"))
    }

    private companion object {
        fun event(id: Int, event: String) = """{"id":$id,"type":"event","event":$event}"""

        fun intentEnd(type: String, speech: String, code: String? = null): String {
            val data = code?.let { ""","data":{"code":"$it"}""" } ?: ""
            return """{"type":"intent-end","data":{"intent_output":{"response":{"response_type":"$type","speech":{"plain":{"speech":"$speech"}}$data},"conversation_id":"c1"}}}"""
        }
    }
}
