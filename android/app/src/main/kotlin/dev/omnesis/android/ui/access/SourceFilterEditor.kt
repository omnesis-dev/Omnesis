// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.layout.*
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

internal enum class SourceFilterBoundary { ALL, ONLY, EXCEPT }
private enum class SourceFilterStage { MODE, MATCHES, REVIEW }

@Composable
fun SourceFilterEditor(
    source: AccessSourceInstance, levelId: String, capability: String, initialPolicy: ScopePolicy?,
    authoringEnabled: Boolean, gateway: ScopeEditorGateway, onClose: () -> Unit,
    initialPreview: ScopePreview? = null, changed: (ScopePolicy?) -> Unit,
) {
    val session = remember(gateway) { if (gateway is ScopePreviewSession) gateway else ScopePreviewSession(gateway) }
    var policy by remember(source.id, levelId, capability) { mutableStateOf((initialPolicy ?: ScopePolicy.empty(source.id, levelId, capability)).copy(audience = ScopeAudience(levelId, capability))) }
    val declared = source.scopes?.items.orEmpty().map { it.kind }.toSet()
    val writable = authoringEnabled && source.available && source.scopes != null && policy.editable &&
        (initialPolicy == null || (initialPolicy.sourceId == source.id && initialPolicy.rules.flatMap { it.match }.all { it.kind in declared }))
    var boundary by remember(source.id, levelId, capability) { mutableStateOf(when {
        initialPolicy == null || (initialPolicy.editable && initialPolicy.rules.single().match.isEmpty() && initialPolicy.otherwise == "share") -> SourceFilterBoundary.ALL
        initialPolicy.rules.firstOrNull()?.action == "share" -> SourceFilterBoundary.ONLY
        else -> SourceFilterBoundary.EXCEPT
    }) }
    var stage by remember(source.id, levelId, capability) { mutableStateOf(if (writable) SourceFilterStage.MODE else SourceFilterStage.REVIEW) }
    var preview by remember(session, source.id, capability) { mutableStateOf(initialPreview?.takeIf { it.sourceId == source.id }) }
    var previewedPolicy by remember(session, source.id, capability) { mutableStateOf<ScopePolicy?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    var request by remember { mutableStateOf<Any?>(null) }
    val picker = remember(source.id, capability) { SourceFilterPickerState(source.scopes?.items?.firstOrNull()?.kind ?: "participant", source.scopes?.items?.firstOrNull { it.kind == "participant" }?.identifiers?.firstOrNull().orEmpty()) }
    val refs = policy.rules.firstOrNull()?.match.orEmpty()
    fun setRefs(value: List<ScopeRef>) { if (writable) policy = policy.copy(rules = listOf(policy.rules.single().copy(match = value))) }
    fun choose(value: SourceFilterBoundary) {
        if (!writable) return
        boundary = value
        if (value != SourceFilterBoundary.ALL) policy = policy.copy(rules = listOf(ScopeRule(refs, if (value == SourceFilterBoundary.ONLY) "share" else "hide")), otherwise = if (value == SourceFilterBoundary.ONLY) "hide" else "share")
    }
    fun back() {
        stage = when (stage) {
            SourceFilterStage.REVIEW -> if (boundary == SourceFilterBoundary.ALL) SourceFilterStage.MODE else SourceFilterStage.MATCHES
            SourceFilterStage.MATCHES -> SourceFilterStage.MODE
            SourceFilterStage.MODE -> { onClose(); SourceFilterStage.MODE }
        }
    }
    LaunchedEffect(session, policy, stage, boundary, retry) {
        if (stage != SourceFilterStage.REVIEW || (writable && boundary == SourceFilterBoundary.ALL)) return@LaunchedEffect
        val token = Any(); request = token; loading = true; previewedPolicy = null; error = null
        try {
            val value = session.preview(policy)
            coroutineContext.ensureActive()
            if (request === token) { preview = value; previewedPolicy = policy }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) { coroutineContext.ensureActive(); if (request === token) error = accessManagementError(failure) }
        finally { if (request === token) loading = false }
    }
    if (stage == SourceFilterStage.MATCHES && writable) {
        SourceFilterPicker(source, session, onClose, capability, refs, picker, onBack = { stage = SourceFilterStage.MODE },
            onSelectionChange = ::setRefs) { selection -> setRefs(selection); stage = SourceFilterStage.REVIEW }
        return
    }
    val allContent = writable && boundary == SourceFilterBoundary.ALL
    val current = previewedPolicy == policy && preview?.sourceId == source.id
    val readiness = if (current) preview?.readiness.orEmpty() else source.scopeReadiness.orEmpty()
    val ready = policy.readyToSave(readiness)
    val primary = when {
        !writable -> "Close"
        stage == SourceFilterStage.MODE -> "Continue"
        allContent -> "Allow all content"
        else -> "Apply filter"
    }
    Dialog(onDismissRequest = { if (writable) back() else onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            AccessTaskScaffold(
                title = "${capability.replaceFirstChar { it.uppercase() }} filter",
                question = if (stage == SourceFilterStage.MODE) "What can it use from this account?" else if (writable) "Review this filter" else "Saved restriction",
                description = source.name + source.accountLabel()?.let { " · $it" }.orEmpty(),
                progress = if (!writable) null else if (stage == SourceFilterStage.MODE) "Step 1 of 3" else "Step 3 of 3",
                primary = primary,
                enabled = !writable || stage == SourceFilterStage.MODE || allContent || (current && ready && policy.withinLimits && refs.isNotEmpty() && !loading && error == null),
                onPrimary = {
                    when {
                        !writable -> onClose()
                        stage == SourceFilterStage.MODE -> stage = if (boundary == SourceFilterBoundary.ALL) SourceFilterStage.REVIEW else SourceFilterStage.MATCHES
                        allContent -> changed(null)
                        current && ready && policy.withinLimits && refs.isNotEmpty() && !loading && error == null -> changed(policy)
                    }
                },
                onBack = { if (writable) back() else onClose() }, backLabel = if (stage == SourceFilterStage.MODE || !writable) "Close" else "Back",
                onCancel = if (writable && stage != SourceFilterStage.MODE) onClose else null,
                focusKey = error,
            ) {
                if (stage == SourceFilterStage.MODE) {
                    AccessChoice("All content", if (initialPolicy != null) "Remove the saved restriction and allow all content from this account." else "Allow all content available from this account.", boundary == SourceFilterBoundary.ALL) { choose(SourceFilterBoundary.ALL) }
                    AccessChoice("Only matching content", "Share records matching any item you select.", boundary == SourceFilterBoundary.ONLY) { choose(SourceFilterBoundary.ONLY) }
                    AccessChoice("Everything except matching content", "Keep matching records hidden and share the rest when their required facts are known.", boundary == SourceFilterBoundary.EXCEPT) { choose(SourceFilterBoundary.EXCEPT) }
                } else if (allContent) {
                    Text("All content from this account will be available to $capability.", style = MaterialTheme.typography.titleMedium)
                    if (initialPolicy != null) AccessNotice("This removes the account’s saved restriction. You can go Back to keep a matching filter instead.")
                } else {
                    if (!writable) AccessNotice(if (!policy.editable) "This saved rule uses settings this editor cannot change. The complete restriction is retained." else "Filter editing is unavailable. This saved restriction remains active.")
                    Text(scopePolicySummary(policy, source), style = MaterialTheme.typography.titleMedium)
                    policy.rules.flatMap { it.match }.forEach { ref ->
                        val item = preview?.items?.firstOrNull { it.ref == ref }
                        val label = session.label(source.id, ref) ?: ref.label ?: ref.identifiers?.joinToString { it.value }
                            ?: "${scopeKindTitle(ref.kind, source)} · ${if (item?.missing == true) "no longer available" else "label unavailable"}"
                        Text(label + if (item?.missing == true) " · saved selection retained" else "", style = MaterialTheme.typography.bodyLarge)
                    }
                    if (writable && !policy.withinLimits) AccessNotice("A filter can contain at most 256 identifiers or items. Go Back to remove some selections.", error = true)
                    when {
                        loading || (!current && error == null) -> { OmSpinner(Modifier.size(24.dp)); Text("Checking this exact filter…", style = MaterialTheme.typography.bodyLarge) }
                        error != null -> { AccessNotice(error!!, error = true); TextButton(onClick = { retry++ }) { Text("Retry preview") } }
                        !ready -> {
                            AccessNotice(readiness.filter { !it.ready }.mapNotNull { it.message }.distinct().joinToString("\n").ifBlank { "Required filter facts are still being prepared. Apply becomes available after preparation finishes." })
                            Text("Coverage is not final while preparation is pending.", style = MaterialTheme.typography.bodyLarge)
                            TextButton(onClick = { retry++ }) { Text("Refresh preview") }
                        }
                        current -> preview?.let { FilterCoverage(it, policy, writable, ::setRefs) }
                    }
                    if (!writable && (!policy.editable || policy.rules.size != 1)) AdvancedFilterDetails(policy)
                }
            }
        }
    }
}

@Composable
private fun FilterCoverage(result: ScopePreview, policy: ScopePolicy, writable: Boolean, setRefs: (List<ScopeRef>) -> Unit) {
    HorizontalDivider()
    Text("${result.visible} records available", style = MaterialTheme.typography.headlineSmall)
    Text("${result.hidden} hidden · ${result.unknown} uncertain, included in hidden", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text("Records with uncertain required facts stay hidden in either matching mode.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    var examples by remember { mutableStateOf(false) }
    if (result.samples.isNotEmpty()) {
        TextButton(onClick = { examples = !examples }) { Text(if (examples) "Hide examples" else "Inspect example records") }
        if (examples) result.samples.forEach { sample ->
            Text(sample.title, style = MaterialTheme.typography.bodyLarge)
            Text(if (sample.unknown) "Uncertain · hidden" else if (sample.visible) "Available" else "Hidden", style = MaterialTheme.typography.bodyMedium)
        }
    }
    var extraIdentifiers by remember { mutableStateOf(false) }
    val refs = policy.rules.firstOrNull()?.match.orEmpty()
    val proposals = result.identifierProposals.orEmpty().filter { proposal -> proposal.itemIndex in refs.indices && refs[proposal.itemIndex].kind == "participant" && proposal.identifiers.any { it !in refs[proposal.itemIndex].identifiers.orEmpty() } }
    if (writable && proposals.isNotEmpty()) {
        TextButton(onClick = { extraIdentifiers = !extraIdentifiers }) { Text(if (extraIdentifiers) "Hide additional identifiers" else "Other known identifiers") }
        if (extraIdentifiers) proposals.forEach { proposal ->
            val identifiers = proposal.identifiers.filterNot { it in refs[proposal.itemIndex].identifiers.orEmpty() }
            Text("Additional identifiers for ${proposal.label}", style = MaterialTheme.typography.titleSmall)
            Text(identifiers.joinToString { it.value }, style = MaterialTheme.typography.bodyLarge)
            TextButton(onClick = { setRefs(refs.mapIndexed { index, ref -> if (index == proposal.itemIndex) ref.copy(identifiers = (ref.identifiers.orEmpty() + identifiers).distinct()) else ref }) }) { Text("Add these identifiers") }
        }
    }
}

@Composable
private fun AdvancedFilterDetails(policy: ScopePolicy) {
    var inspect by remember { mutableStateOf(false) }
    TextButton(onClick = { inspect = !inspect }) { Text(if (inspect) "Hide saved rule details" else "Inspect saved rule details") }
    if (inspect) {
        policy.maxAge?.let { Text("Maximum age: $it", style = MaterialTheme.typography.bodyLarge) }
        policy.rules.forEach { rule ->
            Text("${rule.action.replaceFirstChar { it.uppercase() }} matching records", style = MaterialTheme.typography.titleSmall)
            rule.match.forEach { ref -> Text(ref.label ?: ref.identifiers?.joinToString { it.value } ?: "${ref.kind}: ${ref.id.orEmpty()}", style = MaterialTheme.typography.bodyMedium) }
        }
        Text("Otherwise: ${policy.otherwise}", style = MaterialTheme.typography.bodyLarge)
    }
}
