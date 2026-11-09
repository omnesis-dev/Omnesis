// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import dev.omnesis.android.transport.routing.DirectGatewayRoute
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

/** Independent stream owners share authority and hints, never their live sockets. */
class PairedGatewayRoutes(
    private val expected: Pairing,
    private val service: PairingService,
    /**
     * Asks the gateway for its home-network addresses. The route is this pairing's own, so the
     * question goes over the home network when the gateway is there and over the relay otherwise.
     */
    private val discover: suspend (Pairing, DirectGatewayRoute?) -> List<DirectGatewayCandidate>,
    private val onUpdated: (Pairing) -> Unit,
) {
    val http = PairedGatewayTransport.directRoute(expected)
    val streaming = PairedGatewayTransport.directRoute(expected)
    val socket = PairedGatewayTransport.directRoute(expected)
    private val discovery = PairedGatewayTransport.directRoute(expected)
    private val all get() = listOfNotNull(http, streaming, socket, discovery)
    private val lock = Any()
    private var retired = false

    suspend fun refresh(): Boolean {
        synchronized(lock) { if (retired) return false }
        val candidates = try { discover(expected, discovery) } catch (error: Exception) {
            currentCoroutineContext().ensureActive()
            if (GatewayDirectCandidateDiscovery.isTemporary(error)) return false
            throw error
        }
        currentCoroutineContext().ensureActive()
        return service.updateDirectCandidates(expected, candidates) { updated ->
            synchronized(lock) {
                if (!retired) {
                    http?.updateCandidates(candidates)
                    streaming?.updateCandidates(candidates)
                    socket?.updateCandidates(candidates)
                    discovery?.updateCandidates(candidates)
                    onUpdated(updated)
                }
            }
        }
    }

    /**
     * The network changed, or a check reached the gateway at home: every client tries the
     * home-network addresses first on its next connection instead of remembering it was away.
     */
    fun hintsMayBeReachable() = all.forEach { it.hintsMayBeReachable() }

    fun retire(): Unit = synchronized(lock) {
        retired = true
        discovery?.retire()
        http?.retire()
        streaming?.retire()
        socket?.retire()
        Unit
    }
}
