// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.ws

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

/**
 * What the system says about the network. It is advisory in both directions: a usable path does
 * not prove the gateway is reachable, and an unusable one does not stop the socket's own bounded
 * retries.
 */
data class NetworkPathSnapshot(
    val isUsable: Boolean,
    val interfaces: Set<Interface> = emptySet(),
    /** The system has confirmed internet access on this network, past any Wi-Fi sign-in page. */
    val isValidated: Boolean = false,
) {
    enum class Interface { WIFI, CELLULAR, WIRED, OTHER }

    /** How a new snapshot differs from the previous one. */
    enum class Transition { UNCHANGED, LOST, RESTORED }

    /**
     * A usable path that changed in any way counts as restored: joining Wi-Fi, bringing up a VPN
     * or passing a sign-in page can give the gateway a route the previous path did not have.
     */
    fun transitionFrom(previous: NetworkPathSnapshot?): Transition = when {
        previous == null || previous == this -> Transition.UNCHANGED
        !isUsable -> if (previous.isUsable) Transition.LOST else Transition.UNCHANGED
        else -> Transition.RESTORED
    }
}

/** The current path, then each change. */
fun interface NetworkPathObserver {
    fun paths(): Flow<NetworkPathSnapshot>

    companion object {
        /** For a socket that has no network signal, such as a live-gateway test. */
        val None = NetworkPathObserver { emptyFlow() }
    }
}
