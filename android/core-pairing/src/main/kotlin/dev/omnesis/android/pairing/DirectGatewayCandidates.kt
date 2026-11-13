// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import dev.omnesis.android.transport.routing.DirectGatewayRoute
import kotlinx.serialization.Serializable
import java.net.URI
import java.net.SocketException
import java.net.UnknownHostException
import java.io.InterruptedIOException

@Serializable
private data class DirectCandidatesReply(val version: Int, val candidates: List<DirectGatewayCandidate>)

/** Called only after the key-pinned pairing exchange has issued this device's own bearer. */
internal suspend fun fetchPairedDirectCandidates(origin: String, token: String, spki: String): List<DirectGatewayCandidate> =
    fetchPairedDirectCandidates(origin, token, spki, route = null)

/**
 * With a [route] the saved home-network addresses are tried first and the relay after them, as
 * for every other request of the pairing, so the hints stay current at home while remote access
 * is off. The pinned key is required on either path; only the time allowed differs, because the
 * hints are each given their moment before the relay is dialed.
 */
internal suspend fun fetchPairedDirectCandidates(origin: String, token: String, spki: String, route: DirectGatewayRoute?): List<DirectGatewayCandidate> {
    val transport = CloudPairingHTTP(spkiFingerprint = spki, canonicalHost = URI(origin).host,
        timeoutMillis = if (route == null) 2500 else ROUTED_DISCOVERY_TIMEOUT_MILLIS, directRoute = route)
    return try {
        val data = transport.request("${origin.trimEnd('/')}/devices/direct-candidates", bearer = token)
        validatedDirectCandidates(origin, data)
    } finally { transport.close() }
}

internal fun validatedDirectCandidates(origin: String, data: String): List<DirectGatewayCandidate> {
    val reply = OmnesisJson.decodeFromString<DirectCandidatesReply>(data)
    require(reply.version == 1)
    DirectGatewayRoute.create(origin, reply.candidates)
    return reply.candidates
}

/** The hints' own five seconds, then the relay's connect and the answer. */
private const val ROUTED_DISCOVERY_TIMEOUT_MILLIS = 12_000L

/** Optional hints never weaken the independently approved credential or its TLS policy. */
internal fun isTemporaryDirectDiscoveryFailure(error: Exception): Boolean = when (error) {
    is CloudPairingException -> when (error.statusCode) {
        404, 429, in 500..599 -> true
        else -> false
    }
    is SocketException, is UnknownHostException, is InterruptedIOException -> true
    else -> false
}

internal suspend fun optionalDirectCandidates(fetch: suspend () -> List<DirectGatewayCandidate>): List<DirectGatewayCandidate> =
    try { fetch() }
    catch (error: Exception) {
        if (isTemporaryDirectDiscoveryFailure(error)) emptyList() else throw error
    }

/** App-facing refresh port: its authority comes only from the saved strict gateway key pairing. */
object GatewayDirectCandidateDiscovery {
    /** [route] defaults to the pairing's saved home-network addresses; the caller's own keeps what it learned. */
    suspend fun fetch(pairing: Pairing, route: DirectGatewayRoute? = PairedGatewayTransport.directRoute(pairing)): List<DirectGatewayCandidate> {
        require(pairing.tlsMode == PairingTlsMode.PINNED_KEY_STRICT)
        val spki = pairing.spkiFingerprint.orEmpty()
        PairingPayload.requireValidFingerprint(spki)
        return fetchPairedDirectCandidates(pairing.url, pairing.token, spki, route)
    }

    fun isTemporary(error: Exception): Boolean = isTemporaryDirectDiscoveryFailure(error)
}
