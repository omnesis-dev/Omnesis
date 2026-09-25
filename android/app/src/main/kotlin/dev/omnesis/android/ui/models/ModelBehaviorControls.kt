// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.ModelControlInfo

/** Provider-specific controls for the capability's currently assigned model. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ModelBehaviorControlsSection(
    settings: ModelBehaviorSettings?,
    info: ModelControlInfo?,
    busy: Boolean = false,
    error: String? = null,
    status: String? = null,
    resetEpoch: Int = 0,
    onSave: (String, ModelBehaviorValues) -> Unit = { _, _ -> },
    onBudgetChange: (String, ModelBehaviorValues?) -> Unit = { _, _ -> },
) {
    val assignment = settings?.assignment?.takeIf { it.isNotBlank() } ?: return
    val c = OmTheme.colors
    val controls = info?.controls.orEmpty()
    val hasSavedOverrides = ModelBehaviorPresentation.hasSavedOverrides(settings)
    if (controls.isEmpty() && !hasSavedOverrides) return
    val hasRemovedOverrides = ModelBehaviorPresentation.hasRemovedOverrides(settings, info)
    val hasUnavailableOverrides = ModelBehaviorPresentation.hasUnavailableOverrides(settings, info)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        if (error != null) {
            Text(error, style = MaterialTheme.typography.bodySmall, color = c.danger)
        } else if (status != null) {
            Text(status, style = MaterialTheme.typography.labelSmall, color = c.textSecondary)
        }
        if (hasUnavailableOverrides) {
            Text(
                if (hasRemovedOverrides) {
                    "Some saved reasoning settings are no longer offered by this model. Reset to model default to clear them."
                } else {
                    "Some saved reasoning settings are no longer offered by this model. Choose a valid setting or model default to clear them."
                },
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
        }
        if (controls.isEmpty()) {
            if (hasRemovedOverrides) ResetModelBehaviorButton(busy) {
                onSave(assignment, ModelBehaviorValues())
            }
            return@Column
        }
        var enabled by remember(assignment, resetEpoch, settings.values.reasoningEnabled) {
            mutableStateOf(settings.values.reasoningEnabled)
        }
        var effort by remember(assignment, resetEpoch, settings.values.reasoningEffort) {
            mutableStateOf(settings.values.reasoningEffort)
        }
        var budgetText by remember(assignment, resetEpoch, settings.values.reasoningBudgetTokens) {
            mutableStateOf(settings.values.reasoningBudgetTokens?.toString().orEmpty())
        }
        val controlsEnabled = !busy && !hasRemovedOverrides
        val keys = controls.map { it.key }.toSet()
        val budgetDescriptor = controls.firstOrNull { it.key == "reasoningBudgetTokens" }
        fun budgetIsValid(): Boolean {
            val budget = budgetText.toIntOrNull()
            val min = budgetDescriptor?.min
            val max = budgetDescriptor?.max
            return budgetDescriptor == null || budgetText.isEmpty() ||
                (budget == -1 && min == -1) ||
                (budget != null && budget >= 0 &&
                    (min == null || min == -1 || budget >= min) &&
                    (max == null || budget <= max))
        }
        fun draftValues() = ModelBehaviorValues(
            reasoningEnabled = enabled.takeIf { "reasoningEnabled" in keys },
            reasoningEffort = effort.takeIf { enabled != false && "reasoningEffort" in keys },
            reasoningBudgetTokens = budgetText.toIntOrNull().takeIf { enabled != false && "reasoningBudgetTokens" in keys },
        )
        fun validDraft(): ModelBehaviorValues? {
            val values = draftValues()
            return values.takeIf { budgetIsValid() && !hasRemovedOverrides &&
                !ModelBehaviorPresentation.hasUnavailableOverrides(settings.copy(values = values), info) }
        }
        fun saveValidDraft() { validDraft()?.let { onSave(assignment, it) } }
        controls.forEach { descriptor ->
            when (descriptor.key) {
                "reasoningEnabled" -> {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                        Text(descriptor.label, style = MaterialTheme.typography.bodyMedium,
                            color = c.textPrimary, modifier = Modifier.widthIn(max = 130.dp))
                        FlowRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf(null to "Model default", true to "On", false to "Off").forEach { (value, label) ->
                                FilterChip(
                                    selected = enabled == value,
                                    onClick = {
                                        enabled = value
                                        if (value == false) {
                                            effort = null
                                            budgetText = ""
                                        } else if (value == true) {
                                            if ("reasoningEffort" in descriptor.exclusiveWith) effort = null
                                            if ("reasoningBudgetTokens" in descriptor.exclusiveWith) budgetText = ""
                                        }
                                        saveValidDraft()
                                    },
                                    enabled = controlsEnabled,
                                    label = { Text(label) },
                                )
                            }
                        }
                    }
                }
                "reasoningEffort" -> {
                    val choices = listOf(null to "Model default") + descriptor.values.map { it to it }
                    fun selectEffort(value: String?) {
                        effort = value
                        if (value != null && "reasoningBudgetTokens" in descriptor.exclusiveWith) budgetText = ""
                        if (value != null && "reasoningEnabled" in descriptor.exclusiveWith) enabled = null
                        saveValidDraft()
                    }
                    if (choices.size <= 4) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                            Text(descriptor.label, style = MaterialTheme.typography.bodyMedium,
                                color = if (enabled == false) c.textSecondary else c.textPrimary,
                                modifier = Modifier.widthIn(max = 130.dp))
                            FlowRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                choices.forEach { (value, label) ->
                                    FilterChip(
                                        selected = effort == value,
                                        onClick = { selectEffort(value) },
                                        enabled = controlsEnabled && enabled != false,
                                        label = { Text(label) },
                                    )
                                }
                            }
                        }
                    } else {
                        var expanded by remember(assignment, descriptor.key) { mutableStateOf(false) }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                            Text(descriptor.label, style = MaterialTheme.typography.bodyMedium,
                                color = if (enabled == false) c.textSecondary else c.textPrimary,
                                modifier = Modifier.weight(1f))
                            Box {
                                OutlinedButton(
                                    onClick = { expanded = true },
                                    enabled = controlsEnabled && enabled != false,
                                    modifier = Modifier.widthIn(max = 160.dp).heightIn(min = 32.dp),
                                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                                    colors = ButtonDefaults.outlinedButtonColors(contentColor = c.textPrimary),
                                ) {
                                    Text(choices.firstOrNull { it.first == effort }?.second ?: "Choose value",
                                        style = MaterialTheme.typography.labelMedium,
                                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Icon(Icons.Default.ArrowDropDown, contentDescription = null,
                                        modifier = Modifier.size(18.dp))
                                }
                                DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                                    choices.forEach { (value, label) ->
                                        DropdownMenuItem(text = { Text(label) }, onClick = {
                                            expanded = false
                                            selectEffort(value)
                                        })
                                    }
                                }
                            }
                        }
                    }
                }
                "reasoningBudgetTokens" -> {
                    Text(descriptor.label, style = MaterialTheme.typography.bodyMedium,
                        color = if (enabled == false) c.textSecondary else c.textPrimary)
                    if (descriptor.min == -1) {
                        FilterChip(
                            selected = budgetText == "-1",
                            onClick = {
                                budgetText = if (budgetText == "-1") "" else "-1"
                                if (budgetText == "-1" && "reasoningEffort" in descriptor.exclusiveWith) effort = null
                                if (budgetText == "-1" && "reasoningEnabled" in descriptor.exclusiveWith) enabled = null
                                saveValidDraft()
                            },
                            enabled = controlsEnabled && enabled != false,
                            label = { Text("No reasoning budget enforcement") },
                        )
                    }
                    OutlinedTextField(
                        value = budgetText.takeUnless { it == "-1" }.orEmpty(),
                        onValueChange = { candidate ->
                            if (candidate.isEmpty() || candidate.all(Char::isDigit)) {
                                budgetText = candidate
                                if (candidate.isNotEmpty() && "reasoningEffort" in descriptor.exclusiveWith) effort = null
                                if (candidate.isNotEmpty() && "reasoningEnabled" in descriptor.exclusiveWith) enabled = null
                                onBudgetChange(assignment, validDraft())
                            }
                        },
                        enabled = controlsEnabled && enabled != false && budgetText != "-1",
                        label = { Text("Tokens (blank uses model default)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    val range = listOfNotNull(
                        descriptor.min?.takeIf { it >= 0 }?.let { "minimum $it" },
                        descriptor.max?.let { "maximum $it" },
                    ).joinToString(" · ")
                    if (range.isNotEmpty()) Text(range, style = MaterialTheme.typography.labelSmall, color = c.textSecondary)
                }
            }
        }
        if (!budgetIsValid()) {
            Text("Enter a token budget within the available range.", color = c.danger, style = MaterialTheme.typography.labelSmall)
        }
        if (hasRemovedOverrides) ResetModelBehaviorButton(busy) {
            enabled = null
            effort = null
            budgetText = ""
            onSave(assignment, ModelBehaviorValues())
        }
    }
}

@Composable
private fun ResetModelBehaviorButton(
    busy: Boolean,
    onReset: () -> Unit,
) {
    TextButton(
        onClick = onReset,
        enabled = !busy,
    ) { Text("Reset to model default") }
}
