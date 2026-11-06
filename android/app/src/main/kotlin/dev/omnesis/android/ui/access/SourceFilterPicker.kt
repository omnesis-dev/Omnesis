// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SourceFilterPicker(source: AccessSourceInstance, gateway: ScopeEditorGateway, onClose: () -> Unit, selected: (ScopeRef) -> Unit) {
    var kind by remember { mutableStateOf(source.scopes?.items?.firstOrNull()?.kind ?: "participant") }
    var query by remember { mutableStateOf("") }
    var ancestors by remember { mutableStateOf<List<ScopeOption>>(emptyList()) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var options by remember { mutableStateOf<ScopeOptions?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    var identifierType by remember { mutableStateOf(source.scopes?.items?.firstOrNull { it.kind == "participant" }?.identifiers?.firstOrNull() ?: "email") }
    var typed by remember { mutableStateOf("") }
    val declaration = (source.scopes ?: options?.scopes)?.items?.firstOrNull { it.kind == kind }
    val ready = (options?.readiness ?: source.scopeReadiness.orEmpty()).firstOrNull { it.kind == kind }?.ready == true
    LaunchedEffect(declaration?.identifiers) {
        if (identifierType !in declaration?.identifiers.orEmpty()) identifierType = declaration?.identifiers?.firstOrNull() ?: ""
    }
    val parent = ancestors.lastOrNull()?.ref?.id
    LaunchedEffect(kind, query, parent, cursor, refresh) {
        if (cursor == null) options = null
        loading = true
        try {
            val value = gateway.options(source.id, kind, query, parent, cursor)
            coroutineContext.ensureActive()
            options = if (cursor == null) value else value.copy(items = options?.items.orEmpty() + value.items)
            error = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { coroutineContext.ensureActive(); error = accessManagementError(failure) }
        finally { loading = false }
    }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Scaffold(topBar = { TopAppBar(title = { Text("Add item") }, navigationIcon = { TextButton(onClick = onClose) { Text("Cancel") } }) }) { padding ->
                Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    (source.scopes ?: options?.scopes)?.items.orEmpty().forEach { item ->
                        Row { RadioButton(kind == item.kind, { kind = item.kind; ancestors = emptyList(); cursor = null; options = null }); Text(item.noun?.many ?: "People", Modifier.padding(top = 12.dp)) }
                    }
                    OutlinedTextField(query, { query = it; cursor = null }, label = { Text("Search") }, modifier = Modifier.fillMaxWidth())
                    if (!ready) Text(options?.readiness?.firstOrNull { it.kind == kind }?.message ?: "These facts are still being prepared. Try again after preparation finishes.")
                    if (kind == "participant") {
                        Text("Type an identifier", style = MaterialTheme.typography.titleMedium)
                        declaration?.identifiers.orEmpty().forEach { type -> Row {
                            RadioButton(identifierType == type, { identifierType = type }); Text(type.replaceFirstChar { it.uppercase() }, Modifier.padding(top = 12.dp))
                        } }
                        OutlinedTextField(typed, { typed = it }, label = { Text(if (identifierType == "phone") "International phone number" else if (identifierType == "domain") "example.org" else "person@example.org") }, modifier = Modifier.fillMaxWidth())
                        val typedId = if (identifierType in declaration?.identifiers.orEmpty()) scopeTypedIdentifier(typed, identifierType) else null
                        if (typed.isNotEmpty()) Text(typedId?.let { "Matches ${it.type}: ${it.value}" } ?: "Enter a valid $identifierType identifier.", style = MaterialTheme.typography.bodySmall)
                        Button(onClick = { typedId?.let { selected(ScopeRef("participant", label = it.value, identifiers = listOf(it))) } }, enabled = ready && typedId != null) { Text("Add identifier") }
                    }
                    if (declaration?.picker == "tree") {
                        Text("Includes subfolders and files added later.", style = MaterialTheme.typography.bodySmall)
                        if (ancestors.isNotEmpty()) TextButton(onClick = { ancestors = ancestors.dropLast(1); cursor = null }) { Text("Back to parent") }
                    }
                    options?.items.orEmpty().forEach { item -> Row(Modifier.fillMaxWidth()) {
                        TextButton(onClick = { selected(item.ref) }, enabled = ready, modifier = Modifier.weight(1f)) { Column { Text(item.label); Text("${item.count} matching documents", style = MaterialTheme.typography.bodySmall) } }
                        if (item.hasChildren == true) TextButton(onClick = { ancestors = ancestors + item; cursor = null }) { Text("Browse") }
                    } }
                    options?.nextCursor?.let { next -> OutlinedButton(onClick = { cursor = next }, enabled = !loading) { Text("Load more") } }
                    if (loading) OmSpinner(Modifier.size(24.dp))
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = { refresh += 1 }) { Text("Retry") } }
                }
            }
        }
    }
}
