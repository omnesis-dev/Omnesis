// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelBehaviorDecodeTest {
    @Test
    fun decodes_catalog_controls_and_saved_values_without_losing_unknown_models() {
        val overview = OmnesisJson.decodeFromString<ModelsOverview>(
            """{"modelControls":{"northstar/reasoner-v1":{"providerId":"northstar","source":"models.dev","reasoning":true,
            "controls":[{"key":"reasoningEnabled","type":"boolean","label":"Thinking"},
            {"key":"reasoningEffort","type":"enum","label":"Effort","values":["low","medium","high"],"exclusiveWith":["reasoningBudgetTokens"]},
            {"key":"reasoningBudgetTokens","type":"integer","label":"Budget","min":128,"max":8192}]},
            "custom/unknown-v1":{"providerId":"","source":"unknown","controls":[]}},
            "modelSettings":{"agent":{"assignment":"northstar/reasoner-v1","values":{"reasoningEnabled":false,
            "reasoningEffort":"high","reasoningBudgetTokens":4096}}},
            "recentModels":{"agent":[{"assignment":"northstar/reasoner-v0","providerId":"northstar",
            "providerLabel":"Northstar","modelName":"reasoner-v0",
            "apply":{"type":"assign","value":"northstar/reasoner-v0"}}]}}""",
        )
        val controls = overview.modelControls.getValue("northstar/reasoner-v1")
        assertTrue(controls.reasoning == true)
        assertEquals(listOf("low", "medium", "high"), controls.controls[1].values)
        assertEquals(listOf("reasoningBudgetTokens"), controls.controls[1].exclusiveWith)
        assertEquals(8192, controls.controls[2].max)
        assertFalse(overview.modelSettings.getValue("agent").values.reasoningEnabled!!)
        assertEquals(4096, overview.modelSettings.getValue("agent").values.reasoningBudgetTokens)
        assertEquals("northstar/reasoner-v0", overview.recentModels.getValue("agent").single().assignment)
        assertTrue(overview.modelControls.getValue("custom/unknown-v1").controls.isEmpty())
    }
}
