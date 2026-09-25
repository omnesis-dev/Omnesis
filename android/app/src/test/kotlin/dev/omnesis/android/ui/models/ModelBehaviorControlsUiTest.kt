// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.ModelControlDescriptor
import dev.omnesis.android.transport.dto.ModelControlInfo
import dev.omnesis.android.transport.dto.ModelDisplay
import dev.omnesis.android.transport.dto.RecentModelApply
import dev.omnesis.android.transport.dto.RecentModelEntry
import dev.omnesis.android.transport.dto.ResolvedAssignment
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class ModelBehaviorControlsUiTest {
    @get:Rule val compose = createComposeRule()

    private val info = ModelControlInfo(
        providerId = "openrouter",
        source = "models.dev",
        controls = listOf(
            ModelControlDescriptor("reasoningEnabled", "boolean", "Reasoning"),
            ModelControlDescriptor("reasoningEffort", "enum", "Reasoning effort", listOf("low", "high"), exclusiveWith = listOf("reasoningBudgetTokens")),
            ModelControlDescriptor("reasoningBudgetTokens", "integer", "Reasoning token budget", min = 128, max = 8192, exclusiveWith = listOf("reasoningEffort")),
        ),
    )

    @Test fun capability_description_precedes_the_assigned_model_card() {
        val base = sampleModelsOverview()
        val overview = base.copy(
            assignmentDisplays = base.assignmentDisplays +
                ("agent" to ModelDisplay("openrouter", "OpenRouter", "reasoner-v1", true, true)),
            inference = base.inference.copy(
                assignments = base.inference.assignments +
                    ("agent" to ResolvedAssignment("http", available = true)),
            ),
            modelControls = mapOf("openrouter/reasoner-v1" to info),
            modelSettings = mapOf("agent" to ModelBehaviorSettings("openrouter/reasoner-v1")),
        )
        val cap = overview.capabilities.first { it.role == "agent" }
        compose.setContent {
            OmnesisTheme {
                ModelPickerContent(
                    cap = cap,
                    overview = overview,
                    currentlyConfigured = true,
                )
            }
        }

        val descriptionTop = compose.onNodeWithText(cap.description).fetchSemanticsNode().boundsInRoot.top
        val cardTop = compose.onNodeWithText("Assigned model").fetchSemanticsNode().boundsInRoot.top
        assertTrue("capability description should be above the assigned-model card", descriptionTop < cardTop)
    }

    @Test fun assigned_model_card_remains_visible_without_configurable_controls() {
        val base = sampleModelsOverview()
        val overview = base.copy(
            assignmentDisplays = base.assignmentDisplays +
                ("agent" to ModelDisplay("northstar", "Northstar", "chat-v1", true, true)),
            inference = base.inference.copy(
                assignments = base.inference.assignments +
                    ("agent" to ResolvedAssignment("http", available = true)),
            ),
            modelControls = emptyMap(),
            modelSettings = mapOf("agent" to ModelBehaviorSettings("northstar/chat-v1")),
        )
        compose.setContent {
            OmnesisTheme {
                ModelPickerContent(
                    cap = overview.capabilities.first { it.role == "agent" },
                    overview = overview,
                    currentlyConfigured = true,
                )
            }
        }

        compose.onNodeWithText("Assigned model").assertExists()
        compose.onNodeWithText("Northstar").assertExists()
        compose.onNodeWithText("Reasoning").assertDoesNotExist()
        compose.onNodeWithText("Reset to model default").assertDoesNotExist()
    }

    @Test fun recently_used_appears_when_history_arrives_after_the_picker_opens() {
        var recent by mutableStateOf(emptyList<RecentModelEntry>())
        val overview = sampleModelsOverview()
        compose.setContent {
            OmnesisTheme {
                ModelPickerContent(
                    cap = overview.capabilities.first { it.role == "agent" },
                    overview = overview,
                    currentlyConfigured = true,
                    recent = recent,
                )
            }
        }

        compose.onNodeWithText("Recently used").assertDoesNotExist()
        compose.runOnIdle {
            recent = listOf(
                RecentModelEntry(
                    assignment = "northstar/llama-vision-8b",
                    providerId = "northstar",
                    providerLabel = "Northstar",
                    modelName = "llama-vision-8b",
                    apply = RecentModelApply(
                        type = "assign",
                        value = "northstar/llama-vision-8b",
                    ),
                ),
            )
        }
        compose.onNodeWithText("Recently used").assertExists()
        compose.onNodeWithText("Use").assertExists()
    }

    @Test fun choosing_a_model_returns_to_the_capability_overview() {
        var chosen: ModelManagement.PickerOption? = null
        val overview = sampleModelsOverview()
        compose.setContent {
            OmnesisTheme {
                ModelPickerContent(
                    cap = overview.capabilities.first { it.role == "agent" },
                    overview = overview,
                    currentlyConfigured = true,
                    previewSelectedBackend = "northstar",
                    onPick = { chosen = it },
                )
            }
        }

        compose.onNodeWithText("Search models…").assertExists()
        compose.onNodeWithTag("model-option-northstar/llama-vision-8b").performClick()
        compose.onNodeWithText("Search models…").assertDoesNotExist()
        compose.onNodeWithText("Add HTTP backend").assertExists()
        compose.runOnIdle { assertEquals("northstar/llama-vision-8b", chosen?.id) }
    }

    @Test fun turning_reasoning_off_disables_effort_and_budget_and_autosaves_cleared_values() {
        var saved: ModelBehaviorValues? = null
        val settings = ModelBehaviorSettings(
            assignment = "openrouter/reasoner-v1",
            values = ModelBehaviorValues(true, "high", 1024),
        )
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, info, onSave = { _, values -> saved = values }) }
        }
        compose.onNodeWithText("Off").performClick()
        compose.onNodeWithText("Reasoning effort").assertExists()
        compose.onNodeWithText("high").assertIsNotEnabled()
        compose.onNodeWithText("Reasoning token budget").assertExists()
        compose.onNodeWithText("Save model behavior").assertDoesNotExist()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(false, null, null), saved) }
    }

    @Test fun choosing_exclusive_effort_clears_the_existing_budget() {
        var saved: ModelBehaviorValues? = null
        val settings = ModelBehaviorSettings(
            assignment = "openrouter/reasoner-v1",
            values = ModelBehaviorValues(true, null, 1024),
        )
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, info, onSave = { _, values -> saved = values }) }
        }
        compose.onNodeWithText("high").performClick()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(true, "high", null), saved) }
    }

    @Test fun selecting_a_toggle_clears_provider_exclusive_effort_and_budget() {
        var saved: ModelBehaviorValues? = null
        val exclusive = info.copy(
            controls = info.controls.map { descriptor ->
                if (descriptor.key == "reasoningEnabled") descriptor.copy(
                    exclusiveWith = listOf("reasoningEffort", "reasoningBudgetTokens"),
                ) else descriptor
            },
        )
        val settings = ModelBehaviorSettings(
            assignment = "google/reasoner-v1",
            values = ModelBehaviorValues(null, "high", 1024),
        )
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, exclusive, onSave = { _, values -> saved = values }) }
        }
        compose.onNodeWithText("On").performClick()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(true, null, null), saved) }
    }

    @Test fun nvidia_no_enforcement_choice_saves_the_native_minus_one_budget() {
        var saved: ModelBehaviorValues? = null
        val nvidia = ModelControlInfo(
            providerId = "nvidia",
            source = "models.dev",
            controls = listOf(ModelControlDescriptor(
                "reasoningBudgetTokens", "integer", "Reasoning token budget", min = -1, max = 8192,
            )),
        )
        val settings = ModelBehaviorSettings(assignment = "nvidia/reasoner-v1")
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, nvidia, onSave = { _, values -> saved = values }) }
        }
        compose.onNodeWithText("No reasoning budget enforcement").performClick()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(reasoningBudgetTokens = -1), saved) }
    }

    @Test fun an_unknown_catalog_model_still_allows_saved_controls_to_be_reset() {
        var saved: ModelBehaviorValues? = null
        val settings = ModelBehaviorSettings(
            assignment = "northstar/retired-reasoner",
            values = ModelBehaviorValues(reasoningEffort = "medium"),
        )
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, null, onSave = { _, values -> saved = values }) }
        }
        compose.onNodeWithText("Some saved reasoning settings", substring = true).assertExists()
        compose.onNodeWithText("Reset to model default").performClick()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(), saved) }
    }

    @Test fun an_unknown_model_without_saved_overrides_has_no_behavior_area() {
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(ModelBehaviorSettings("northstar/unknown-v1"), null) }
        }
        compose.onNodeWithText("Some saved reasoning settings", substring = true).assertDoesNotExist()
        compose.onNodeWithText("Reset to model default").assertDoesNotExist()
        compose.onNodeWithText("Reasoning").assertDoesNotExist()
    }

    @Test fun reasoning_toggle_uses_the_full_model_default_choice() {
        var saved: ModelBehaviorValues? = null
        val toggleOnly = info.copy(controls = listOf(
            ModelControlDescriptor("reasoningEnabled", "boolean", "Reasoning"),
        ))
        compose.setContent {
            OmnesisTheme {
                ModelBehaviorControlsSection(ModelBehaviorSettings("openrouter/reasoner-v1",
                    ModelBehaviorValues(reasoningEnabled = true)), toggleOnly,
                    onSave = { _, values -> saved = values })
            }
        }
        compose.onNodeWithText("Model default").performClick()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(), saved) }
    }

    @Test fun a_retired_effort_value_requires_a_valid_choice_before_autosave() {
        var saved: ModelBehaviorValues? = null
        val settings = ModelBehaviorSettings(
            assignment = "openrouter/reasoner-v1",
            values = ModelBehaviorValues(reasoningEffort = "medium"),
        )
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, info, onSave = { _, values -> saved = values }) }
        }
        compose.onNodeWithText("Some saved reasoning settings", substring = true).assertExists()
        compose.onNodeWithText("Reset to model default").assertDoesNotExist()
        compose.runOnIdle { assertEquals(null, saved) }
        compose.onNodeWithText("low").performClick()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(reasoningEffort = "low"), saved) }
    }

    @Test fun a_removed_saved_control_can_only_be_cleared_with_reset() {
        var saved: ModelBehaviorValues? = null
        val settings = ModelBehaviorSettings(
            assignment = "openrouter/reasoner-v1",
            values = ModelBehaviorValues(reasoningEnabled = true),
        )
        val effortOnly = info.copy(controls = info.controls.filter { it.key == "reasoningEffort" })
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, effortOnly, onSave = { _, values -> saved = values }) }
        }
        compose.onNodeWithText("Some saved reasoning settings", substring = true).assertExists()
        compose.onNodeWithText("low").assertIsNotEnabled()
        compose.runOnIdle { assertEquals(null, saved) }
        compose.onNodeWithText("Reset to model default").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(), saved) }
    }

    @Test fun four_effort_choices_use_one_click_chips_and_save_the_exact_value() {
        var saved: ModelBehaviorValues? = null
        val settings = ModelBehaviorSettings(assignment = "openrouter/reasoner-v1")
        val shortEffort = info.copy(controls = listOf(
            ModelControlDescriptor("reasoningEffort", "enum", "Reasoning effort", listOf("low", "medium", "high")),
        ))
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, shortEffort, onSave = { _, values -> saved = values }) }
        }
        compose.onNodeWithText("medium").assertExists()
        compose.onNodeWithText("medium").performClick()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(reasoningEffort = "medium"), saved) }
    }

    @Test fun a_conflict_refresh_epoch_discards_the_unsaved_local_selection() {
        var epoch by mutableIntStateOf(0)
        val settings = ModelBehaviorSettings("openrouter/reasoner-v1")
        val effortOnly = info.copy(controls = listOf(
            ModelControlDescriptor("reasoningEffort", "enum", "Reasoning effort", listOf("low", "high")),
        ))
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, effortOnly, resetEpoch = epoch) }
        }
        compose.onNodeWithText("high").performClick()
        assertEquals(true, compose.onNodeWithText("high").fetchSemanticsNode().config[SemanticsProperties.Selected])
        compose.runOnIdle { epoch++ }
        assertEquals(true, compose.onNodeWithText("Model default").fetchSemanticsNode().config[SemanticsProperties.Selected])
    }

    @Test fun five_effort_choices_use_a_compact_dropdown() {
        var saved: ModelBehaviorValues? = null
        val settings = ModelBehaviorSettings(assignment = "openrouter/reasoner-v1")
        val longEffort = info.copy(controls = listOf(
            ModelControlDescriptor("reasoningEffort", "enum", "Reasoning effort", listOf("low", "medium", "high", "xhigh")),
        ))
        compose.setContent {
            OmnesisTheme { ModelBehaviorControlsSection(settings, longEffort, onSave = { _, values -> saved = values }) }
        }
        compose.onNodeWithText("xhigh").assertDoesNotExist()
        compose.onNodeWithText("Model default").performClick()
        compose.onNodeWithText("xhigh").performClick()
        compose.runOnIdle { assertEquals(ModelBehaviorValues(reasoningEffort = "xhigh"), saved) }
    }

    @Test fun token_budget_reports_a_valid_draft_for_view_model_debounce() {
        var budgetDraft: ModelBehaviorValues? = null
        val budgetOnly = info.copy(controls = listOf(
            ModelControlDescriptor("reasoningBudgetTokens", "integer", "Reasoning token budget", min = 128, max = 8192),
        ))
        compose.setContent {
            OmnesisTheme {
                ModelBehaviorControlsSection(ModelBehaviorSettings("openrouter/reasoner-v1"), budgetOnly,
                    onBudgetChange = { _, values -> budgetDraft = values })
            }
        }
        compose.onNode(hasSetTextAction()).performTextInput("256")
        compose.runOnIdle { assertEquals(ModelBehaviorValues(reasoningBudgetTokens = 256), budgetDraft) }
    }

    @Test fun gateway_save_error_is_visible_inside_the_editor() {
        compose.setContent {
            OmnesisTheme {
                ModelBehaviorControlsSection(ModelBehaviorSettings("openrouter/reasoner-v1"), info,
                    error = "Save failed: Invalid reasoning settings")
            }
        }
        compose.onNodeWithText("Save failed: Invalid reasoning settings").assertExists()
    }
}
