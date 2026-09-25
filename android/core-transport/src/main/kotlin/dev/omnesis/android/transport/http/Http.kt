// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.http

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

@PublishedApi
internal val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

/** Suspends until the OkHttp call completes; cancels the call on coroutine cancellation. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response)
        override fun onFailure(call: Call, e: IOException) {
            if (cont.isActive) cont.resumeWithException(e)
        }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}

/**
 * Minimal HTTP engine bound to one paired gateway: a single [OkHttpClient] (pinned
 * or not), a base URL, and an optional bearer token. Mirrors the iOS clients'
 * `dispatch` helper — it owns auth-header injection and uniform error mapping so
 * every typed client maps failures to [GatewayException] identically.
 */
class GatewayHttp(
    val client: OkHttpClient,
    val baseUrl: HttpUrl,
    val token: String?,
    val pairingGeneration: String? = null,
) {
    constructor(
        client: OkHttpClient,
        baseUrl: String,
        token: String?,
        pairingGeneration: String? = null,
    ) : this(
        client,
        requireNotNull(baseUrl.toHttpUrlOrNull()) { "invalid gateway URL: $baseUrl" },
        token,
        pairingGeneration,
    )

    fun urlFor(path: String, query: Map<String, String> = emptyMap()): HttpUrl {
        return urlForSegments(path.trim('/').split('/').filter { it.isNotEmpty() }, query)
    }

    /** Builds a URL from already-separated raw path segments, encoding each segment exactly once. */
    fun urlForSegments(segments: List<String>, query: Map<String, String> = emptyMap()): HttpUrl {
        val builder = baseUrl.newBuilder()
        segments.forEach { builder.addPathSegment(it) }
        query.forEach { (k, v) -> builder.addQueryParameter(k, v) }
        return builder.build()
    }

    fun newRequest(url: HttpUrl): Request.Builder {
        val b = Request.Builder().url(url).header("Accept", "application/json")
        token?.let { b.header("Authorization", "Bearer $it") }
        pairingGeneration?.let { b.header("Omnesis-Pairing-Generation", it) }
        return b
    }

    /** Executes a request, returning the body string on 2xx or throwing a typed error. */
    suspend fun execute(request: Request): String {
        val response = try {
            client.newCall(request).await()
        } catch (e: IOException) {
            throw GatewayException.Network(e)
        }
        // Reading the response body is blocking I/O; the call resumes on the
        // caller's dispatcher (often Main), so move the read to IO to avoid
        // NetworkOnMainThreadException.
        return withContext(Dispatchers.IO) {
            response.use {
                val body = it.body?.string().orEmpty()
                if (it.isSuccessful) {
                    body
                } else {
                    val envelope = parseErrorEnvelope(body)
                    throw when (it.code) {
                        401 -> GatewayException.Unauthorized()
                        403 -> GatewayException.Forbidden()
                        404 -> GatewayException.NotFound(envelope?.message)
                        else ->
                            GatewayException.ServerError(
                                it.code,
                                envelope?.message ?: body,
                                envelope?.code,
                            )
                    }
                }
            }
        }
    }
}

/** The two halves of the gateway's error envelope that callers act on. */
private class ErrorEnvelope(val message: String, val code: String?)

/**
 * Read `{ "error": …, "code": … }` out of an error response, or null when the
 * body is not that envelope — a proxy's HTML, a truncated read, an empty body.
 * A null result leaves the raw body in place: no less useful than before, and
 * never mistaken for a message the gateway wrote.
 */
private fun parseErrorEnvelope(body: String): ErrorEnvelope? =
    runCatching {
        val obj = OmnesisJson.parseToJsonElement(body).jsonObject
        val message = obj["error"]?.jsonPrimitive?.content?.trim()
        if (message.isNullOrEmpty()) return@runCatching null
        ErrorEnvelope(message, obj["code"]?.jsonPrimitive?.content?.takeIf { it.isNotBlank() })
    }.getOrNull()

/** Decodes a JSON body into [T], wrapping failures as [GatewayException.Decoding]. */
inline fun <reified T> decodeBody(body: String): T =
    try {
        OmnesisJson.decodeFromString<T>(body)
    } catch (e: Exception) {
        throw GatewayException.Decoding("failed to decode ${T::class.simpleName}", e)
    }

suspend inline fun <reified T> GatewayHttp.getJson(
    path: String,
    query: Map<String, String> = emptyMap(),
): T = decodeBody(execute(newRequest(urlFor(path, query)).get().build()))

/** GET whose dynamic values remain one encoded path segment and whose response must not be cached. */
suspend inline fun <reified T> GatewayHttp.getPrivateJson(
    segments: List<String>,
    query: Map<String, String> = emptyMap(),
): T = decodeBody(
    execute(
        newRequest(urlForSegments(segments, query))
            .header("Cache-Control", "no-store")
            .get()
            .build(),
    ),
)

/** GET returning the raw 2xx body string (for free-form payloads with no fixed schema). */
suspend fun GatewayHttp.getRaw(path: String, query: Map<String, String> = emptyMap()): String =
    execute(newRequest(urlFor(path, query)).get().build())

suspend inline fun <reified B, reified T> GatewayHttp.postJson(path: String, body: B): T {
    val payload = OmnesisJson.encodeToString(body).toRequestBody(JSON_MEDIA)
    return decodeBody(execute(newRequest(urlFor(path)).post(payload).build()))
}

/** JSON POST with query parameters encoded separately from the path. */
suspend inline fun <reified B, reified T> GatewayHttp.postJson(
    path: String,
    query: Map<String, String>,
    body: B,
): T {
    val payload = OmnesisJson.encodeToString(body).toRequestBody(JSON_MEDIA)
    return decodeBody(execute(newRequest(urlFor(path, query)).post(payload).build()))
}

/** JSON POST with dynamic raw path segments encoded exactly once. */
suspend inline fun <reified B, reified T> GatewayHttp.postJsonSegments(
    segments: List<String>,
    body: B,
): T {
    val payload = OmnesisJson.encodeToString(body).toRequestBody(JSON_MEDIA)
    return decodeBody(execute(newRequest(urlForSegments(segments)).post(payload).build()))
}

/** POST with an empty `{}` body (matches the iOS source-action calls); discards the response. */
suspend fun GatewayHttp.post(path: String) {
    execute(newRequest(urlFor(path)).post("{}".toRequestBody(JSON_MEDIA)).build())
}

/** JSON POST with a static path, discarding the response. */
suspend inline fun <reified B> GatewayHttp.postJsonDiscarding(path: String, body: B) {
    val payload = OmnesisJson.encodeToString(body).toRequestBody(JSON_MEDIA)
    execute(newRequest(urlFor(path)).post(payload).build())
}

/** POST with an empty `{}` body, decoding the response into [T]. */
suspend inline fun <reified T> GatewayHttp.postEmpty(path: String): T =
    decodeBody(execute(newRequest(urlFor(path)).post("{}".toRequestBody(JSON_MEDIA)).build()))

/**
 * Empty-body POST with dynamic raw path segments, discarding the response.
 *
 * For routes that answer 2xx with nothing meaningful — a decode into a typed shape would
 * fail on an empty body and there is nothing to read anyway.
 */
suspend fun GatewayHttp.postSegments(segments: List<String>) {
    execute(newRequest(urlForSegments(segments)).post("{}".toRequestBody(JSON_MEDIA)).build())
}

/** JSON POST with dynamic raw path segments, discarding the response. */
suspend inline fun <reified B> GatewayHttp.postJsonSegmentsDiscarding(
    segments: List<String>,
    body: B,
) {
    val payload = OmnesisJson.encodeToString(body).toRequestBody(JSON_MEDIA)
    execute(newRequest(urlForSegments(segments)).post(payload).build())
}

/** Empty-body POST with dynamic raw path segments encoded exactly once. */
suspend inline fun <reified T> GatewayHttp.postEmptySegments(segments: List<String>): T =
    decodeBody(
        execute(
            newRequest(urlForSegments(segments))
                .post("{}".toRequestBody(JSON_MEDIA))
                .build(),
        ),
    )

suspend inline fun <reified B, reified T> GatewayHttp.patchJson(path: String, body: B): T {
    val payload = OmnesisJson.encodeToString(body).toRequestBody(JSON_MEDIA)
    return decodeBody(execute(newRequest(urlFor(path)).patch(payload).build()))
}

suspend inline fun <reified B, reified T> GatewayHttp.putJson(path: String, body: B): T {
    val payload = OmnesisJson.encodeToString(body).toRequestBody(JSON_MEDIA)
    return decodeBody(execute(newRequest(urlFor(path)).put(payload).build()))
}

/** DELETE; discards the `{ok:true}` response. */
suspend fun GatewayHttp.delete(path: String, query: Map<String, String> = emptyMap()) {
    execute(newRequest(urlFor(path, query)).delete().build())
}

/** DELETE with dynamic raw path segments encoded exactly once. */
suspend fun GatewayHttp.deleteSegments(segments: List<String>) {
    execute(newRequest(urlForSegments(segments)).delete().build())
}

/** DELETE, decoding the response into [T]. */
suspend inline fun <reified T> GatewayHttp.deleteJson(path: String): T =
    decodeBody(execute(newRequest(urlFor(path)).delete().build()))
