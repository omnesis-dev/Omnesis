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
fun SourceFilterEditor(
    source: AccessSourceInstance, levelId: String, capability: String, initialPolicy: ScopePolicy?,
    authoringEnabled: Boolean, gateway: ScopeEditorGateway, onClose: () -> Unit,
    initialPreview: ScopePreview? = null, changed: (ScopePolicy?) -> Unit,
) {
    var policy by remember(source.id, capability) { mutableStateOf((initialPolicy ?: ScopePolicy.empty(source.id, levelId, capability)).copy(audience = ScopeAudience(levelId, capability))) }
    var preview by remember { mutableStateOf(initialPreview) }
    var previewedPolicy by remember { mutableStateOf(if (initialPreview == null) null else policy) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    val writable = authoringEnabled && policy.editable
    val refs = policy.rules.firstOrNull()?.match.orEmpty()
    val readiness = preview?.readiness ?: source.scopeReadiness.orEmpty()
    val ready = policy.readyToSave(readiness)
    LaunchedEffect(policy, refresh) {
        if (!policy.editable) return@LaunchedEffect
        loading = true
        try {
            val value = gateway.preview(policy)
            coroutineContext.ensureActive()
            preview = value; previewedPolicy = policy; error = null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { coroutineContext.ensureActive(); error = accessManagementError(failure) }
        finally { loading = false }
    }
    fun updateRefs(next: List<ScopeRef>) { policy = policy.copy(rules = listOf(policy.rules.single().copy(match = next))) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Scaffold(topBar = { TopAppBar(title = { Text("Source filter") }, navigationIcon = { TextButton(onClick = onClose) { Text("Cancel") } }, actions = {
                TextButton(onClick = { changed(policy) }, enabled = writable && ready && policy.withinLimits && previewedPolicy == policy && !loading && error == null) { Text("Done") }
            }) }) { padding ->
                Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(source.name, style = MaterialTheme.typography.titleMedium)
                    if (!writable) Text("This saved restriction remains active. Filter editing is unavailable on this gateway.")
                    if (policy.editable) {
                        listOf("share" to "Only these", "hide" to "Everything except these").forEach { (action, label) ->
                            Row {
                                RadioButton(policy.rules.single().action == action, onClick = { policy = policy.copy(rules = listOf(policy.rules.single().copy(action = action)), otherwise = if (action == "share") "hide" else "share") }, enabled = writable)
                                Text(label, Modifier.padding(top = 12.dp))
                            }
                        }
                        Text(if (refs.isEmpty()) if (policy.otherwise == "share") "Shares all content from this source." else "Shares nothing from this source."
                            else "${if (policy.rules.single().action == "share") "Only" else "Everything except"} any item in this list.", style = MaterialTheme.typography.bodySmall)
                    }
                    HorizontalDivider()
                    Text("Selected items", style = MaterialTheme.typography.titleMedium)
                    refs.forEachIndexed { index, ref ->
                        Row(Modifier.fillMaxWidth()) {
                            Column(Modifier.weight(1f)) {
                                val item = preview.takeIf { previewedPolicy == policy }?.items?.getOrNull(index)
                                Text(item?.label ?: ref.label ?: ref.id ?: "Person")
                                ref.identifiers?.let { Text(it.joinToString { id -> id.value }, style = MaterialTheme.typography.bodySmall) }
                                item?.let { Text(if (it.missing == true) "No longer available · saved ID retained" else "${it.count} matching documents", style = MaterialTheme.typography.bodySmall) }
                            }
                            if (writable) TextButton(onClick = { updateRefs(refs.filterIndexed { i, _ -> i != index }) }) { Text("Remove") }
                        }
                    }
                    if (writable) OutlinedButton(onClick = { picking = true }) { Text("Add item") }
                    readiness.filter { !it.ready || !it.behindCollectors.isNullOrEmpty() }.forEach { item ->
                        Text(item.message ?: "Preparing ${item.kind} filters")
                        item.processed?.let { Text("$it processed${item.pending?.let { pending -> ", $pending pending" }.orEmpty()}") }
                        item.behindCollectors.orEmpty().forEach { Text("Update collector: ${it.name}", style = MaterialTheme.typography.bodySmall) }
                    }
                    preview?.let { result ->
                        HorizontalDivider()
                        Text("Preview", style = MaterialTheme.typography.titleMedium)
                        Text("Visible: ${result.visible} · Hidden: ${result.hidden}")
                        Text("Unknown, included in hidden: ${result.unknown}", style = MaterialTheme.typography.bodySmall)
                        Text("Documents with uncertain required facts stay hidden.", style = MaterialTheme.typography.bodySmall)
                        result.samples.forEach { sample ->
                            Text(sample.title)
                            Text(if (sample.unknown) "Unknown · hidden" else if (sample.visible) "Visible" else "Hidden", style = MaterialTheme.typography.bodySmall)
                        }
                        if (writable && previewedPolicy == policy && !loading) result.identifierProposals.orEmpty().forEach { proposal ->
                            Text("Omnesis knows ${proposal.identifiers.size} more ${if (proposal.identifiers.size == 1) "address" else "addresses"} for ${proposal.label}.")
                            Text(proposal.identifiers.joinToString { it.value }, style = MaterialTheme.typography.bodySmall)
                            TextButton(onClick = {
                                if (proposal.itemIndex in refs.indices && refs[proposal.itemIndex].kind == "participant") {
                                    updateRefs(refs.mapIndexed { index, ref -> if (index == proposal.itemIndex) ref.copy(identifiers = (ref.identifiers.orEmpty() + proposal.identifiers).distinct()) else ref })
                                }
                            }) { Text("Add these addresses") }
                        }
                    }
                    if (!policy.withinLimits) Text("A filter can contain at most 256 identifiers or items.", color = MaterialTheme.colorScheme.error)
                    if (loading) OmSpinner(Modifier.size(24.dp))
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton(onClick = { refresh += 1 }) { Text("Retry preview") } }
                    if (writable) TextButton(onClick = { changed(null) }) { Text("Remove filter") }
                }
            }
        }
    }
    if (picking) SourceFilterPicker(source, gateway, onClose = { picking = false }) { ref ->
        if (ref !in refs) updateRefs(refs + ref)
        picking = false
    }
}
