// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import dev.omnesis.android.BuildConfig
import java.net.URI
import org.junit.Assert.*
import org.junit.Test

class GooglePairingConfigurationTest {
    @Test fun `Google sign-in requires both platform registrations`() {
        val id = "synthetic.apps.googleusercontent.com"
        assertTrue(googlePairingConfigured(id, id))
        assertFalse(googlePairingConfigured("", id))
        assertFalse(googlePairingConfigured(id, ""))
        assertFalse(googlePairingConfigured("synthetic.example.com", id))
    }

    @Test fun `every build names an https relay origin`() {
        val relay = URI(BuildConfig.CLOUD_RELAY_URL)
        assertEquals("https", relay.scheme)
        assertFalse(relay.host.isNullOrEmpty())
        assertTrue(relay.path in listOf("", "/"))
        assertNull(relay.query)
    }
}
