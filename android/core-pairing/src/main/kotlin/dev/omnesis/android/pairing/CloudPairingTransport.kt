// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.routing.DirectGatewayRoute
import dev.omnesis.android.transport.tls.PinnedOkHttp
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URI
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A single fixed-origin request. Redirects and cookies cannot carry pairing credentials elsewhere. */
interface CloudPairingTransport : AutoCloseable {
    suspend fun request(url: String, body: String? = null, bearer: String? = null): String
    /** The chain the peer presented on the latest response, for checks beyond the pin. */
    val peerCertificates: List<X509Certificate> get() = emptyList()
}

class CloudPairingHTTP(fingerprint: String? = null, spkiFingerprint: String? = null,
                       canonicalHost: String? = null, timeoutMillis: Long = 15_000,
                       /** A paired gateway's own route: its home-network addresses first, under the same strict key pin. */
                       directRoute: DirectGatewayRoute? = null) : CloudPairingTransport {
    private val lifecycle = Any()
    private var closed = false
    @Volatile override var peerCertificates: List<X509Certificate> = emptyList()
        private set
    private val client = PinnedOkHttp.build(fingerprint, requirePin = fingerprint != null || spkiFingerprint != null,
        host = canonicalHost, spkiFingerprint = spkiFingerprint,
        requireCertificateValidity = fingerprint != null || spkiFingerprint != null, directRoute = directRoute).newBuilder()
        .followRedirects(false).followSslRedirects(false).cookieJar(CookieJar.NO_COOKIES)
        // OkHttp's Handshake.peerCertificates is empty behind a custom trust manager: its chain
        // cleaner finds no trusted root and drops the chain. Read the presented chain from the session.
        .addNetworkInterceptor { chain ->
            (chain.connection()?.socket() as? javax.net.ssl.SSLSocket)?.session?.let { session ->
                peerCertificates = runCatching { session.peerCertificates.filterIsInstance<X509Certificate>() }.getOrDefault(emptyList())
            }
            chain.proceed(chain.request())
        }
        .callTimeout(timeoutMillis, TimeUnit.MILLISECONDS).build()

    override suspend fun request(url: String, body: String?, bearer: String?): String {
        val uri = URI(url)
        if (uri.scheme != "https" || uri.userInfo != null || uri.fragment != null) throw CloudPairingException()
        val request = Request.Builder().url(url).header("Accept", "application/json").apply {
            if (body != null) post(body.toRequestBody("application/json".toMediaType()))
            if (bearer != null) header("Authorization", "Bearer $bearer")
        }.build()
        return suspendCancellableCoroutine { continuation ->
            val call = client.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            val callback = object : Callback {
                override fun onFailure(call: Call, error: IOException) { continuation.resumeWithException(error) }
                override fun onResponse(call: Call, response: Response) {
                    try {
                        val data = response.use {
                            // OkHttp guarantees a body for Callback.onResponse (including an empty one).
                            val source = it.body!!
                            if (!it.isSuccessful) throw CloudPairingException(it.code, if (it.code == 403) cloudRefusalReason(source.source()) else null)
                            if (source.contentLength() > 65_536) throw CloudPairingException()
                            val bytes = okio.Buffer()
                            while (source.source().read(bytes, minOf(8192L, 65_537L - bytes.size)) != -1L) {
                                if (bytes.size > 65_536) throw CloudPairingException()
                            }
                            bytes.readUtf8()
                        }
                        continuation.resume(data)
                    } catch (error: Exception) { continuation.resumeWithException(error) }
                }
            }
            synchronized(lifecycle) {
                if (closed) continuation.resumeWithException(CloudPairingException())
                else call.enqueue(callback)
            }
        }
    }
    override fun close() {
        synchronized(lifecycle) {
            if (closed) return
            closed = true
            client.dispatcher.cancelAll()
            // Closing a TLS connection writes to the network, which Android refuses on the main
            // thread, and this is called from there when a sign-in ends.
            val pool = client.connectionPool; val executor = client.dispatcher.executorService
            Thread({ pool.evictAll(); executor.shutdown() }, "omnesis-pairing-close").apply { isDaemon = true }.start()
        }
    }
}

/**
 * The `error` a refusal names in its JSON body, such as `no-account`. Refusals are short, so a body
 * past [REFUSAL_BODY_LIMIT] bytes, or one that is not such an object, names nothing.
 */
internal fun cloudRefusalReason(body: okio.BufferedSource): String? = runCatching {
    if (body.request(REFUSAL_BODY_LIMIT + 1)) return null
    val error = (Json.parseToJsonElement(body.readUtf8()) as? JsonObject)?.get("error") as? JsonPrimitive
    error?.takeIf { it.isString }?.content
}.getOrNull()
private const val REFUSAL_BODY_LIMIT = 256L

/** Provisional transport pins the compared candidate's exact certificate until enrollment completes. */
internal fun provisionalGatewayTransport(fingerprint: String): CloudPairingTransport = CloudPairingHTTP(fingerprint)
