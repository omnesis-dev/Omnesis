// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.models.DecisionSetup.SaveRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The setup's save path through the real composables: nothing leaves the host before consent. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DecisionSetupUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun a_cloud_save_asks_for_consent_before_anything_is_written() {
        val overview = sampleDecisionOverview()
        val saves = mutableListOf<SaveRequest>()
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                DecisionSetupContent(
                    cap = overview.capabilities.first { it.role == "decision" },
                    overview = overview,
                    ui = DecisionUiState(typesafeKey = DecisionSetup.KeyState.Missing),
                    actions = DecisionActions(onSave = { request, _ -> saves += request }),
                    previewStep = DecisionStep.Form,
                    previewProvider = DecisionSetup.Provider.Preset(sampleDecisionPresets().first { it.id == "typesafe" }),
                    previewForm = DecisionFormValues(model = "jev-1.14.0", apiKey = "example-key-0007"),
                )
            }
        }
        compose.onNodeWithText("Save and verify").performClick()
        assertTrue(saves.isEmpty())
        compose.onNodeWithText("Enable cloud inference?").assertIsDisplayed()

        compose.onNodeWithText("Enable cloud inference and save").performClick()
        assertEquals(
            listOf<SaveRequest>(SaveRequest.TypeSafe("jev-1.14.0", apiKey = "example-key-0007", enableRemote = true)),
            saves,
        )
    }

    @Test fun an_on_host_save_needs_no_consent() {
        val overview = sampleDecisionOverview()
        val saves = mutableListOf<SaveRequest>()
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                DecisionSetupContent(
                    cap = overview.capabilities.first { it.role == "decision" },
                    overview = overview,
                    ui = DecisionUiState(),
                    actions = DecisionActions(onSave = { request, _ -> saves += request }),
                    previewStep = DecisionStep.Form,
                    previewProvider = DecisionSetup.Provider.Preset(sampleDecisionPresets().first { it.id == "ollama" }),
                    previewForm = DecisionFormValues(name = "ollama", url = "http://127.0.0.1:11434/v1/systemone", model = "d3:4b"),
                )
            }
        }
        compose.onNodeWithText("Save and verify").performClick()
        val save = saves.single() as SaveRequest.Backend
        assertEquals("ollama/d3:4b", save.assignment)
        assertEquals(false, save.enableRemote)
        assertEquals("systemone", save.config.decision?.protocol)
        assertEquals(null, save.config.url)
    }

    @Test fun adding_decisions_to_a_chat_backend_asks_no_key() {
        val overview = sampleDecisionOverview()
        val enable = DecisionSetup.providerGroups(overview).yours.filterIsInstance<DecisionSetup.Provider.Enable>().single()
        val saves = mutableListOf<SaveRequest>()
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                DecisionSetupContent(
                    cap = overview.capabilities.first { it.role == "decision" },
                    overview = overview,
                    ui = DecisionUiState(),
                    actions = DecisionActions(onSave = { request, _ -> saves += request }),
                    previewStep = DecisionStep.Form,
                    previewProvider = enable,
                    previewForm = DecisionFormValues(
                        name = "fireworks",
                        url = enable.decision.url,
                        model = "accounts/fireworks/models/rune",
                    ),
                )
            }
        }
        compose.onNodeWithText("API key").assertDoesNotExist()
        compose.onNodeWithText("Uses the API key this backend already has. Its other models stay as they are.").assertIsDisplayed()
        compose.onNodeWithText("Save and verify").performClick()
        compose.onNodeWithText("Enable cloud inference and save").performClick()
        val save = saves.single() as SaveRequest.Backend
        assertEquals("fireworks/accounts/fireworks/models/rune", save.assignment)
        assertTrue(save.enableRemote)
        assertEquals(null, save.config.apiKey)
        assertEquals(null, save.config.type)
        assertEquals("https://api.fireworks.ai/inference/v1/systemone", save.config.decision?.url)
    }
}
