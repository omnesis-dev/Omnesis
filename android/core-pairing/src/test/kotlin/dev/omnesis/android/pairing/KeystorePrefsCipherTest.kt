// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * JVM-side coverage of [KeystorePrefsCipher.open]'s parse fast-path: every case here
 * fails before any Android Keystore call, so the production class runs on the plain
 * JVM. Round-trips through the real Keystore need a device/instrumented lane.
 */
class KeystorePrefsCipherTest {

    private val cipher = KeystorePrefsCipher()

    @Test
    fun open_rejects_a_token_with_no_structure() {
        assertThrows(PrefsCipherException::class.java) { cipher.open("garbage") }
    }

    @Test
    fun open_rejects_an_unknown_token_version() {
        assertThrows(PrefsCipherException::class.java) { cipher.open("v2:a:b") }
    }

    @Test
    fun open_rejects_a_token_with_malformed_base64() {
        assertThrows(PrefsCipherException::class.java) { cipher.open("v1:!!!notbase64:x") }
    }

    @Test
    fun open_rejects_a_token_with_extra_segments() {
        assertThrows(PrefsCipherException::class.java) { cipher.open("v1:a:b:c") }
    }
}
