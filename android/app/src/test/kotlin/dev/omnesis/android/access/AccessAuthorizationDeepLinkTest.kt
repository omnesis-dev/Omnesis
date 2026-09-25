// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.access

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AccessAuthorizationDeepLinkTest {
    private val pairing = AccessAuthorizationPairingIdentity(
        gatewayUrl = "https://gateway.example.com",
        deviceId = "device-example",
        pairingGeneration = "generation-example",
    )
    @Test fun canonical_link_yields_only_the_user_code() {
        assertEquals("ABCD-EFGH", accessAuthorizationCode(view("omnesis://access-authorization?v=1&code=ABCD-EFGH")))
    }

    @Test fun cold_and_warm_deliveries_route() {
        val intent = view("omnesis://access-authorization?v=1&code=ABCD-EFGH")
        val launches = mutableListOf<Pair<String, AccessAuthorizationPairingIdentity>>()

        assertTrue(routeAccessAuthorizationDeepLink(intent, true, pairing) { code, identity ->
            launches += code to identity
        })
        assertEquals(listOf("ABCD-EFGH" to pairing), launches)

        assertTrue(routeAccessAuthorizationDeepLink(intent, true, pairing) { code, identity ->
            launches += code to identity
        })
        assertEquals(listOf("ABCD-EFGH" to pairing, "ABCD-EFGH" to pairing), launches)
    }

    @Test fun recreation_cannot_replay_a_consumed_intent() {
        val consumed = consumedAccessAuthorizationIntent(
            view("omnesis://access-authorization?v=1&code=ABCD-EFGH"),
        )
        val routedCodes = mutableListOf<String>()

        assertFalse(routeAccessAuthorizationDeepLink(consumed, true, pairing) { code, _ -> routedCodes += code })
        assertTrue(routedCodes.isEmpty())
    }

    @Test fun a_fresh_killed_task_delivery_is_not_suppressed_by_restored_state() {
        // MainActivity intentionally routes a new ACTION_VIEW on every onCreate,
        // independent of whether Android also supplies a restored-state Bundle.
        val routedCodes = mutableListOf<String>()
        assertTrue(
            routeAccessAuthorizationDeepLink(
                view("omnesis://access-authorization?v=1&code=ABCD-EFGH"),
                freshDelivery = true,
                pairingIdentity = pairing,
                onLaunch = { code, _ -> routedCodes += code },
            ),
        )
        assertEquals(listOf("ABCD-EFGH"), routedCodes)
    }

    @Test fun an_unpaired_phone_consumes_but_does_not_route_the_deep_link() {
        val routedCodes = mutableListOf<String>()
        assertTrue(
            routeAccessAuthorizationDeepLink(
                view("omnesis://access-authorization?v=1&code=ABCD-EFGH"),
                freshDelivery = true,
                pairingIdentity = null,
                onLaunch = { code, _ -> routedCodes += code },
            ),
        )
        assertTrue(routedCodes.isEmpty())
    }

    @Test fun an_unpaired_delivery_cannot_route_after_pairing_on_recreation() {
        val original = view("omnesis://access-authorization?v=1&code=ABCD-EFGH")
        val routedCodes = mutableListOf<String>()
        assertTrue(routeAccessAuthorizationDeepLink(original, true, null) { code, _ -> routedCodes += code })

        val consumed = consumedAccessAuthorizationIntent(original)
        assertFalse(routeAccessAuthorizationDeepLink(consumed, true, pairing) { code, _ -> routedCodes += code })
        assertTrue(routedCodes.isEmpty())
    }

    @Test fun pairing_match_rejects_unpaired_and_changed_sessions_but_allows_content_free_push() {
        val changed = pairing.copy(pairingGeneration = "generation-replacement")
        assertFalse(accessAuthorizationPairingMatches(pairing, null))
        assertFalse(accessAuthorizationPairingMatches(pairing, changed))
        assertTrue(accessAuthorizationPairingMatches(pairing, pairing))
        assertTrue(accessAuthorizationPairingMatches(null, null))
    }

    @Test fun rejects_non_view_intents_and_noncanonical_origins() {
        assertNull(accessAuthorizationCode(Intent("example.action", canonicalUri())))
        assertNull(accessAuthorizationCode(view("https://access-authorization?v=1&code=ABCD-EFGH")))
        assertNull(accessAuthorizationCode(view("omnesis://other?v=1&code=ABCD-EFGH")))
        assertNull(accessAuthorizationCode(view("omnesis://access-authorization.example?v=1&code=ABCD-EFGH")))
        assertNull(accessAuthorizationCode(view("omnesis://user@access-authorization?v=1&code=ABCD-EFGH")))
        assertNull(accessAuthorizationCode(view("omnesis://access-authorization:443?v=1&code=ABCD-EFGH")))
        assertNull(accessAuthorizationCode(view("omnesis://access-authorization/path?v=1&code=ABCD-EFGH")))
        assertNull(accessAuthorizationCode(view("omnesis://access-authorization?v=1&code=ABCD-EFGH#fragment")))
    }

    @Test fun rejects_unknown_missing_duplicate_or_gateway_parameters() {
        assertNull(accessAuthorizationCode(view("omnesis://access-authorization?code=ABCD-EFGH")))
        assertNull(accessAuthorizationCode(view("omnesis://access-authorization?v=2&code=ABCD-EFGH")))
        assertNull(accessAuthorizationCode(view("omnesis://access-authorization?v=1&v=1&code=ABCD-EFGH")))
        assertNull(accessAuthorizationCode(view("omnesis://access-authorization?v=1&code=ABCD-EFGH&code=JKLM-NPQR")))
        assertNull(accessAuthorizationCode(view("omnesis://access-authorization?v=1&code=ABCD-EFGH&gateway=https%3A%2F%2Fgateway.example.com")))
    }

    @Test fun rejects_malformed_user_codes() {
        listOf(
            "abcd-efgh",
            "ABCD",
            "ABCD-EFGHI",
            "ABC0-EFGH",
            "ABCD-EFG1",
            "ABCI-EFGH",
            "ABCO-EFGH",
            "ABCD%0AEFGH",
        ).forEach { code ->
            assertNull(accessAuthorizationCode(view("omnesis://access-authorization?v=1&code=$code")))
        }
    }

    private fun canonicalUri() = Uri.parse("omnesis://access-authorization?v=1&code=ABCD-EFGH")
    private fun view(value: String) = Intent(Intent.ACTION_VIEW, Uri.parse(value))
}
