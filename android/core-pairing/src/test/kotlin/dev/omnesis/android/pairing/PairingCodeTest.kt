// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The comparison code's vectors, shared with the gateway (`CODE_VECTOR` in
 * `packages/cloud-relay/src/device-enrollment.test.ts`) and the iOS app.
 */
class PairingCodeTest {
    private val challenge = CloudPairingChallenge.create("Phone", "11111111-2222-4333-8444-555555555555", "a".repeat(64))
    private val fingerprint = "c".repeat(64)

    // The first two digests start with a byte above 0x7f; the last two codes need zero padding.
    private val vectors = listOf(
        Triple("pJWNXrJQNFNxwwlR2tLh_1z0tfx97lCkE06ZmeKdzVk", "iwOHbSTjE220DUUWUtefEXqtmgWFndBJadOZFryJNDs", "465 774"),
        Triple("A68bALMSvVBKZ4_cnbSsOU5NHxUqpeL03rwcAkvQJuY", "wEUOKG6N5cyUL4rQwRITqBWidnd6RF3vjSxafblNF80", "081 434"),
        Triple("1uSZpIa4poPLc_3XyndwQ-G7g8lP8Pqu8nqTsJIylT4", "Dp9I5hCYSrL266BmkV4wY-XWhsBYfJBky-T5WZTnOos", "003 579"),
    )

    @Test fun `the commitment and the code match the shared vectors`() {
        for ((nonce, commitment, code) in vectors) {
            assertEquals(commitment, PairingCode.commitment(nonce))
            assertEquals(code, challenge.comparisonCode(fingerprint, nonce))
            assertTrue(PairingCode.FORMAT.matches(code))
        }
        // Another certificate, another code.
        assertEquals("531 664", challenge.comparisonCode("d".repeat(64), vectors.first().first))
    }

    @Test fun `only a 43 character nonce and a lowercase fingerprint are accepted`() {
        for (nonce in listOf("", "short", vectors.first().first + "x", vectors.first().first.dropLast(1) + "=", vectors.first().first.dropLast(1) + " ")) {
            assertThrows(CloudPairingException::class.java) { PairingCode.commitment(nonce) }
            assertThrows(CloudPairingException::class.java) { challenge.comparisonCode(fingerprint, nonce) }
        }
        for (bad in listOf("C".repeat(64), "c".repeat(63), "g".repeat(64))) {
            assertThrows(CloudPairingException::class.java) { challenge.comparisonCode(bad, vectors.first().first) }
        }
    }

    @Test fun `typed digits are regrouped and anything else is not a code`() {
        for (typed in listOf("465774", "465 774", " 465-774 ", "4 6 5 7 7 4", "465\t774")) assertEquals("465 774", PairingCode.format(typed))
        assertEquals("003 579", PairingCode.format("003579"))
        for (bad in listOf("", "46577", "4657745", "46577a", "AAAA-BBBB-CCCC-DDDD-EEEE", "４６５７７４")) assertNull(bad, PairingCode.format(bad))
        assertTrue(PairingCode.FORMAT.matches("000 000"))
        for (bad in listOf("465774", "465-774", "465  774", " 465 774", "465 7744")) assertTrue(bad, !PairingCode.FORMAT.matches(bad))
    }
}
