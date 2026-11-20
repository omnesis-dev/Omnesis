// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.access

import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import dev.omnesis.android.transport.dto.TailscaleJoinApproving
import dev.omnesis.android.transport.dto.TailscaleJoinRequest
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

/**
 * What the main screen's banner shows while devices wait for approval, however they asked (by
 * signing in, or through Tailscale): one banner however many wait, with the count in its words.
 */
data class PairingRequestBannerOffer(val count: Int) {
    val text: String
        get() = if (count > 1) "$count new devices are waiting for your OK." else ONE

    companion object {
        const val ONE = "A new device is waiting for your OK."

        /** The banner's action, which opens the approvals sheet. */
        const val ACTION = "Review"
    }
}

/** The requests the owner can still decide. A list read a while ago can carry one that has since run out. */
fun pairingRequestsStillWaiting(requests: List<GatewayPairingApprovalRequest>, nowMillis: Long): List<GatewayPairingApprovalRequest> =
    requests.filter { it.status == "pending" && it.expiresAt > nowMillis }

/**
 * The pairing requests the gateway last listed, of both kinds, and the banner they earn.
 * Dismissing hides the banner for exactly the set waiting at that moment; a request arriving,
 * decided or expiring brings it back. Nothing is stored.
 */
data class PairingPendingRequestsState(
    /** Devices that signed in with the Omnesis account. */
    val requests: List<GatewayPairingApprovalRequest> = emptyList(),
    /** Devices on the owner's Tailscale network that asked to join. */
    val tailscale: List<TailscaleJoinRequest> = emptyList(),
    private val dismissedIds: Set<String>? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** The ids of every request still waiting, each kind in its own namespace. */
    private val waitingIds: Set<String>
        get() {
            val now = clock()
            return pairingRequestsStillWaiting(requests, now).mapTo(mutableSetOf()) { "sign-in:${it.requestId}" } +
                tailscale.filterNot { it.expired(now) }.map { "tailscale:${it.id}" }
        }

    val banner: PairingRequestBannerOffer?
        get() {
            val live = waitingIds
            if (live.isEmpty() || live == dismissedIds) return null
            return PairingRequestBannerOffer(live.size)
        }

    fun replaced(requests: List<GatewayPairingApprovalRequest>) = copy(requests = requests)

    fun replacedTailscale(requests: List<TailscaleJoinRequest>) = copy(tailscale = requests)

    fun dismissed() = copy(dismissedIds = waitingIds)
}

/**
 * Only an administrator's phone asks the gateway: for sign-in requests in a build with the
 * Omnesis account, and for Tailscale joins while the gateway advertises them. Any other phone
 * holds empty lists and never sends a request.
 */
@Singleton
class PairingPendingRequests(clock: () -> Long) {
    @Inject constructor() : this(System::currentTimeMillis)

    private val _state = MutableStateFlow(PairingPendingRequestsState(clock = clock))
    val state: StateFlow<PairingPendingRequestsState> = _state.asStateFlow()

    /** Only the latest Tailscale read or listing lands. */
    private val tailscaleGeneration = AtomicLong()

    fun replace(requests: List<GatewayPairingApprovalRequest>) = _state.update { it.replaced(requests) }

    fun dismiss() = _state.update { it.dismissed() }

    /**
     * Read the waiting Tailscale joins with [client]: null for a phone that may not ask or a
     * gateway that does not advertise them, which asks nothing and holds none. A failed read,
     * a 404 included, shows nothing rather than a request that may be gone.
     */
    suspend fun refreshTailscale(client: TailscaleJoinApproving?) {
        val generation = tailscaleGeneration.incrementAndGet()
        val requests = if (client == null) {
            emptyList()
        } else {
            try {
                client.tailscaleJoinRequests()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                emptyList()
            }
        }
        if (generation == tailscaleGeneration.get()) _state.update { it.replacedTailscale(requests) }
    }

    /** What the approvals sheet last listed is what the banner counts, over any read under way. */
    fun tailscaleListed(requests: List<TailscaleJoinRequest>) {
        tailscaleGeneration.incrementAndGet()
        _state.update { it.replacedTailscale(requests) }
    }

    companion object {
        /** How often the banner asks again while the app is in front. */
        const val POLL_MILLIS = 30_000L

        private val _refreshRequests = MutableStateFlow(0)

        /** Bumped to ask for a fresh read now: a pairing or Tailscale join notification arrived on this phone. */
        val refreshRequests: StateFlow<Int> = _refreshRequests.asStateFlow()

        fun requestRefresh() = _refreshRequests.update { it + 1 }

        /** Whether this phone may list sign-in pairing requests at all. */
        fun eligible(scopes: Collection<String>?): Boolean = scopes?.contains("admin") == true
    }
}
