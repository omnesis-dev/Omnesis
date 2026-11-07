// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlin.coroutines.coroutineContext

@Composable
internal fun SourceFilterPicker(
    source: AccessSourceInstance, gateway: ScopeEditorGateway, onClose: () -> Unit,
    capability: String = "answer", initialSelection: List<ScopeRef> = emptyList(),
    state: SourceFilterPickerState? = null, onBack: (() -> Unit)? = null,
    onSelectionChange: ((List<ScopeRef>) -> Unit)? = null, selected: (List<ScopeRef>) -> Unit,
) {
    val compact = WindowInsets.ime.getBottom(LocalDensity.current) > 0 || LocalDensity.current.fontScale > 1.3f
    val session = remember(gateway) { if (gateway is ScopePreviewSession) gateway else ScopePreviewSession(gateway) }
    val labels by session.labels.collectAsState()
    fun label(ref: ScopeRef) = labels[source.id to ref] ?: ref.label
    val picker = remember(source.id, capability) { state ?: SourceFilterPickerState(source.scopes?.items?.firstOrNull()?.kind ?: "participant", source.scopes?.items?.firstOrNull { it.kind == "participant" }?.identifiers?.firstOrNull().orEmpty()) }
    var refs by remember(source.id, capability) { mutableStateOf(initialSelection) }
    var managing by remember { mutableStateOf(false) }
    val kinds = (source.scopes ?: picker.options?.scopes)?.items.orEmpty()
    val declaration = kinds.firstOrNull { it.kind == picker.kind }
    val ready = (picker.options?.readiness ?: source.scopeReadiness.orEmpty()).firstOrNull { it.kind == picker.kind }?.ready == true
    fun setRefs(value: List<ScopeRef>) { refs = value; onSelectionChange?.invoke(value) }
    fun toggle(ref: ScopeRef) { setRefs(if (ref in refs) refs - ref else refs + ref) }
    fun back() { if (picker.enteringIdentifier) picker.enteringIdentifier = false else (onBack ?: onClose)() }
    val typedId = picker.identifierType.takeIf { it in declaration?.identifiers.orEmpty() }?.let { scopeTypedIdentifier(picker.typed, it) }
    val duplicate = typedId != null && refs.any { typedId in it.identifiers.orEmpty() }
    val withinLimits = ScopePolicy.empty(source.id, "new", capability).copy(rules = listOf(ScopeRule(refs, "hide"))).withinLimits
    fun addIdentifier() {
        if (ready && typedId != null && !duplicate) {
            setRefs(refs + ScopeRef("participant", label = typedId.value, identifiers = listOf(typedId)))
            picker.typed = ""; picker.enteringIdentifier = false
        }
    }
    LaunchedEffect(picker.kind, declaration?.identifiers) {
        if (picker.identifierType !in declaration?.identifiers.orEmpty()) picker.identifierType = declaration?.identifiers?.firstOrNull().orEmpty()
    }
    LaunchedEffect(session, picker.kind, picker.query, picker.parent, picker.cursor, picker.retry) {
        val location = Triple(picker.kind, picker.query, picker.parent)
        if (picker.location != location) {
            picker.options = null; picker.location = location
            if (picker.listState.firstVisibleItemIndex != 0 || picker.listState.firstVisibleItemScrollOffset != 0) picker.listState.scrollToItem(0)
        }
        val token = Any(); picker.request = token; picker.loading = true
        try {
            val value = session.options(source.id, picker.kind, picker.query, picker.parent, picker.cursor)
            coroutineContext.ensureActive()
            if (picker.request !== token) return@LaunchedEffect
            picker.options = if (picker.cursor == null) value else value.copy(items = (picker.options?.items.orEmpty() + value.items).distinctBy { it.ref })
            picker.error = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { coroutineContext.ensureActive(); picker.error = accessManagementError(error) }
        finally { if (picker.request === token) picker.loading = false }
    }
    Dialog(onDismissRequest = ::back, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            AccessTaskScaffold(
                title = if (compact && !picker.enteringIdentifier) "${capability.replaceFirstChar { it.uppercase() }} · ${source.name}" else "${capability.replaceFirstChar { it.uppercase() }} filter",
                question = if (picker.enteringIdentifier) "Enter an exact identifier" else "Choose matches",
                description = source.name + source.accountLabel()?.let { " · $it" }.orEmpty(),
                progress = if (picker.enteringIdentifier) "Exact identifier" else "Step 2 of 3",
                primary = if (picker.enteringIdentifier) "Add this identifier" else "Review filter",
                enabled = if (picker.enteringIdentifier) ready && typedId != null && !duplicate else refs.isNotEmpty() && withinLimits,
                onPrimary = { if (picker.enteringIdentifier) addIdentifier() else selected(refs) },
                onBack = ::back, onCancel = onClose, scrollable = picker.enteringIdentifier, compactHeader = compact && !picker.enteringIdentifier,
            ) {
                if (picker.enteringIdentifier) {
                    declaration?.identifiers.orEmpty().takeIf { it.size > 1 }?.let { types ->
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            types.forEach { type -> FilterChip(selected = picker.identifierType == type, onClick = { picker.identifierType = type; picker.typed = "" }, label = { Text(identifierTitle(type)) }) }
                        }
                    }
                    OutlinedTextField(picker.typed, { picker.typed = it }, label = { Text(identifierTitle(picker.identifierType)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Text(when {
                        duplicate -> "This identifier is already selected."
                        typedId != null -> "Matches ${typedId.type}: ${typedId.value}"
                        picker.typed.isNotBlank() -> "Enter a valid ${picker.identifierType} identifier."
                        picker.identifierType == "phone" -> "Include the international country code."
                        else -> "Only this exact identifier will be added."
                    }, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (!ready) AccessNotice("These filter facts are still being prepared. You can return to the choices without losing your selection.")
                } else {
                    if (kinds.size > 1) Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        kinds.forEach { item -> FilterChip(selected = picker.kind == item.kind, onClick = { picker.chooseKind(item.kind) }, label = { Text(scopeKindTitle(item.kind, source)) }) }
                    }
                    OutlinedTextField(picker.query, { picker.query = it; picker.cursor = null }, label = { Text("Search ${scopeKindTitle(picker.kind, source).lowercase()}") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("${refs.size} selected", style = MaterialTheme.typography.bodyLarge)
                        TextButton(onClick = { managing = true }, enabled = refs.isNotEmpty(), modifier = Modifier.defaultMinSize(minHeight = 48.dp)) { Text("Manage selection") }
                    }
                    if (refs.isNotEmpty()) Text(refs.take(2).joinToString(" · ") { ref ->
                        label(ref) ?: ref.identifiers?.joinToString { it.value } ?: "${scopeKindTitle(ref.kind, source)} · saved selection"
                    } + if (refs.size > 2) " · +${refs.size - 2} more" else "", maxLines = 1,
                        overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (!withinLimits) Text("Choose at most 256 identifiers or items. Remove some from Manage selection.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.error)
                    if (declaration?.picker == "tree") {
                        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { picker.goToAncestor(-1) }) { Text("All folders") }
                            picker.ancestors.forEachIndexed { index, folder ->
                                Text("›", style = MaterialTheme.typography.bodyLarge)
                                TextButton(onClick = { picker.goToAncestor(index) }) { Text(folder.label) }
                            }
                        }
                        Text("Selected folders include subfolders. Moving records can change access.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (picker.kind == "participant" && !declaration?.identifiers.isNullOrEmpty()) TextButton(onClick = { picker.enteringIdentifier = true }, modifier = Modifier.defaultMinSize(minHeight = 48.dp)) { Text("Enter an exact identifier instead") }
                    if (!ready && !picker.loading) Text(picker.options?.readiness?.firstOrNull { it.kind == picker.kind }?.message ?: "These filter facts are being prepared. Existing selections are preserved.", style = MaterialTheme.typography.bodyLarge)
                    picker.error?.let { Text(it, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.error); TextButton(onClick = { picker.retry++ }) { Text("Retry choices") } }
                    if (picker.loading) OmSpinner(Modifier.size(24.dp))
                    LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = picker.listState, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        items(picker.options?.items.orEmpty(), key = { it.ref.toString() }) { item ->
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Row(Modifier.weight(1f).toggleable(value = item.ref in refs, enabled = ready, role = Role.Checkbox, onValueChange = { toggle(item.ref) })
                                    .padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    Checkbox(item.ref in refs, onCheckedChange = null, enabled = ready)
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        Text(item.label, style = MaterialTheme.typography.bodyLarge)
                                        Text("${item.count} matching records", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                }
                                if (item.hasChildren == true) IconButton(onClick = { picker.open(item) }, modifier = Modifier.size(48.dp).semantics { contentDescription = "Open ${item.label}" }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) }
                            }
                            HorizontalDivider()
                        }
                        if (!picker.loading && picker.error == null && picker.options?.items.isNullOrEmpty()) item { Text("No matches. Try another search.", style = MaterialTheme.typography.bodyLarge) }
                        picker.options?.nextCursor?.let { next -> item { OutlinedButton(onClick = { picker.cursor = next }, enabled = !picker.loading, modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 48.dp)) { Text("Load more") } } }
                    }
                }
            }
        }
    }
    if (managing) AlertDialog(onDismissRequest = { managing = false }, title = { Text("Selected matches") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("${capability.replaceFirstChar { it.uppercase() }} · ${source.name}" + source.accountLabel()?.let { " · $it" }.orEmpty(), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            refs.forEach { ref -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label(ref) ?: ref.identifiers?.joinToString { it.value } ?: "${scopeKindTitle(ref.kind, source)} · saved selection", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                TextButton(onClick = { setRefs(refs - ref) }, modifier = Modifier.defaultMinSize(minHeight = 48.dp)) { Text("Remove") }
            } }
        } }, confirmButton = { TextButton(onClick = { managing = false }) { Text("Back to choices") } })
}

private fun identifierTitle(type: String): String = when (type) {
    "phone" -> "International phone number"
    "email" -> "Email address"
    "domain" -> "Email domain"
    else -> "Identifier"
}
