// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import org.junit.Assert.*
import org.junit.Test

class DirectGatewayCandidatesTest {
    private val origin = "https://gateway.example.test"
    @Test fun `versioned direct metadata accepts only bounded private address and port facts`() {
        val values = validatedDirectCandidates(origin, """{"version":1,"candidates":[{"address":"10.0.0.1","port":7600},{"address":"fd00::1","port":8443}]}""")
        assertEquals(listOf("10.0.0.1", "fd00::1"), values.map { it.address })
        assertEquals(listOf(7600, 8443), values.map { it.port })
        assertEquals(emptyList<Any>(), validatedDirectCandidates(origin, """{"version":1,"candidates":[]}"""))
        for (data in listOf("{}", "not JSON", """{"version":2,"candidates":[]}""",
            """{"version":1,"candidates":[{"address":"https://10.0.0.1","port":7600}]}""",
            """{"version":1,"candidates":[{"address":"127.0.0.1","port":7600}]}""",
            """{"version":1,"candidates":[{"address":"10.0.0.1","port":0}]}""",
            """{"version":1,"candidates":[{"address":"gateway.example.test","port":7600}]}""")) {
            assertThrows(Exception::class.java) { validatedDirectCandidates(origin, data) }
        }
    }
}
