// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.tls.PinnedOkHttp
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URI
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A single fixed-origin request. Redirects and cookies cannot carry pairing credentials elsewhere. */
interface CloudPairingTransport : AutoCloseable {
    suspend fun request(url: String, body: String? = null, bearer: String? = null): String
}

class CloudPairingHTTP(fingerprint: String? = null, spkiFingerprint: String? = null,
                       canonicalHost: String? = null, timeoutMillis: Long = 15_000) : CloudPairingTransport {
    private val lifecycle = Any()
    private var closed = false
    private val client = PinnedOkHttp.build(fingerprint, requirePin = fingerprint != null || spkiFingerprint != null,
        host = canonicalHost, spkiFingerprint = spkiFingerprint,
        requireCertificateValidity = fingerprint != null || spkiFingerprint != null).newBuilder()
        .followRedirects(false).followSslRedirects(false).cookieJar(CookieJar.NO_COOKIES)
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
                            if (!it.isSuccessful) throw CloudPairingException(it.code)
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
            client.dispatcher.cancelAll(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown()
        }
    }
}

/** Provisional transport pins the compared candidate's exact certificate until enrollment completes. */
internal fun provisionalGatewayTransport(fingerprint: String): CloudPairingTransport = CloudPairingHTTP(fingerprint)

/** Google authenticates the requester; the independent code comparison authenticates the gateway pin. */
class GoogleCloudPairingClient(private val relayOrigin: String, private val clientId: String,
                              private val direct: CloudPairingTransport = CloudPairingHTTP(),
                              private val createGateway: (String) -> CloudPairingTransport = ::provisionalGatewayTransport,
                              private val now: () -> Long = { System.currentTimeMillis() / 1000 },
                              private val presenterClientIds: Set<String> = setOf(clientId)) : AutoCloseable {
    private val json = Json { ignoreUnknownKeys = true }
    private var gateway: CloudPairingTransport? = null
    private var active: CloudPairingConfirmation? = null
    private val closed = AtomicBoolean(false)
    private val started = AtomicBoolean(false)
    private val lifecycle = Any()
    init {
        val uri = URI(relayOrigin)
        require(uri.scheme == "https" && uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path in listOf("", "/"))
        require(clientId.endsWith(".apps.googleusercontent.com"))
    }

    suspend fun start(challenge: CloudPairingChallenge, idToken: String): CloudPairingConfirmation {
        checkOpen()
        if (!started.compareAndSet(false, true)) throw CloudPairingException()
        val jwks = direct.request("https://www.googleapis.com/oauth2/v3/certs")
        checkOpen()
        val owner = GoogleIdentityVerifier(jwks, setOf(clientId), presenterClientIds).verify(idToken, challenge.nonce, now())
        val session = json.parseToJsonElement(direct.request("${relayOrigin.trimEnd('/')}/_relay/v1/login",
            buildJsonObject { put("idToken", idToken) }.toString())).jsonObject
        checkOpen()
        if ((session["accountId"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull != owner.accountId) throw CloudPairingException()
        val token = (session["token"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: throw CloudPairingException()
        if (token.isEmpty() || token.length > 4096) throw CloudPairingException()
        val candidate = json.decodeFromString<GoogleGatewayBinding>(direct.request("${relayOrigin.trimEnd('/')}/_relay/v2/gateway", bearer = token))
        checkOpen()
        val pending = CloudPairingConfirmation(challenge, candidate, now() * 1000)
        val pinned = createGateway(pending.fingerprint)
        val registered = synchronized(lifecycle) {
            if (closed.get()) false else { gateway = pinned; true }
        }
        if (!registered) { pinned.close(); throw CloudPairingException() }
        val request = json.encodeToJsonElement(challenge).jsonObject.toMutableMap().apply { put("identityToken", JsonPrimitive(idToken)) }
        val status = json.decodeFromString<CloudPairingProgress>(pinned.request("${pending.origin}/devices/google/request", JsonObject(request).toString()))
        checkOpen()
        pending.receive(status, now() * 1000)
        synchronized(lifecycle) { checkOpen(); active = pending }
        return pending
    }

    suspend fun poll(pending: CloudPairingConfirmation) {
        val pinned = synchronized(lifecycle) {
            checkOpen()
            if (pending !== active) throw CloudPairingException()
            // The active confirmation and gateway are cleared together under this same lock.
            gateway!!
        }
        val body = buildJsonObject { put("requestId", pending.challenge.requestId); put("secret", pending.challenge.secret) }.toString()
        val data = pinned.request("${pending.origin}/devices/google/poll", body)
        checkOpen()
        pending.receive(json.decodeFromString<CloudPairingProgress>(data), now() * 1000)
    }

    override fun close() {
        val previous = synchronized(lifecycle) {
            if (!closed.compareAndSet(false, true)) return
            active = null
            gateway.also { gateway = null }
        }
        previous?.close(); direct.close()
    }
    private fun checkOpen() { if (closed.get()) throw CloudPairingException() }
}
