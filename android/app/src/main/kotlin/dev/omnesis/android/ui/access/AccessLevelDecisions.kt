// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.*

@Composable
internal fun AccessPermissionsQuestion(draft: AccessLevelDraft, overview: AccessOverview, update: (AccessLevelDraft) -> Unit) {
    listOf(AccessCapability.ANSWER, AccessCapability.DIRECT, AccessCapability.NOTES).forEach { cap ->
        AccessToggleChoice(cap.outcome, cap.explanation, draft.rule(cap) != null) { update(draft.enabled(cap, it, overview)) }
    }
}

@Composable
internal fun AccessDataQuestion(
    draft: AccessLevelDraft, overview: AccessOverview, capability: AccessCapability,
    iconFor: (String) -> SourceIconModel, nameFor: (String) -> String?, update: (AccessLevelDraft) -> Unit,
    session: ScopePreviewSession, filter: (AccessSourceInstance, AccessCapability) -> Unit,
) {
    val rule = draft.rule(capability) ?: return
    val known = draft.knownSourceIds(overview)
    val selection = AccessSourceSelectionState.from(rule.sources, known)
    val retained = (rule.sources.sourceIds + rule.scopePolicies.map { it.sourceId }).filter { id -> overview.sources.none { it.id == id } }.distinct()
    val sources = overview.sources + retained.map { AccessSourceInstance(it, "Unavailable account", available = false) }
    var query by remember(capability) { mutableStateOf("") }
    fun choose(next: AccessSourceSelectionState) { update(draft.setBoundary(next.boundary(known), capability, overview.sourceFilters?.enabled)) }
    fun permitted(next: AccessSourceSelectionState) = draft.canSetBoundary(next.boundary(known), capability, overview.sourceFilters?.enabled)
    if (sources.size > 5) {
        OutlinedTextField(query, { query = it }, enabled = LocalAccessEditingEnabled.current, label = { Text("Search accounts") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            val all = sources.filter { it.available }.fold(selection) { value, source -> value.setAllowed(source.id, true) }
            val none = sources.filter { it.available }.fold(selection) { value, source -> value.setAllowed(source.id, false) }
            TextButton(onClick = { choose(all) }, enabled = LocalAccessEditingEnabled.current && permitted(all)) { Text("Select all") }
            TextButton(onClick = { choose(none) }, enabled = LocalAccessEditingEnabled.current && permitted(none)) { Text("Clear selection") }
        }
    }
    if (sources.isEmpty()) AccessNotice("No source accounts are connected. Connect a source, then return to this draft.")
    sources.filter { query.isBlank() || it.name.contains(query, true) || it.id.contains(query, true) }.forEach { source ->
        val allowed = selection.allows(source.id)
        val policy = rule.scopePolicies.firstOrNull { it.sourceId == source.id }
        val next = selection.setAllowed(source.id, !allowed)
        Surface(shape = MaterialTheme.shapes.medium, tonalElevation = if (allowed) 1.dp else 0.dp) {
            Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f).toggleable(value = allowed, enabled = LocalAccessEditingEnabled.current && source.available && permitted(next), role = Role.Checkbox, onValueChange = { choose(next) })
                        .padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Checkbox(allowed, onCheckedChange = null, enabled = LocalAccessEditingEnabled.current && source.available && permitted(next))
                        SourceIcon(iconFor(source.id), size = 24.dp)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(nameFor(source.id) ?: source.name, style = MaterialTheme.typography.titleMedium)
                            source.accountLabel(nameFor(source.id) ?: source.name)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            Text(if (!allowed) "Not allowed" else scopePolicySummary(policy, source), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (allowed && policy != null) AccessRestrictionNames(policy, source, session)
                            if (!source.available) Text("Unavailable · saved access retained", style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    if ((allowed && overview.sourceFilters?.enabled == true && source.scopes != null) || policy != null) {
                        TextButton(enabled = LocalAccessEditingEnabled.current, onClick = { filter(source, capability) }, modifier = Modifier.defaultMinSize(minHeight = 48.dp).semantics { contentDescription = "Change ${source.name} for ${capability.title}" }) { Text("Change") }
                    }
                }
            }
        }
    }
    if (overview.sourceFilters?.enabled != true && rule.scopePolicies.isNotEmpty()) AccessNotice("Saved filters are read-only while editing is unavailable. They remain enforced. You can still turn off a permission.")
    if (draft.id != "new" && capability == AccessCapability.DIRECT && draft.rule(AccessCapability.ANSWER) != null) {
        HorizontalDivider()
        TextButton(onClick = { update(draft.copyAnswer(overview.sourceFilters?.enabled)) }, enabled = LocalAccessEditingEnabled.current && draft.canCopyAnswer(overview.sourceFilters?.enabled)) { Text("Copy Answer’s data once") }
        Text("Replaces this Direct draft with Answer’s sources and filters. Later changes remain independent.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun AccessDirectQuestion(draft: AccessLevelDraft, overview: AccessOverview, update: (AccessLevelDraft) -> Unit) {
    val answer = draft.rule(AccessCapability.ANSWER) ?: return
    AccessChoice("Use Answer’s data", ruleDataSummary(answer, overview) + ". Sources and filters follow Answer while this new draft is linked.", draft.directSameAsAnswer,
        enabled = draft.directSameAsAnswer || draft.canCopyAnswer(overview.sourceFilters?.enabled)) { update(draft.withDirectSameAsAnswer(true, overview.sourceFilters?.enabled)) }
    AccessChoice("Choose separate data", "Start from Answer’s current boundary, then change Direct independently.", !draft.directSameAsAnswer) { update(draft.withDirectSameAsAnswer(false, overview.sourceFilters?.enabled)) }
}

@Composable
internal fun AccessFutureQuestion(draft: AccessLevelDraft, overview: AccessOverview, update: (AccessLevelDraft) -> Unit) {
    val linked = draft.id == "new" && draft.directSameAsAnswer && draft.rule(AccessCapability.ANSWER) != null && draft.rule(AccessCapability.DIRECT) != null
    val capabilities = if (linked) listOf(AccessCapability.ANSWER) else draft.readingCapabilities
    capabilities.forEach { cap ->
        val rule = draft.rule(cap) ?: return@forEach
        val known = draft.knownSourceIds(overview)
        val value = AccessSourceSelectionState.from(rule.sources, known)
        Text(if (linked) "Answer and Direct" else cap.title, style = MaterialTheme.typography.titleMedium)
        fun set(allowed: Boolean) { if (allowed != value.futureSourcesAllowed) update(draft.setBoundary(value.setFutureSourcesAllowed(allowed, known).boundary(known), cap, overview.sourceFilters?.enabled)) }
        AccessChoice("Keep new sources blocked", "New source accounts stay blocked until you allow them.", !value.futureSourcesAllowed) { set(false) }
        AccessChoice("Allow new sources automatically", "This permission will include accounts you connect later.", value.futureSourcesAllowed) { set(true) }
    }
}

@Composable
internal fun AccessReleaseQuestion(draft: AccessLevelDraft, overview: AccessOverview, update: (AccessLevelDraft) -> Unit) {
    val answer = draft.rule(AccessCapability.ANSWER) ?: return
    val reviewed = draft.requireAnswerPolicySelection || answer.release?.mode == AccessAnswerReleaseMode.REVIEWED
    AccessChoice("Review with a privacy policy", "Release answers only after the selected policy permits them.", reviewed) {
        if (!reviewed) {
            val family = overview.defaultPolicyFamilyId ?: overview.policyFamilies.firstOrNull()?.id
            update(if (family == null) draft.copy(requireAnswerPolicySelection = true) else draft.setRule(answer.copy(release = AccessAnswerRelease.reviewed(family))).copy(requireAnswerPolicySelection = false))
        }
    }
    if (reviewed) {
        if (overview.policyFamilies.isEmpty()) AccessNotice("No published privacy policy is available. Publish one in Privacy, then return to this draft. Automatic release is a separate choice below.")
        else {
            var choosingPolicy by remember { mutableStateOf(false) }
            Box {
                OutlinedButton(enabled = LocalAccessEditingEnabled.current, onClick = { choosingPolicy = true }, modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp)) {
                    Text(overview.policyFamilies.firstOrNull { it.id == answer.release?.policyFamilyId }?.name ?: "Choose a privacy policy")
                }
                DropdownMenu(expanded = choosingPolicy, onDismissRequest = { choosingPolicy = false }) {
                    overview.policyFamilies.forEach { family -> DropdownMenuItem(text = { Text(family.name) }, onClick = {
                        update(draft.setRule(answer.copy(release = AccessAnswerRelease.reviewed(family.id))).copy(requireAnswerPolicySelection = false))
                        choosingPolicy = false
                    }) }
                }
            }
        }
        if (answer.release?.mode == AccessAnswerReleaseMode.REVIEWED && overview.policyFamilies.none { it.id == answer.release?.policyFamilyId }) AccessNotice("The saved privacy policy is unavailable. It is retained until you explicitly choose a different release setting.")
    }
    AccessChoice("Release automatically", "No privacy reviewer checks these answers.", !reviewed) { update(draft.setRule(answer.copy(release = AccessAnswerRelease.unreviewed())).copy(requireAnswerPolicySelection = false)) }
}
