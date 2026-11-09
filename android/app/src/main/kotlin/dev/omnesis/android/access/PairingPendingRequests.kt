// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.access

import dev.omnesis.android.BuildConfig
import dev.omnesis.android.transport.dto.GatewayPairingApprovalRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

/**
 * What the main screen's banner shows while devices that signed in wait for approval: one
 * banner however many wait, with the count in its words.
 */
data class PairingRequestBannerOffer(val count: Int) {
    val text: String
        get() = if (count > 1) "$count devices are waiting for your approval to pair to this gateway." else ONE

    companion object {
        const val ONE = "A device is waiting for your approval to pair to this gateway."

        /** The banner's action, which opens Pairing requests. */
        const val ACTION = "Review"
    }
}

/** The requests the owner can still decide. A list read a while ago can carry one that has since run out. */
fun pairingRequestsStillWaiting(requests: List<GatewayPairingApprovalRequest>, nowMillis: Long): List<GatewayPairingApprovalRequest> =
    requests.filter { it.status == "pending" && it.expiresAt > nowMillis }

/**
 * The sign-in pairing requests the gateway last listed, and the banner they earn. Dismissing
 * hides the banner for exactly the set waiting at that moment; a request arriving, decided or
 * expiring brings it back. Nothing is stored.
 */
data class PairingPendingRequestsState(
    val requests: List<GatewayPairingApprovalRequest> = emptyList(),
    private val dismissedIds: Set<String>? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val waiting: List<GatewayPairingApprovalRequest> get() = pairingRequestsStillWaiting(requests, clock())

    val banner: PairingRequestBannerOffer?
        get() {
            val live = waiting
            if (live.isEmpty() || live.ids() == dismissedIds) return null
            return PairingRequestBannerOffer(live.size)
        }

    fun replaced(requests: List<GatewayPairingApprovalRequest>) = copy(requests = requests)

    fun dismissed() = copy(dismissedIds = waiting.ids())

    private fun List<GatewayPairingApprovalRequest>.ids(): Set<String> = mapTo(mutableSetOf()) { it.requestId }
}

/**
 * Only an administrator's phone in a build with the Omnesis account asks the gateway; any
 * other phone holds an empty list and never sends a request.
 */
@Singleton
class PairingPendingRequests(clock: () -> Long) {
    @Inject constructor() : this(System::currentTimeMillis)

    private val _state = MutableStateFlow(PairingPendingRequestsState(clock = clock))
    val state: StateFlow<PairingPendingRequestsState> = _state.asStateFlow()

    fun replace(requests: List<GatewayPairingApprovalRequest>) = _state.update { it.replaced(requests) }

    fun dismiss() = _state.update { it.dismissed() }

    companion object {
        /** How often the banner asks again while the app is in front. */
        const val POLL_MILLIS = 30_000L

        private val _refreshRequests = MutableStateFlow(0)

        /** Bumped to ask for a fresh read now: a pairing notification arrived on this phone. */
        val refreshRequests: StateFlow<Int> = _refreshRequests.asStateFlow()

        fun requestRefresh() = _refreshRequests.update { it + 1 }

        /** Whether the main screen reads the waiting requests at all: only a build with cloud connectivity does. */
        fun polls(cloudEnabled: Boolean = BuildConfig.CLOUD_RELAY_ENABLED): Boolean = cloudEnabled

        /** Whether this phone may list pairing requests at all. */
        fun eligible(cloudEnabled: Boolean, scopes: Collection<String>?): Boolean = cloudEnabled && scopes?.contains("admin") == true
    }
}
