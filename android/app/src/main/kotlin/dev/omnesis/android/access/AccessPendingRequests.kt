// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.access

import dev.omnesis.android.transport.dto.AccessPendingRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import javax.inject.Inject
import javax.inject.Singleton

/** What the main screen's banner names: the newest request waiting, and how many wait in all. */
data class AccessPendingBannerOffer(
    val newest: AccessPendingRequest,
    val count: Int,
) {
    /** The line under the title: who is asking, and how many more wait behind it. */
    val detail: String
        get() = if (count > 1) "${newest.clientName} and ${count - 1} more" else newest.clientName
}

/**
 * The authorization requests the gateway last listed as waiting on the owner, and the
 * banner they earn on the main screen.
 *
 * The banner names one request — the newest — however many are waiting, and counts the
 * rest. A request is waiting only until its expiry, read from [clock] every time the banner
 * is asked for, so one that lapses while the app stays in front leaves the banner without a
 * new listing. Dismissing remembers the exact set of ids on screen at that moment: the
 * banner stays away while that same set is waiting, and returns as soon as a request is
 * added, decided or expires.
 */
data class AccessPendingRequestsState(
    val requests: List<AccessPendingRequest> = emptyList(),
    private val dismissedIds: Set<String>? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val waiting: List<AccessPendingRequest>
        get() = clock().let { now -> requests.filter { it.expiresAt > now } }

    /** The banner's offer, or null when nothing waits or the set waiting now was dismissed. */
    val banner: AccessPendingBannerOffer?
        get() {
            val live = waiting
            if (live.isEmpty() || live.ids() == dismissedIds) return null
            return AccessPendingBannerOffer(newest = live.maxBy { it.createdAt }, count = live.size)
        }

    /** The list as the gateway reports it now. */
    fun replaced(requests: List<AccessPendingRequest>) = copy(requests = requests)

    fun dismissed() = copy(dismissedIds = waiting.ids())

    /** A request decided or found no longer pending from this app leaves the list at once. */
    fun settled(requestId: String) = copy(requests = requests.filterNot { it.id == requestId })

    private fun List<AccessPendingRequest>.ids(): Set<String> = mapTo(mutableSetOf()) { it.id }
}

@Singleton
class AccessPendingRequests(clock: () -> Long) {
    @Inject constructor() : this(System::currentTimeMillis)

    private val _state = MutableStateFlow(AccessPendingRequestsState(clock = clock))
    val state: StateFlow<AccessPendingRequestsState> = _state.asStateFlow()

    fun replace(requests: List<AccessPendingRequest>) = _state.update { it.replaced(requests) }

    fun dismiss() = _state.update { it.dismissed() }

    fun settled(requestId: String) = _state.update { it.settled(requestId) }
}
