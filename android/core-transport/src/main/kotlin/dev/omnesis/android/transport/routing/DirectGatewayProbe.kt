// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.routing

import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import java.io.IOException
import java.net.Socket
import javax.net.ssl.SSLSocket

interface DirectGatewayProbing {
    suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient): Boolean
}

/** Complete strict TLS authentication with canonical SNI before proposing a
 * connection migration. No HTTP bytes, credentials or application body are sent. */
object DirectGatewayProbe : DirectGatewayProbing {
    override suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient): Boolean =
        reachable(route, client, System::nanoTime, ::Socket)

    /** Blocking socket selection uses the same bounded, pinned handshake as promotion. */
    internal fun verifyCandidate(route: DirectGatewayRoute, client: OkHttpClient,
                                 target: java.net.InetSocketAddress, timeout: Int): Boolean = runBlocking {
        probeInline(route.candidateRoute(target), client, System::nanoTime, ::Socket, timeout, activeRoute = route)
    }

    internal suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient,
                                   nanoTime: () -> Long, createSocket: () -> Socket, attemptTimeoutMs: Int = 750): Boolean = withContext(Dispatchers.IO) {
        probeInline(route, client, nanoTime, createSocket, attemptTimeoutMs)
    }

    private suspend fun probeInline(route: DirectGatewayRoute, client: OkHttpClient,
                                    nanoTime: () -> Long, createSocket: () -> Socket, attemptTimeoutMs: Int, activeRoute: DirectGatewayRoute = route): Boolean = coroutineScope {
        val deadline = nanoTime() + 5_000_000_000L
        for (target in route.endpoints) {
            currentCoroutineContext().ensureActive()
            try { activeRoute.ensureActive() } catch (_: java.net.SocketException) { return@coroutineScope false }
            val started = nanoTime()
            val remaining = ((deadline - started) / 1_000_000).coerceAtMost(attemptTimeoutMs.toLong()).toInt()
            if (remaining <= 0) return@coroutineScope false
            val attemptDeadline = started + remaining * 1_000_000L
            val raw = createSocket()
            try { activeRoute.track(raw) }
            catch (_: IllegalStateException) { runCatching { raw.close() }; return@coroutineScope false }
            // An absolute watchdog closes blocking JSSE reads even when a peer
            // dribbles bytes often enough to reset SO_TIMEOUT. Parent cancellation
            // cancels this structured child and therefore closes the socket too.
            val watchdog = launch(Dispatchers.Default, start = CoroutineStart.UNDISPATCHED) {
                try { delay(remaining.toLong()) }
                finally { runCatching { raw.close() } }
            }
            try {
                try { raw.connect(target, remaining) }
                catch (error: IOException) {
                    if (connectivityFailure(error)) continue else return@coroutineScope false
                }
                currentCoroutineContext().ensureActive()
                val tlsRemaining = remaining - ((nanoTime() - started) / 1_000_000).toInt()
                if (tlsRemaining <= 0) return@coroutineScope false
                raw.soTimeout = tlsRemaining
                val tls = client.sslSocketFactory.createSocket(raw, route.host, route.port, true) as SSLSocket
                val authenticated = tls.use {
                    tls.soTimeout = tlsRemaining
                    tls.enabledProtocols = tls.supportedProtocols.filter { it == "TLSv1.2" || it == "TLSv1.3" }.toTypedArray()
                    tls.startHandshake()
                    currentCoroutineContext().ensureActive()
                    nanoTime() < deadline && client.hostnameVerifier.verify(route.host, tls.session)
                }
                activeRoute.ensureActive()
                if (authenticated && nanoTime() < attemptDeadline) return@coroutineScope true
            } catch (_: IOException) {
                // A rejected hint cannot authenticate, but another hint may prove the same identity.
            } finally { watchdog.cancel(); activeRoute.release(raw); runCatching { raw.close() } }
        }
        false
    }
}
