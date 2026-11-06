// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.transport.dto.*

@Composable
fun AccessHomeScreen(onClose: () -> Unit, onConnect: () -> Unit, vm: AccessManagementViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val gateway = remember(vm) { vm.scopeGateway }
    LaunchedEffect(vm) { vm.refresh() }
    BackHandler { if (state.draft != null) vm.closeEditor() else onClose() }
    AccessHomeContent(state, gateway, onClose = { if (state.draft != null) vm.closeEditor() else onClose() },
        onConnect = onConnect, onEdit = vm::edit, onUpdate = vm::update, onSave = vm::save,
        onReload = { vm.refresh(state.draft != null) }, iconFor = vm::sourceIcon)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AccessHomeContent(
    state: AccessManagementState, gateway: ScopeEditorGateway, onClose: () -> Unit,
    onConnect: () -> Unit = {}, onEdit: (AccessLevelSummary?) -> Unit = {},
    onUpdate: (AccessLevelDraft) -> Unit = {}, onSave: () -> Unit = {}, onReload: () -> Unit = {},
    iconFor: (String) -> dev.omnesis.android.designsystem.components.SourceIconModel = { dev.omnesis.android.designsystem.components.SourceIconModel(fallbackInitial = it.take(1)) },
) {
    Scaffold(topBar = { TopAppBar(title = { Text(if (state.draft == null) "Access" else if (state.draft.id == "new") "New access level" else "Edit access level") },
        navigationIcon = { TextButton(onClick = onClose) { Text("Back") } }, actions = {
            if (state.draft != null) TextButton(onClick = onSave, enabled = state.draft.valid && !state.loading && !state.conflict) { Text("Save") }
        }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.loading) OmSpinner(Modifier.size(24.dp))
            state.error?.let { message ->
                Text(if (state.conflict) "This level changed on the gateway. Your draft is retained. Reload and review before saving." else message,
                    color = MaterialTheme.colorScheme.error)
                TextButton(onClick = onReload) { Text(if (state.conflict) "Reload latest" else "Retry") }
            }
            val overview = state.overview
            if (overview != null) {
                if (state.draft != null) AccessLevelEditorContent(state.draft, overview, gateway, iconFor, onUpdate)
                else {
                    Text("Access levels", style = MaterialTheme.typography.titleMedium)
                    overview.levels.forEach { level ->
                        OutlinedCard(onClick = { onEdit(level) }, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(16.dp)) { Text(level.name); Text("${level.connectionCount} connections", style = MaterialTheme.typography.bodySmall) }
                        }
                    }
                    Button(onClick = { onEdit(null) }) { Text("New access level") }
                    HorizontalDivider()
                    Text("Connections", style = MaterialTheme.typography.titleMedium)
                    overview.principals.filter { it.revokedAt == null }.forEach { principal ->
                        Text(principal.name)
                        principal.grants.filter { it.revokedAt == null }.forEach { grant ->
                            Text(overview.levels.firstOrNull { it.id == grant.levelId }?.name ?: grant.name, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    OutlinedButton(onClick = onConnect) { Text("Connect an agent") }
                }
            }
        }
    }
}

@Composable
internal fun AccessLevelEditorContent(draft: AccessLevelDraft, overview: AccessOverview, gateway: ScopeEditorGateway, iconFor: (String) -> dev.omnesis.android.designsystem.components.SourceIconModel, update: (AccessLevelDraft) -> Unit) {
    var filter by remember { mutableStateOf<Pair<AccessSourceInstance, AccessCapability>?>(null) }
    OutlinedTextField(draft.name, { update(draft.copy(name = it)) }, label = { Text("Access level name") }, modifier = Modifier.fillMaxWidth())
    AccessCapability.entries.forEach { capability ->
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(capability.name.lowercase().replaceFirstChar { it.uppercase() })
            Switch(draft.rule(capability) != null, { update(draft.enabled(capability, it, overview)) })
        }
    }
    if (draft.rule(AccessCapability.ANSWER) != null && draft.rule(AccessCapability.DIRECT) != null) {
        if (draft.id == "new") Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Direct: same as Answer")
            Switch(draft.directSameAsAnswer, { update(draft.withDirectSameAsAnswer(it, overview.sourceFilters?.enabled)) }, enabled = draft.directSameAsAnswer || draft.canCopyAnswer(overview.sourceFilters?.enabled))
        } else {
            OutlinedButton(onClick = { update(draft.copyAnswer(overview.sourceFilters?.enabled)) }, enabled = draft.canCopyAnswer(overview.sourceFilters?.enabled)) { Text("Copy Answer settings to Direct") }
            Text("Copies sources and filters once. Later changes stay separate.", style = MaterialTheme.typography.bodySmall)
        }
    }
    if (overview.sourceFilters?.enabled != true && draft.rules.any { it.scopePolicies.isNotEmpty() }) {
        Text("Saved filters are read-only while filter editing is unavailable. You can still revoke capabilities.", style = MaterialTheme.typography.bodySmall)
    }
    listOf(AccessCapability.ANSWER, AccessCapability.DIRECT).forEach { capability ->
        val rule = draft.rule(capability)
        if (rule != null && !(capability == AccessCapability.DIRECT && draft.directSameAsAnswer && draft.rule(AccessCapability.ANSWER) != null)) {
            HorizontalDivider()
            val known = overview.sources.filter { it.available }.mapTo(mutableSetOf()) { it.id }
            SourceRuleEditor("${capability.name.lowercase().replaceFirstChar { it.uppercase() }} sources",
                if (capability == AccessCapability.ANSWER) AccessSourceScope.ANSWER else AccessSourceScope.DIRECT,
                overview.sources, AccessSourceSelectionState.from(rule.sources, known),
                iconFor,
                canUpdate = { draft.canSetBoundary(it.boundary(known), capability, overview.sourceFilters?.enabled) },
            ) { selection ->
                update(draft.setBoundary(selection.boundary(known), capability, overview.sourceFilters?.enabled))
            }
            (overview.sources + rule.scopePolicies.filter { p -> overview.sources.none { it.id == p.sourceId } }.map { AccessSourceInstance(it.sourceId, it.sourceId, available = false) }).filter { (overview.sourceFilters?.enabled == true && AccessSourceSelectionState.from(rule.sources, known).allows(it.id) && it.scopes != null) || rule.scopePolicies.any { p -> p.sourceId == it.id } }.forEach { source ->
                TextButton(onClick = { filter = source to capability }) {
                    Text("Filter ${source.name}: ${if (rule.scopePolicies.any { it.sourceId == source.id }) "Filtered" else "All content"}")
                }
            }
        }
    }
    draft.rule(AccessCapability.ANSWER)?.let { answer ->
        HorizontalDivider()
        Text("Privacy for Answer", style = MaterialTheme.typography.titleMedium)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Review answers with a privacy policy", modifier = Modifier.weight(1f))
            Switch(draft.requireAnswerPolicySelection || answer.release?.mode == AccessAnswerReleaseMode.REVIEWED, { reviewed ->
                val family = overview.defaultPolicyFamilyId ?: overview.policyFamilies.firstOrNull()?.id
                if (!reviewed || family != null) update(draft.setRule(answer.copy(release = if (reviewed) AccessAnswerRelease.reviewed(family!!) else AccessAnswerRelease.unreviewed())).copy(requireAnswerPolicySelection = false))
            })
        }
        if (draft.requireAnswerPolicySelection) Text("Choose a published privacy policy, or explicitly turn off review.", color = MaterialTheme.colorScheme.error)
        if (answer.release?.mode == AccessAnswerReleaseMode.REVIEWED || draft.requireAnswerPolicySelection) overview.policyFamilies.forEach { family ->
            Row { RadioButton(answer.release?.policyFamilyId == family.id, { update(draft.setRule(answer.copy(release = AccessAnswerRelease.reviewed(family.id))).copy(requireAnswerPolicySelection = false)) }); Text(family.name) }
        } else Text("No privacy reviewer checks these answers.", color = MaterialTheme.colorScheme.error)
    }
    overview.levels.firstOrNull { it.id == draft.id }?.let { Text("Saving changes access for ${it.connectionCount} connections using this level.") }
    filter?.let { (source, capability) ->
        SourceFilterEditor(source, draft.id, capability.name.lowercase(), draft.rule(capability)?.scopePolicies?.firstOrNull { it.sourceId == source.id },
            overview.sourceFilters?.enabled == true, gateway, onClose = { filter = null }) { policy ->
            update(draft.setPolicy(policy, source.id, capability)); filter = null
        }
    }
}
