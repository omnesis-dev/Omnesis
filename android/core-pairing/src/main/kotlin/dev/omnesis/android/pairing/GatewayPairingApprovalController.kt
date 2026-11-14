// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.GatewayPairingApproving
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The existing paired admin channel supplies the owner-side SAS. Comparison
 * is local and binds the exact request/code, never a relay approval flag.
 *
 * With [passkey], a request can also be approved with a passkey the owner confirmed on the
 * gateway: the gateway issues a ceremony for exactly that request, device key and code, over
 * the pinned connection, and this app signs it with its own origin. */
class GatewayPairingApprovalController(
    private val now: () -> Long = System::currentTimeMillis,
    private val passkey: GatewayPasskeySigner? = null,
) {
    data class State(
        val requests: List<GatewayPairingApprovalRequest> = emptyList(),
        val compared: Map<String, String> = emptyMap(),
        /** Requests whose verified sign-in should join Trusted sign-ins when approved. */
        val trustSignIn: Set<String> = emptySet(),
        val busy: Boolean = false,
        val error: Throwable? = null,
        /** The gateway runs passkey ceremonies for this build's relay, and this app can sign them. */
        val passkeyApproval: Boolean = false,
    )
    private val lock = ReentrantLock()
    private var generation = UUID.randomUUID()
    private val mutable = MutableStateFlow(State())
    val state = mutable.asStateFlow()

    suspend fun refresh(client: GatewayPairingApproving) {
        val operation = lock.withLock {
            if (mutable.value.busy) return
            mutable.value = mutable.value.copy(busy = true, error = null)
            generation
        }
        try {
            val incoming = client.pairingApprovalRequests()
            currentCoroutineContext().ensureActive()
            val signer = passkey
            // A gateway that offers no ceremony, or can't say, still has the plain approval.
            val passkeyApproval = signer != null && try {
                client.pairingPasskeyLocation()?.rpId == signer.rpId
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                false
            }
            currentCoroutineContext().ensureActive()
            lock.withLock {
                if (generation != operation) return
                require(incoming.size <= 128 && incoming.map { it.requestId }.distinct().size == incoming.size && incoming.all(::valid))
                // Only what still needs a decision is listed. The gateway keeps a decided request for a
                // few minutes so the new device can read its answer; the owner has no use for it.
                mutable.value = mutable.value.copy(requests = incoming.filter { it.status == "pending" } + incoming.filter { it.status == "approving" },
                    compared = mutable.value.compared.filter { (id, code) -> incoming.any { it.requestId == id && it.verificationCode == code } },
                    trustSignIn = mutable.value.trustSignIn.filter { id -> incoming.any { it.requestId == id && it.canTrustSignIn } }.toSet(), busy = false,
                    passkeyApproval = passkeyApproval)
            }
        } catch (cancelled: CancellationException) {
            finish(operation, null)
            throw cancelled
        } catch (error: Exception) {
            finish(operation, error)
        }
    }

    fun setCompared(requestId: String, compared: Boolean) = lock.withLock {
        val current = mutable.value
        val request = current.requests.firstOrNull { it.requestId == requestId } ?: return
        if (current.busy || !pending(request)) return
        mutable.value = current.copy(compared = if (compared) current.compared + (requestId to request.verificationCode)
            else current.compared - requestId)
    }

    fun setTrustSignIn(requestId: String, trust: Boolean) = lock.withLock {
        val current = mutable.value
        val request = current.requests.firstOrNull { it.requestId == requestId } ?: return
        if (current.busy || !request.canTrustSignIn || !pending(request)) return
        mutable.value = current.copy(trustSignIn = if (trust) current.trustSignIn + requestId else current.trustSignIn - requestId)
    }

    fun canApprove(request: GatewayPairingApprovalRequest): Boolean = lock.withLock {
        !mutable.value.busy && request in mutable.value.requests && pending(request) && mutable.value.compared[request.requestId] == request.verificationCode
    }

    /** The explicit button compares the exact displayed request, then approves it. */
    suspend fun confirmAndApprove(request: GatewayPairingApprovalRequest, client: GatewayPairingApproving) {
        lock.withLock {
            val current = mutable.value
            if (current.busy || request !in current.requests || !pending(request)) return
            mutable.value = current.copy(compared = current.compared + (request.requestId to request.verificationCode))
        }
        decide(request, true, client)
    }

    /** Whether [request] can be approved with a passkey here. A portal's request is approved only in its own browser. */
    fun canApproveWithPasskey(request: GatewayPairingApprovalRequest): Boolean = lock.withLock {
        mutable.value.passkeyApproval && passkey != null && request.kind != "portal"
    }

    /**
     * The explicit button compares the exact displayed request, then approves it with a passkey:
     * the gateway's `approve-request` ceremony for it, signed in this app.
     */
    suspend fun confirmAndApproveWithPasskey(request: GatewayPairingApprovalRequest, client: GatewayPairingApproving) {
        val signer = passkey ?: return
        var trust = false
        val operation = lock.withLock {
            val current = mutable.value
            if (current.busy || !current.passkeyApproval || request.kind == "portal" || request !in current.requests || !pending(request)) return
            trust = request.canTrustSignIn && request.requestId in current.trustSignIn
            mutable.value = current.copy(compared = current.compared + (request.requestId to request.verificationCode), busy = true, error = null)
            generation
        }
        try {
            val ceremony = client.pairingApprovalCeremony(request.requestId)
            currentCoroutineContext().ensureActive()
            val proof = signer.approval(ceremony)
            currentCoroutineContext().ensureActive()
            if (lock.withLock { generation != operation }) return
            client.approvePairingWithPasskey(request.requestId, proof, trust)
            currentCoroutineContext().ensureActive()
            removeDecided(operation, request)
        } catch (cancelled: CancellationException) {
            finish(operation, null)
            throw cancelled
        } catch (error: Exception) {
            finish(operation, error)
        }
    }

    suspend fun decide(request: GatewayPairingApprovalRequest, approve: Boolean, client: GatewayPairingApproving) {
        var trust = false
        val operation = lock.withLock {
            val current = mutable.value
            if (current.busy || request !in current.requests || !pending(request) ||
                approve && current.compared[request.requestId] != request.verificationCode) return
            trust = approve && request.canTrustSignIn && request.requestId in current.trustSignIn
            mutable.value = current.copy(busy = true, error = null)
            generation
        }
        try {
            client.decidePairingApproval(request.requestId, approve, trust)
            currentCoroutineContext().ensureActive()
            removeDecided(operation, request)
        } catch (cancelled: CancellationException) {
            finish(operation, null)
            throw cancelled
        } catch (error: Exception) {
            finish(operation, error)
        }
    }

    private fun removeDecided(operation: UUID, request: GatewayPairingApprovalRequest) = lock.withLock {
        if (generation != operation) return@withLock
        mutable.value = mutable.value.copy(requests = mutable.value.requests.filterNot { it.requestId == request.requestId },
            compared = mutable.value.compared - request.requestId,
            trustSignIn = mutable.value.trustSignIn - request.requestId, busy = false)
    }

    fun stop() = lock.withLock {
        generation = UUID.randomUUID()
        mutable.value = State()
    }

    private fun finish(operation: UUID, error: Throwable?) = lock.withLock {
        if (generation == operation) mutable.value = mutable.value.copy(busy = false, error = error)
    }

    private fun pending(request: GatewayPairingApprovalRequest): Boolean = request.status == "pending" && request.expiresAt > now()

    private fun valid(request: GatewayPairingApprovalRequest): Boolean =
        Regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$").matches(request.requestId) &&
            request.kind in setOf("ios", "android", "collector", "cli", "portal") && request.name.isNotEmpty() && request.name.length <= 80 &&
            request.status in setOf("pending", "approving", "approved", "denied") && request.expiresAt > 0 &&
            PairingCode.FORMAT.matches(request.verificationCode)
}
