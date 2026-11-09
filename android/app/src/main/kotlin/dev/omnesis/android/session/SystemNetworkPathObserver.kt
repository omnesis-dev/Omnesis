// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import dev.omnesis.android.transport.ws.NetworkPathObserver
import dev.omnesis.android.transport.ws.NetworkPathSnapshot
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * The system's default network as [NetworkPathSnapshot]s. Starts from the current network, because
 * a default-network callback says nothing at all while there is none, and a socket has to know
 * that it started offline for the first network to count as restored.
 */
class SystemNetworkPathObserver(context: Context) : NetworkPathObserver {
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)

    override fun paths(): Flow<NetworkPathSnapshot> = callbackFlow {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                trySend(snapshot(capabilities))
            }

            override fun onLost(network: Network) {
                trySend(OFFLINE)
            }
        }
        trySend(connectivity.activeNetwork?.let(connectivity::getNetworkCapabilities)?.let(::snapshot) ?: OFFLINE)
        connectivity.registerDefaultNetworkCallback(callback)
        awaitClose { connectivity.unregisterNetworkCallback(callback) }
    }.conflate().distinctUntilChanged()

    internal companion object {
        val OFFLINE = NetworkPathSnapshot(isUsable = false)

        fun snapshot(capabilities: NetworkCapabilities): NetworkPathSnapshot {
            val interfaces = buildSet {
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) add(NetworkPathSnapshot.Interface.WIFI)
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) add(NetworkPathSnapshot.Interface.CELLULAR)
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) add(NetworkPathSnapshot.Interface.WIRED)
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) add(NetworkPathSnapshot.Interface.OTHER)
            }
            return NetworkPathSnapshot(
                isUsable = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
                interfaces = interfaces,
                isValidated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
            )
        }
    }
}
