// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.ScopeIdentifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The portal checks the same writings against the gateway's own reader; the expected spellings here are its results. */
class ScopeTypedIdentifierTest {
    @Test fun aTypedAddressIsReadIntoTheGatewaySpellingOrRefused() {
        val cases = listOf(
            Triple("phone", "+15550100123", "+15550100123"),
            Triple("phone", "+1 (555) 010-0123", "+15550100123"),
            Triple("phone", "+1.555.010.0123", "+15550100123"),
            Triple("phone", "+1 555\u2011010\u20130123", "+15550100123"),
            Triple("phone", "0015550100123", "+15550100123"),
            Triple("phone", "00 1 555 010 0123", "+15550100123"),
            Triple("phone", "tel:+1-555-010-0123", "+15550100123"),
            Triple("phone", "\uFF0B\uFF11\uFF15\uFF15\uFF15\uFF10\uFF11\uFF10\uFF10\uFF11\uFF12\uFF13", "+15550100123"),
            Triple("phone", "5550100123", null),
            Triple("phone", "(555) 010-0123", null),
            Triple("phone", "+44 (0)7700 900123", null),
            Triple("phone", "+12", null),
            Triple("phone", "+1 555 010 CALL", null),
            Triple("phone", "maya@example.org", null),
            Triple("phone", "", null),
            Triple("email", "maya@example.org", "maya@example.org"),
            Triple("email", "  Maya@Example.ORG ", "maya@example.org"),
            Triple("email", "<maya@example.org>", "maya@example.org"),
            Triple("email", "Maya <Maya@example.org>", "maya@example.org"),
            Triple("email", "\"Reeves, Maya\" <maya@example.org>", "maya@example.org"),
            Triple("email", "mailto:maya@example.org", "maya@example.org"),
            Triple("email", "maya@example.org.", "maya@example.org"),
            Triple("email", "maya+receipts@example.org", "maya+receipts@example.org"),
            Triple("email", "maya@b\u00FCcher.example", "maya@b\u00FCcher.example"),
            Triple("email", "maya", null),
            Triple("email", "@example.org", null),
            Triple("email", "maya@", null),
            Triple("email", "maya@localhost", null),
            Triple("email", "maya reeves@example.org", null),
            Triple("email", "", null),
            Triple("domain", "example.org", "example.org"),
            Triple("domain", "EXAMPLE.Org", "example.org"),
            Triple("domain", "@example.org", "example.org"),
            Triple("domain", " example.org. ", "example.org"),
            Triple("domain", "mail.example.org", "mail.example.org"),
            Triple("domain", "b\u00FCcher.example", "b\u00FCcher.example"),
            Triple("domain", "localhost", null),
            Triple("domain", "*.example.org", null),
            Triple("domain", "example.org/path", null),
            Triple("domain", "https://example.org", null),
            Triple("domain", "maya@example.org", null),
            Triple("domain", "example..org", null),
            Triple("domain", "-example.org", null),
            Triple("domain", "example.123", null),
            Triple("domain", "", null),
        )
        for ((type, typed, saved) in cases) assertEquals("$type: $typed", saved, scopeTypedIdentifier(typed, type)?.value)
    }
    @Test fun anUnknownTypeOrAnOversizedValueNamesNothing() {
        assertNull(scopeTypedIdentifier("Fictional Person", "name"))
        assertNull(scopeTypedIdentifier("a".repeat(600) + "@example.org", "email"))
        assertEquals(ScopeIdentifier("email", "maya@example.org"), scopeTypedIdentifier("maya@example.org", "email"))
    }
}
