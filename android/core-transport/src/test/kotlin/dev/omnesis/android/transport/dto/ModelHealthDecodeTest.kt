// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelHealthDecodeTest {
    private val health = """{"warnings":[{"role":"decision","assignment":"typesafe/draft-model","consecutiveFailures":4,"firstFailedAt":1700000000000,"lastFailedAt":1700000060000,"category":"quota","message":"The inference provider reports exhausted quota.","futureField":true}]}"""

    @Test fun overviewAndStatusShareDiagnostics() {
        val overview = OmnesisJson.decodeFromString<ModelsOverview>("""{"inference":{"health":$health}}""")
        val status = OmnesisJson.decodeFromString<StatusSnapshot>("""{"modelHealth":$health}""")
        assertEquals(status.modelHealth, overview.inference.health)
        assertTrue(status.modelHealth.needsAttention)
        val warning = status.modelHealth.warnings.single()
        assertEquals("decision", warning.role)
        assertEquals(4, warning.consecutiveFailures)
        assertEquals(1700000060000L, warning.lastFailedAt)
    }

    @Test fun missingHealthAndRecoveryHaveNoWarnings() {
        assertTrue(OmnesisJson.decodeFromString<ModelsOverview>("{}").inference.health.warnings.isEmpty())
        assertTrue(!OmnesisJson.decodeFromString<StatusSnapshot>("{}").modelHealth.needsAttention)
        assertTrue(OmnesisJson.decodeFromString<StatusSnapshot>("""{"modelHealth":{"warnings":[]}}""").modelHealth.warnings.isEmpty())
    }

    @Test fun futureCategoryDoesNotBreakStatus() {
        val parsed = OmnesisJson.decodeFromString<StatusSnapshot>("""{"modelHealth":${health.replace("quota", "new-category")}}""")
        assertEquals("new-category", parsed.modelHealth.warnings.single().category)
    }
}
