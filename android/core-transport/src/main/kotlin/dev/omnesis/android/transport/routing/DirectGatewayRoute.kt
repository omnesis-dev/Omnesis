// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.routing

import kotlinx.serialization.Serializable
import okhttp3.Dns
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import java.io.IOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Proxy
import java.net.Socket
import java.net.SocketAddress
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.SocketFactory

/** Untrusted until received over the already paired, pinned gateway channel. No URL or TLS policy is carried here. */
@Serializable
data class DirectGatewayCandidate(val address: String, val port: Int) {
    fun validatedAddress(allowLoopback: Boolean = false): InetAddress {
        require(port in 1..65535 && address.length in 3..45)
        val literal = if (address.contains(':')) {
            require(address.matches(Regex("^[0-9a-fA-F:]+$")))
            InetAddress.getByName(address).also { require(it.address.size == 16) }
        } else {
            val parts = address.split('.')
            require(parts.size == 4 && parts.all { it.matches(Regex("^(0|[1-9][0-9]{0,2})$")) && it.toInt() <= 255 })
            InetAddress.getByAddress(parts.map { it.toInt().toByte() }.toByteArray())
        }
        val bytes = literal.address
        val privateAddress = if (bytes.size == 4) {
            val first = bytes[0].toInt() and 255
            val second = bytes[1].toInt() and 255
            first == 10 || first == 172 && second in 16..31 || first == 192 && second == 168
        } else {
            (bytes[0].toInt() and 254) == 252
        }
        require(privateAddress || allowLoopback && literal.isLoopbackAddress)
        return literal
    }
}

enum class GatewayConnectionPath { LOCAL, RELAY, RECONNECTING }

/** Scoped to one gateway identity. Routing never changes URL, Host, TLS SNI, certificates or tokens. */
class DirectGatewayRoute private constructor(
    private val origin: String,
    val host: String,
    val port: Int,
    initialEndpoints: List<InetSocketAddress>,
) {
    private val lock = Any()
    private var currentEndpoints = initialEndpoints
    private var retired = false
    private val sockets = mutableSetOf<Socket>()
    private val selectedPath = kotlinx.coroutines.flow.MutableStateFlow(GatewayConnectionPath.RECONNECTING)
    val connectionPath: kotlinx.coroutines.flow.StateFlow<GatewayConnectionPath> = selectedPath
    internal val endpoints: List<InetSocketAddress> get() = synchronized(lock) { currentEndpoints }

    internal fun connected(target: InetSocketAddress, candidates: List<InetSocketAddress> = endpoints) {
        synchronized(lock) {
            if (!retired) selectedPath.value = if (target in candidates) GatewayConnectionPath.LOCAL else GatewayConnectionPath.RELAY
        }
    }
    internal fun track(socket: Socket): List<InetSocketAddress> = synchronized(lock) {
        check(!retired) { "gateway route is retired" }
        sockets += socket
        currentEndpoints
    }
    internal fun release(socket: Socket) { synchronized(lock) { sockets -= socket } }

    fun updateCandidates(candidates: List<DirectGatewayCandidate>) {
        val validated = maintained(origin, candidates).endpoints
        synchronized(lock) {
            check(!retired) { "gateway route is retired" }
            currentEndpoints = validated
        }
    }

    fun retire() {
        val previous = synchronized(lock) {
            retired = true
            selectedPath.value = GatewayConnectionPath.RECONNECTING
            sockets.toList().also { sockets.clear() }
        }
        previous.forEach { runCatching { it.close() } }
    }

    companion object {
        fun create(origin: String, candidates: List<DirectGatewayCandidate>): DirectGatewayRoute? =
            createValidated(origin, candidates, false)

        fun maintained(origin: String, candidates: List<DirectGatewayCandidate>): DirectGatewayRoute {
            val url = origin.toHttpUrl()
            require(url.host.contains('.') && !url.host.matches(Regex("^[0-9.]+$")) &&
                url.host.length <= 253 && url.host.split('.').all { Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$").matches(it) })
            return validated(origin, candidates, false)
        }

        internal fun createValidated(origin: String, candidates: List<DirectGatewayCandidate>, allowLoopback: Boolean): DirectGatewayRoute? {
            if (candidates.isEmpty()) return null
            return validated(origin, candidates, allowLoopback)
        }

        private fun validated(origin: String, candidates: List<DirectGatewayCandidate>, allowLoopback: Boolean): DirectGatewayRoute {
            require(candidates.size <= 8 && candidates.distinct().size == candidates.size)
            val url = origin.toHttpUrl()
            require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null)
            return DirectGatewayRoute(origin, url.host, url.port, candidates.map { InetSocketAddress(it.validatedAddress(allowLoopback), it.port) })
        }
    }

    internal fun install(builder: OkHttpClient.Builder): OkHttpClient.Builder {
        val factory = DirectGatewaySocketFactory(this)
        return builder.socketFactory(factory).dns(factory.dns).proxy(Proxy.NO_PROXY).retryOnConnectionFailure(false)
    }
}

/** TCP-only probes choose the route before the actual TLS connection; TLS failures cannot retry another route. */
internal class DirectGatewaySocketFactory(
    private val route: DirectGatewayRoute,
    private val probe: (InetSocketAddress, Int) -> Unit = ::probeTcp,
    private val resolve: (String) -> List<InetAddress> = Dns.SYSTEM::lookup,
) : SocketFactory() {
    val dns: Dns = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = if (hostname.equals(route.host, ignoreCase = true)) {
            // Preserve the canonical hostname without requiring relay DNS when LAN is reachable.
            val first = route.endpoints.firstOrNull()
            // Every candidate is constructed from a validated InetAddress and
            // therefore resolved; only an intentionally empty hint set uses a placeholder.
            val bytes = if (first == null) byteArrayOf(0, 0, 0, 0) else first.address.address
            listOf(InetAddress.getByAddress(route.host, bytes))
        } else throw UnknownHostException("gateway route is bound to ${route.host}")
    }

    internal fun select(timeout: Int, candidates: List<InetSocketAddress> = route.endpoints): InetSocketAddress {
        val budget = if (timeout <= 0) 150 else minOf(timeout, 150)
        for (target in candidates) {
            try { probe(target, budget); return target }
            catch (error: IOException) { if (!connectivityFailure(error)) throw error }
        }
        val relay = resolve(route.host).take(4)
        for (address in relay) {
            val target = InetSocketAddress(address, route.port)
            try { probe(target, budget); return target }
            catch (error: IOException) { if (!connectivityFailure(error)) throw error }
        }
        throw NoRouteToHostException(route.host)
    }

    private inner class RoutedSocket : Socket() {
        override fun connect(endpoint: SocketAddress?, timeout: Int) {
            try {
                val candidates = route.track(this)
                val target = endpoint as? InetSocketAddress
                val sameHost = target != null && (target.hostString.equals(route.host, ignoreCase = true) ||
                    route.host.contains(':') && !target.isUnresolved && target.address.address.contentEquals(InetAddress.getByName(route.host).address))
                if (sameHost && target!!.port == route.port) {
                    val selected = select(timeout, candidates)
                    super.connect(selected, if (timeout <= 0) 15_000 else timeout)
                    route.connected(selected, candidates)
                } else throw javax.net.ssl.SSLPeerUnverifiedException("gateway route is bound to its canonical origin")
            } catch (error: Exception) { close(); throw error }
        }
        override fun close() { route.release(this); super.close() }
    }

    override fun createSocket(): Socket = RoutedSocket()
    override fun createSocket(host: String, port: Int): Socket = createSocket().apply { connect(InetSocketAddress.createUnresolved(host, port)) }
    override fun createSocket(host: InetAddress, port: Int): Socket = createSocket().apply { connect(InetSocketAddress(host, port)) }
    override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket = createSocket().apply {
        bind(InetSocketAddress(localHost, localPort)); connect(InetSocketAddress.createUnresolved(host, port))
    }
    override fun createSocket(host: InetAddress, port: Int, localHost: InetAddress, localPort: Int): Socket = createSocket().apply {
        bind(InetSocketAddress(localHost, localPort)); connect(InetSocketAddress(host, port))
    }
}

private fun probeTcp(address: InetSocketAddress, timeout: Int) { Socket().use { it.connect(address, timeout) } }
internal fun connectivityFailure(error: IOException): Boolean =
    error is ConnectException || error is SocketTimeoutException || error is NoRouteToHostException || error is UnknownHostException || error is SocketException
