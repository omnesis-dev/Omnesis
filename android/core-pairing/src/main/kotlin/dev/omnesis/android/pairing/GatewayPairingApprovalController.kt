// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.CloudRelayManaging
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
    private val passkey: GatewayPasskeySigner? = null,
    private val now: () -> Long = System::currentTimeMillis,
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
        /** The approval the gateway asked to confirm with the owner's passkey. The request stays listed. */
        val stepUp: StepUp? = null,
        /** The device just denied, for the follow-up that offers to make every new device ask first. */
        val denied: GatewayPairingApprovalRequest? = null,
        /** The follow-up was taken: new devices now always ask. */
        val askingFirst: Boolean = false,
        /** Approving from this phone asks for the owner's passkey first, so the button says so. */
        val stepUpRequired: Boolean = false,
    )

    /**
     * The gateway would not take [requestId]'s approval from this phone until the owner confirms
     * it's them (428 `STEP_UP_REQUIRED`), or can't take it from any relayed phone right now
     * because a security lock is on ([unavailable], 403 `STEP_UP_UNAVAILABLE`).
     */
    data class StepUp(val requestId: String, val unavailable: Boolean)
    private val lock = ReentrantLock()
    /** Requests whose suggested "remember" was applied once; the owner's own choice then stands. */
    private val suggested = mutableSetOf<String>()
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
            val listed = client.pairingApprovals()
            val incoming = listed.items
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
                    // The gateway suggests remembering the first confirmation; once, so unticking it sticks.
                    trustSignIn = mutable.value.trustSignIn.filter { id -> incoming.any { it.requestId == id && rememberable(it) } }.toSet() +
                        incoming.filter { it.rememberByDefault && rememberable(it) && suggested.add(it.requestId) }.map { it.requestId },
                    busy = false, stepUpRequired = listed.stepUpRequired,
                    passkeyApproval = passkeyApproval,
                    stepUp = mutable.value.stepUp?.takeIf { stepUp -> incoming.any { it.requestId == stepUp.requestId && it.status == "pending" } })
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
        if (current.busy || !rememberable(request) || !pending(request)) return
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
            mutable.value = current.copy(busy = true, error = null, stepUp = null, denied = null)
            generation
        }
        try {
            client.decidePairingApproval(request.requestId, approve, trust)
            currentCoroutineContext().ensureActive()
            removeDecided(operation, request, denied = !approve)
        } catch (cancelled: CancellationException) {
            finish(operation, null)
            throw cancelled
        } catch (error: Exception) {
            val stepUp = if (approve) stepUpFor(request, error) else null
            // The gateway keeps the request; its own page can approve it with the owner's passkey.
            if (stepUp != null) lock.withLock {
                if (generation == operation) mutable.value = mutable.value.copy(busy = false, stepUp = stepUp)
            } else finish(operation, error)
        }
    }

    /**
     * After a denial: every new device asks first from now on. This only makes the gateway
     * stricter, so the gateway never asks to confirm it.
     */
    suspend fun askFirst(client: CloudRelayManaging) {
        val operation = lock.withLock {
            val current = mutable.value
            if (current.busy || current.denied == null || current.askingFirst) return
            mutable.value = current.copy(busy = true, error = null)
            generation
        }
        try {
            client.setCloudRelayEnrollmentPolicy("ask")
            currentCoroutineContext().ensureActive()
            lock.withLock { if (generation == operation) mutable.value = mutable.value.copy(busy = false, askingFirst = true) }
        } catch (cancelled: CancellationException) {
            finish(operation, null)
            throw cancelled
        } catch (error: Exception) {
            finish(operation, error)
        }
    }

    private fun stepUpFor(request: GatewayPairingApprovalRequest, error: Exception): StepUp? = when {
        error is GatewayException.ServerError && error.status == 428 && error.code == "STEP_UP_REQUIRED" -> StepUp(request.requestId, unavailable = false)
        error is GatewayException.Forbidden && error.code == "STEP_UP_UNAVAILABLE" -> StepUp(request.requestId, unavailable = true)
        else -> null
    }

    private fun removeDecided(operation: UUID, request: GatewayPairingApprovalRequest, denied: Boolean = false) = lock.withLock {
        if (generation != operation) return@withLock
        mutable.value = mutable.value.copy(requests = mutable.value.requests.filterNot { it.requestId == request.requestId },
            compared = mutable.value.compared - request.requestId,
            trustSignIn = mutable.value.trustSignIn - request.requestId, busy = false,
            stepUp = null, denied = if (denied) request else null)
    }

    fun stop() = lock.withLock {
        generation = UUID.randomUUID()
        suggested.clear()
        mutable.value = State()
    }

    private fun finish(operation: UUID, error: Throwable?) = lock.withLock {
        if (generation == operation) mutable.value = mutable.value.copy(busy = false, error = error)
    }

    /** Never a Google account other than the one the gateway was connected with. */
    private fun rememberable(request: GatewayPairingApprovalRequest) = request.canTrustSignIn && !request.otherGoogleAccount

    private fun pending(request: GatewayPairingApprovalRequest): Boolean = request.status == "pending" && request.expiresAt > now()

    private fun valid(request: GatewayPairingApprovalRequest): Boolean =
        Regex("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$").matches(request.requestId) &&
            request.kind in setOf("ios", "android", "collector", "cli", "portal") && request.name.isNotEmpty() && request.name.length <= 80 &&
            request.status in setOf("pending", "approving", "approved", "denied") && request.expiresAt > 0 &&
            PairingCode.FORMAT.matches(request.verificationCode)
}
