// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import dev.omnesis.android.transport.dto.ModelControlInfo

/** Short capability-card summary of catalog-backed controls and saved values. */
internal object ModelBehaviorPresentation {
    private val BEHAVIOR_ROLES = setOf(
        "agent", "privacy-reviewer", "background-agent", "watch-judge", "entailment-verifier", "brief-judge",
    )

    fun supportsRole(role: String): Boolean = role in BEHAVIOR_ROLES

    fun supportsAssignment(role: String, kind: String?): Boolean =
        supportsRole(role) && kind in setOf("http", "codex")

    fun hasSavedOverrides(settings: ModelBehaviorSettings?): Boolean = settings?.values?.let { values ->
        values.reasoningEnabled != null || values.reasoningEffort != null || values.reasoningBudgetTokens != null
    } ?: false

    /** An absent control cannot be replaced through the editor; only Reset may clear its saved value. */
    fun hasRemovedOverrides(settings: ModelBehaviorSettings?, info: ModelControlInfo?): Boolean {
        val values = settings?.values ?: return false
        val keys = info?.controls.orEmpty().map { it.key }.toSet()
        return (values.reasoningEnabled != null && "reasoningEnabled" !in keys) ||
            (values.reasoningEffort != null && "reasoningEffort" !in keys) ||
            (values.reasoningBudgetTokens != null && "reasoningBudgetTokens" !in keys)
    }

    /** Saved values can outlive a catalog refresh and must remain clearable. */
    fun hasUnavailableOverrides(settings: ModelBehaviorSettings?, info: ModelControlInfo?): Boolean {
        if (!hasSavedOverrides(settings)) return false
        val values = settings?.values ?: return false
        val descriptors = info?.controls.orEmpty().associateBy { it.key }
        val effort = descriptors["reasoningEffort"]
        val budget = descriptors["reasoningBudgetTokens"]
        if (hasRemovedOverrides(settings, info)) return true
        val savedEffort = values.reasoningEffort
        if (savedEffort != null && (effort == null || savedEffort !in effort.values)) return true
        values.reasoningBudgetTokens?.let { tokens ->
            if (budget == null) return true
            val min = budget.min
            val max = budget.max
            if ((tokens == -1 && min != -1) ||
                (tokens < 0 && tokens != -1) ||
                (tokens >= 0 && min != null && min != -1 && tokens < min) ||
                (max != null && tokens > max)) return true
        }
        val active = buildSet {
            if (values.reasoningEnabled != null) add("reasoningEnabled")
            if (values.reasoningEffort != null) add("reasoningEffort")
            if (values.reasoningBudgetTokens != null) add("reasoningBudgetTokens")
        }
        return (values.reasoningEnabled == false && active.size > 1) ||
            descriptors.values.any { it.key in active && it.exclusiveWith.any(active::contains) }
    }

    fun summary(settings: ModelBehaviorSettings?, info: ModelControlInfo?): String? {
        if (settings?.assignment.isNullOrBlank() || info?.controls.isNullOrEmpty()) return null
        val values = settings.values
        val keys = info.controls.map { it.key }.toSet()
        if ("reasoningEnabled" in keys && values.reasoningEnabled == false) return "Reasoning off"
        val pieces = buildList {
            if ("reasoningEnabled" in keys && values.reasoningEnabled == true) add("Reasoning on")
            if ("reasoningEffort" in keys) values.reasoningEffort?.takeIf { it.isNotBlank() }?.let { add("Effort $it") }
            if ("reasoningBudgetTokens" in keys) values.reasoningBudgetTokens?.let { budget ->
                add(if (budget == -1 && info.controls.any { it.key == "reasoningBudgetTokens" && it.min == -1 }) {
                    "No reasoning budget enforcement"
                } else "Budget $budget tokens")
            }
        }
        return pieces.joinToString(" · ").ifBlank { "Reasoning options available" }
    }
}
