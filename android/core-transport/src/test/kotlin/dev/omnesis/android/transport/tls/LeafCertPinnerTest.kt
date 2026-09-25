// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.tls

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LeafCertPinnerTest {

    @Test
    fun sha256Hex_matchesKnownVector() {
        // SHA-256 of the empty byte string.
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            LeafCertPinner.sha256Hex(ByteArray(0)),
        )
    }

    @Test
    fun sha256Hex_isLowercaseHexNoSeparators() {
        val hex = LeafCertPinner.sha256Hex("omnesis".toByteArray())
        assertEquals(64, hex.length)
        assertTrue(hex.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun isValidFingerprint_acceptsAndRejects() {
        assertTrue(LeafCertPinner.isValidFingerprint("a".repeat(64)))
        assertTrue(LeafCertPinner.isValidFingerprint("A".repeat(64)))
        assertFalse(LeafCertPinner.isValidFingerprint("a".repeat(63)))
        assertFalse(LeafCertPinner.isValidFingerprint("a".repeat(65)))
        assertFalse(LeafCertPinner.isValidFingerprint("g".repeat(64)))
        assertFalse(LeafCertPinner.isValidFingerprint(null))
        assertFalse(LeafCertPinner.isValidFingerprint(""))
    }
}
