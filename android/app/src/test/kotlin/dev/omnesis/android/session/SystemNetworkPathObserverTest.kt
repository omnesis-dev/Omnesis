// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.ws.NetworkPathSnapshot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork
import org.robolectric.shadows.ShadowNetworkCapabilities

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemNetworkPathObserverTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)

    private fun capabilities(transport: Int, validated: Boolean = true): NetworkCapabilities {
        val capabilities = ShadowNetworkCapabilities.newInstance()
        val shadow = shadowOf(capabilities)
        shadow.addTransportType(transport)
        shadow.addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        if (validated) shadow.addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        return capabilities
    }

    @Test
    fun maps_the_transport_and_validation_of_the_default_network() {
        assertEquals(
            NetworkPathSnapshot(true, setOf(NetworkPathSnapshot.Interface.WIFI), isValidated = true),
            SystemNetworkPathObserver.snapshot(capabilities(NetworkCapabilities.TRANSPORT_WIFI)),
        )
        assertEquals(
            NetworkPathSnapshot(true, setOf(NetworkPathSnapshot.Interface.CELLULAR), isValidated = false),
            SystemNetworkPathObserver.snapshot(capabilities(NetworkCapabilities.TRANSPORT_CELLULAR, validated = false)),
        )
    }

    @Test
    fun a_vpn_shows_up_as_an_interface() {
        val snapshot = SystemNetworkPathObserver.snapshot(capabilities(NetworkCapabilities.TRANSPORT_VPN))
        assertTrue(NetworkPathSnapshot.Interface.OTHER in snapshot.interfaces)
    }

    @Test
    fun reports_offline_at_once_when_there_is_no_network_then_each_change() = runTest {
        shadowOf(connectivity).setActiveNetworkInfo(null)
        shadowOf(connectivity).setDefaultNetworkActive(false)
        val received = mutableListOf<NetworkPathSnapshot>()
        val collecting = launch(UnconfinedTestDispatcher(testScheduler)) {
            SystemNetworkPathObserver(context).paths().toList(received)
        }
        // The observer asks for the network before registering its callback.
        val callback = shadowOf(connectivity).networkCallbacks.single()
        val network = ShadowNetwork.newInstance(7)
        callback.onCapabilitiesChanged(network, capabilities(NetworkCapabilities.TRANSPORT_WIFI))
        // Signal-strength updates repeat an identical snapshot and must not reach the socket.
        callback.onCapabilitiesChanged(network, capabilities(NetworkCapabilities.TRANSPORT_WIFI))
        callback.onLost(network)
        testScheduler.advanceUntilIdle()

        assertEquals(SystemNetworkPathObserver.OFFLINE, received.first())
        assertEquals(
            listOf(
                SystemNetworkPathObserver.OFFLINE,
                NetworkPathSnapshot(true, setOf(NetworkPathSnapshot.Interface.WIFI), isValidated = true),
                SystemNetworkPathObserver.OFFLINE,
            ),
            received,
        )
        collecting.cancel()
        testScheduler.advanceUntilIdle()
        assertTrue("the callback is released with the flow", shadowOf(connectivity).networkCallbacks.isEmpty())
    }
}
