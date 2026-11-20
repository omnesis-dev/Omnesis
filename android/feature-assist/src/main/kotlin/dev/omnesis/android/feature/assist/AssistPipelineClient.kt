// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import android.util.Log
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Where Home Assistant is and how to sign in to it. */
data class AssistConfig(
    /** The instance's base address, `http(s)://host:port`. */
    val baseUrl: String,
    /** A long-lived access token made on the user's Home Assistant profile. */
    val token: String,
    /** The Assist pipeline to run; null for the one Home Assistant prefers. */
    val pipelineId: String? = null,
)

/** What Home Assistant made of a spoken command. */
sealed interface AssistOutcome {
    /** It carried the command out, or answered the question. */
    data class Done(val speech: String?) : AssistOutcome

    /** It heard nothing it could act on: no words, or words that match no intent. */
    data class NotUnderstood(val reason: String) : AssistOutcome

    /** It could not be reached or the run broke. */
    data class Failed(val reason: String) : AssistOutcome
}

/** What a connection test found. */
sealed interface AssistCheck {
    data class Ok(val version: String?, val pipelines: List<AssistPipeline>, val preferred: String?) : AssistCheck
    data object BadToken : AssistCheck
    data class Unreachable(val reason: String) : AssistCheck
}

data class AssistPipeline(val id: String, val name: String, val language: String?)

/**
 * Runs one spoken command through Home Assistant's Assist pipeline over its
 * WebSocket API, the way its own companion app streams voice: sign in with
 * the token, `assist_pipeline/run` from speech-to-text to intent, then the
 * audio as binary messages tagged with the handler id the run hands back and
 * an empty one to end it. Text-to-speech is not asked for; the outcome is all
 * the wearer feels. Nothing is retried: a command that cannot run now is
 * reported failed, never carried out later.
 */
class AssistPipelineClient(
    private val http: OkHttpClient,
    private val timeoutMs: Long = 20_000,
) {
    private val json = Json { ignoreUnknownKeys = true }

    /** Run [pcm], mono 16-bit at 16 kHz, through Home Assistant. */
    suspend fun run(config: AssistConfig, pcm: ShortArray): AssistOutcome {
        val socket = open(config) ?: return AssistOutcome.Failed("unreachable")
        return try {
            withTimeoutOrNull(timeoutMs) { converse(socket, config, pcm) } ?: AssistOutcome.Failed("timeout")
        } finally {
            socket.close()
        }
    }

    /** Sign in and list the pipelines, for the settings screen. */
    suspend fun check(config: AssistConfig): AssistCheck {
        val socket = open(config) ?: return AssistCheck.Unreachable("unreachable")
        return try {
            withTimeoutOrNull(timeoutMs) {
                when (val auth = socket.signIn(config.token)) {
                    is SignIn.Ok -> {
                        socket.send(buildJsonObject { put("id", 1); put("type", "assist_pipeline/pipeline/list") })
                        val result = socket.next(1) ?: return@withTimeoutOrNull AssistCheck.Unreachable("closed")
                        val body = result["result"] as? JsonObject
                        if (result.bool("success") != true || body == null) {
                            return@withTimeoutOrNull AssistCheck.Unreachable(errorOf(result) ?: "no pipelines")
                        }
                        AssistCheck.Ok(
                            version = auth.version,
                            pipelines = (body["pipelines"]?.jsonArray ?: emptyList()).map {
                                val p = it.jsonObject
                                AssistPipeline(p.string("id") ?: "", p.string("name") ?: "", p.string("language"))
                            },
                            preferred = body.string("preferred_pipeline"),
                        )
                    }
                    SignIn.BadToken -> AssistCheck.BadToken
                    is SignIn.Broken -> AssistCheck.Unreachable(auth.reason)
                }
            } ?: AssistCheck.Unreachable("timeout")
        } finally {
            socket.close()
        }
    }

    private suspend fun converse(socket: Socket, config: AssistConfig, pcm: ShortArray): AssistOutcome {
        when (val auth = socket.signIn(config.token)) {
            is SignIn.Ok -> Unit
            SignIn.BadToken -> return AssistOutcome.Failed("bad token")
            is SignIn.Broken -> return AssistOutcome.Failed(auth.reason)
        }
        socket.send(
            buildJsonObject {
                put("id", RUN_ID)
                put("type", "assist_pipeline/run")
                put("start_stage", "stt")
                put("end_stage", "intent")
                putJsonObject("input") { put("sample_rate", SAMPLE_RATE_HZ) }
                config.pipelineId?.takeIf { it.isNotBlank() }?.let { put("pipeline", it) }
            },
        )
        var handler: Int? = null
        while (true) {
            val message = socket.next(RUN_ID) ?: return AssistOutcome.Failed("closed")
            when (message.string("type")) {
                "result" -> if (message.bool("success") != true) {
                    return AssistOutcome.Failed(errorOf(message) ?: "run refused")
                }
                "event" -> {
                    val event = message["event"] as? JsonObject ?: continue
                    val data = event["data"] as? JsonObject
                    when (event.string("type")) {
                        "run-start" -> {
                            val id = (data?.get("runner_data") as? JsonObject)?.get("stt_binary_handler_id")?.jsonPrimitive?.intOrNull
                                ?: return AssistOutcome.Failed("no audio handler")
                            if (handler == null) {
                                handler = id
                                socket.sendAudio(id, pcm)
                            }
                        }
                        "intent-end" -> return outcomeOf(data)
                        "error" -> return errorEvent(data)
                        "run-end" -> return AssistOutcome.Failed("ended without an answer")
                    }
                }
            }
        }
    }

    private fun outcomeOf(data: JsonObject?): AssistOutcome {
        val response = ((data?.get("intent_output") as? JsonObject)?.get("response")) as? JsonObject
            ?: return AssistOutcome.Failed("no response")
        val speech = (((response["speech"] as? JsonObject)?.get("plain")) as? JsonObject)?.string("speech")
        return when (response.string("response_type")) {
            "action_done", "query_answer" -> AssistOutcome.Done(speech)
            else -> AssistOutcome.NotUnderstood(
                ((response["data"] as? JsonObject)?.string("code")) ?: speech ?: "not understood",
            )
        }
    }

    private fun errorEvent(data: JsonObject?): AssistOutcome {
        val code = data?.string("code") ?: "error"
        return if (code in NOT_UNDERSTOOD_CODES) AssistOutcome.NotUnderstood(code) else AssistOutcome.Failed(code)
    }

    private fun errorOf(message: JsonObject): String? = (message["error"] as? JsonObject)?.let { it.string("code") ?: it.string("message") }

    private fun open(config: AssistConfig): Socket? {
        val url = webSocketUrl(config.baseUrl) ?: return null
        val socket = Socket()
        return try {
            socket.ws = http.newWebSocket(Request.Builder().url(url).build(), socket)
            socket
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "Home Assistant address is not usable: ${e.message}")
            null
        }
    }

    private sealed interface SignIn {
        data class Ok(val version: String?) : SignIn
        data object BadToken : SignIn
        data class Broken(val reason: String) : SignIn
    }

    /** One WebSocket, its incoming text messages queued for the coroutine that reads them. */
    private inner class Socket : WebSocketListener() {
        lateinit var ws: WebSocket
        private val incoming = Channel<JsonObject?>(Channel.UNLIMITED)

        override fun onMessage(webSocket: WebSocket, text: String) {
            val parsed = runCatching { json.parseToJsonElement(text) }.getOrNull()
            // Home Assistant may coalesce several messages into one JSON array.
            when (parsed) {
                is JsonObject -> incoming.trySend(parsed)
                is kotlinx.serialization.json.JsonArray -> parsed.forEach { (it as? JsonObject)?.let(incoming::trySend) }
                else -> Unit
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "Home Assistant connection failed: ${t.message}")
            incoming.trySend(null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            incoming.trySend(null)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            incoming.trySend(null)
        }

        suspend fun signIn(token: String): SignIn {
            val hello = incoming.receive() ?: return SignIn.Broken("unreachable")
            if (hello.string("type") != "auth_required") return SignIn.Broken("not Home Assistant")
            send(buildJsonObject { put("type", "auth"); put("access_token", token) })
            val answer = incoming.receive() ?: return SignIn.Broken("closed")
            return when (answer.string("type")) {
                "auth_ok" -> SignIn.Ok(answer.string("ha_version") ?: hello.string("ha_version"))
                "auth_invalid" -> SignIn.BadToken
                else -> SignIn.Broken("unexpected ${answer.string("type")}")
            }
        }

        /** The next message for request [id]; null once the socket closed. */
        suspend fun next(id: Int): JsonObject? {
            while (true) {
                val message = incoming.receive() ?: return null
                if (message["id"]?.jsonPrimitive?.intOrNull == id) return message
            }
        }

        fun send(message: JsonObject) {
            ws.send(message.toString())
        }

        /** The audio in tagged binary messages, then the handler id alone to end the stream. */
        fun sendAudio(handler: Int, pcm: ShortArray) {
            var at = 0
            while (at < pcm.size) {
                val n = minOf(AUDIO_MESSAGE_SAMPLES, pcm.size - at)
                val buffer = ByteBuffer.allocate(1 + n * 2).order(ByteOrder.LITTLE_ENDIAN)
                buffer.put(handler.toByte())
                for (i in at until at + n) buffer.putShort(pcm[i])
                ws.send(buffer.array().toByteString())
                at += n
            }
            ws.send(byteArrayOf(handler.toByte()).toByteString())
        }

        fun close() {
            runCatching { ws.close(1000, null) }
            incoming.close()
        }
    }

    companion object {
        private const val TAG = "Omnesis:Assist"
        private const val RUN_ID = 1
        const val SAMPLE_RATE_HZ = 16_000

        /** 100 ms of audio per message. */
        private const val AUDIO_MESSAGE_SAMPLES = 1_600

        /** Pipeline errors that mean "heard, but nothing to act on" rather than a broken run. */
        private val NOT_UNDERSTOOD_CODES = setOf("stt-no-text-recognized", "intent-not-supported", "no_intent_match")

        /** `http(s)://host:port[/]` → `ws(s)://host:port/api/websocket`; null when it is not an address. */
        fun webSocketUrl(baseUrl: String): String? {
            val trimmed = baseUrl.trim().trimEnd('/')
            val scheme = when {
                trimmed.startsWith("https://") -> "wss://"
                trimmed.startsWith("http://") -> "ws://"
                else -> return null
            }
            val rest = trimmed.substringAfter("://")
            if (rest.isEmpty()) return null
            return "$scheme$rest/api/websocket"
        }
    }
}

private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull()
