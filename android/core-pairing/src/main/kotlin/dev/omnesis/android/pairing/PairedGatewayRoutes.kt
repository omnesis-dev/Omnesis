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
    private val discover: suspend (Pairing) -> List<DirectGatewayCandidate>,
    private val onUpdated: (Pairing) -> Unit,
) {
    val http = PairedGatewayTransport.directRoute(expected)
    val streaming = PairedGatewayTransport.directRoute(expected)
    val socket = PairedGatewayTransport.directRoute(expected)
    private val lock = Any()
    private var retired = false

    suspend fun refresh(): Boolean {
        synchronized(lock) { if (retired) return false }
        val candidates = try { discover(expected) } catch (error: Exception) {
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
                    onUpdated(updated)
                }
            }
        }
    }

    fun retire(): Unit = synchronized(lock) {
        retired = true
        http?.retire()
        streaming?.retire()
        socket?.retire()
        Unit
    }
}
