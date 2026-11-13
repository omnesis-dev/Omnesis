// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import org.junit.Assert.*
import org.junit.Test

class GooglePairingConfigurationTest {
    @Test fun `Google pairing stays optional and requires both platform registrations and a fixed HTTPS origin`() {
        val id = "synthetic.apps.googleusercontent.com"
        for (origin in listOf("https://relay.example.com", "https://relay.example.com/", "https://relay.example.com:8443"))
            assertTrue(googlePairingConfigured(id, id, origin, enabled = true))
        for (origin in listOf("", "not a URL", "https:/", "http://relay.example.com", "https://relay.example.com/path",
            "https://user@relay.example.com", "https://relay.example.com?query", "https://relay.example.com#fragment",
            "https://relay.example.com:0", "https://relay.example.com:65536"))
            assertFalse(origin, googlePairingConfigured(id, id, origin, enabled = true))
        assertFalse(googlePairingConfigured("", id, "https://relay.example.com", enabled = true))
        assertFalse(googlePairingConfigured(id, "", "https://relay.example.com", enabled = true))
        assertFalse(googlePairingConfigured(id, id, "https://relay.example.com", enabled = false))
        assertEquals(googlePairingConfigured(), PairingViewModel.State().googleAvailable)
    }
}
