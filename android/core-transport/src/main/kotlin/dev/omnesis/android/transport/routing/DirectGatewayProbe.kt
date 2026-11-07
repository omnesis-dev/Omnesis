// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.routing

import kotlinx.coroutines.Dispatchers
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

    internal suspend fun reachable(route: DirectGatewayRoute, client: OkHttpClient,
                                   nanoTime: () -> Long, createSocket: () -> Socket): Boolean = withContext(Dispatchers.IO) {
        val deadline = nanoTime() + 5_000_000_000L
        for (target in route.endpoints) {
            currentCoroutineContext().ensureActive()
            val started = nanoTime()
            val remaining = ((deadline - started) / 1_000_000).coerceAtMost(750).toInt()
            if (remaining <= 0) return@withContext false
            val raw = createSocket()
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
                    if (connectivityFailure(error)) continue else return@withContext false
                }
                currentCoroutineContext().ensureActive()
                val tlsRemaining = remaining - ((nanoTime() - started) / 1_000_000).toInt()
                if (tlsRemaining <= 0) return@withContext false
                raw.soTimeout = tlsRemaining
                val tls = client.sslSocketFactory.createSocket(raw, route.host, route.port, true) as SSLSocket
                tls.use {
                    tls.soTimeout = tlsRemaining
                    tls.enabledProtocols = tls.supportedProtocols.filter { it == "TLSv1.2" || it == "TLSv1.3" }.toTypedArray()
                    tls.startHandshake()
                    currentCoroutineContext().ensureActive()
                    return@withContext nanoTime() < deadline && client.hostnameVerifier.verify(route.host, tls.session)
                }
            } catch (_: IOException) {
                // Once TLS begins a failed trust/hostname decision is terminal.
                return@withContext false
            } finally { watchdog.cancel(); runCatching { raw.close() } }
        }
        false
    }
}
