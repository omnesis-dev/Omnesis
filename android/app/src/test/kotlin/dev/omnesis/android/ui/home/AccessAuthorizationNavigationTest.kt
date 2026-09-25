// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AccessAuthorizationNavigationTest {
    @Test fun qr_launch_route_carries_the_code_and_unique_delivery_nonce() {
        val pairing = AccessAuthorizationPairingIdentity(
            "https://gateway.example.com",
            "device-example",
            "generation-example",
        )
        assertEquals(
            "access/authorize?code=ABCD-EFGH&launch=42" +
                "&gateway=https%3A%2F%2Fgateway.example.com" +
                "&device=device-example&generation=generation-example",
            accessAuthorizationRoute("ABCD-EFGH", 42L, pairing),
        )
    }

    @Test fun content_free_push_route_carries_no_code() {
        assertEquals("access/authorize?launch=42", accessAuthorizationRoute(null, 42L))
    }

    @Test fun banner_launch_route_names_the_request_instead_of_a_code() {
        val pairing = AccessAuthorizationPairingIdentity("https://gateway.example.com", null, null)
        assertEquals(
            "access/authorize?request=request%2Fexample&launch=42&gateway=https%3A%2F%2Fgateway.example.com",
            accessAuthorizationRoute(null, 42L, pairing, requestId = "request/example"),
        )
        assertThrows(IllegalArgumentException::class.java) {
            accessAuthorizationRoute("ABCD-EFGH", 42L, pairing, requestId = "request_example")
        }
    }
}
