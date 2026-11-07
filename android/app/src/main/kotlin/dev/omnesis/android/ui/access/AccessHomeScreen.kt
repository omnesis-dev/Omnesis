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
        onReload = { vm.refresh(state.draft != null) }, iconFor = vm::sourceIcon, nameFor = vm::sourceName)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AccessHomeContent(
    state: AccessManagementState, gateway: ScopeEditorGateway, onClose: () -> Unit,
    onConnect: () -> Unit = {}, onEdit: (AccessLevelSummary?) -> Unit = {},
    onUpdate: (AccessLevelDraft) -> Unit = {}, onSave: () -> Unit = {}, onReload: () -> Unit = {},
    iconFor: (String) -> dev.omnesis.android.designsystem.components.SourceIconModel = { dev.omnesis.android.designsystem.components.SourceIconModel(fallbackInitial = it.take(1)) },
    nameFor: (String) -> String? = { null },
) {
    if (state.draft != null && state.overview != null) {
        AccessLevelEditor(state, gateway, iconFor, nameFor, onUpdate, onSave, onClose, onReload)
        return
    }
    Scaffold(topBar = { TopAppBar(title = { Text(if (state.draft == null) "Access" else if (state.draft.id == "new") "New access level" else "Edit access level") },
        navigationIcon = { TextButton(onClick = onClose) { Text("Back") } }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (state.loading) OmSpinner(Modifier.size(24.dp))
            state.error?.let { message ->
                Text(if (state.conflict) "This level changed on the gateway. Your draft is retained. Reload and review before saving." else message,
                    color = MaterialTheme.colorScheme.error)
                TextButton(onClick = onReload) { Text(if (state.conflict) "Reload latest" else "Retry") }
            }
            val overview = state.overview
            if (overview != null) {
                run {
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
