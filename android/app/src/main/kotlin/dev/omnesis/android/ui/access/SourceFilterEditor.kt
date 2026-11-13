// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.CancellationException

internal enum class SourceFilterBoundary { ALL, ONLY, EXCEPT }
private enum class SourceFilterStage { MODE, MATCHES, REVIEW }

/** Carries the filter being edited across a configuration change. */
private val ScopePolicySaver = Saver<ScopePolicy, String>(
    save = { OmnesisJson.encodeToString(ScopePolicy.serializer(), it) },
    restore = { OmnesisJson.decodeFromString(ScopePolicy.serializer(), it) },
)

/**
 * The filter [draft] holds for one account under [capability], opened in the editor below. Every screen that edits a
 * level's filters opens them here; [changed] receives the edited filter, or null for no filter.
 */
@Composable
internal fun AccessLevelFilterEditor(
    draft: AccessLevelDraft, overview: AccessOverview, sourceId: String, capability: AccessCapability, session: ScopePreviewSession,
    navigation: SourceFilterNavigation, iconFor: (String) -> SourceIconModel, nameFor: (String) -> String?, onClose: () -> Unit, changed: (ScopePolicy?) -> Unit,
) {
    val source = overview.sources.firstOrNull { it.id == sourceId } ?: disconnectedAccount(sourceId, nameFor)
    SourceFilterEditor(source, draft.id, capability.wire, draft.rule(capability)?.scopePolicies?.firstOrNull { it.sourceId == source.id },
        overview.sourceFilters?.enabled == true, session, onClose = onClose, navigation = navigation.of(source, capability),
        icon = accessSourceIcon(source, iconFor), nameFor = nameFor, changed = changed)
}

/**
 * One account’s filter for one capability, in three steps: what to share, which content matches, and a
 * review of the result. A filter whose account is no longer connected, or no longer offers what the filter
 * matches, opens on its review, where saved items can be removed but none added. A filter this editor
 * cannot author, or any filter while editing is switched off, is shown as saved and only closed.
 */
@Composable
internal fun SourceFilterEditor(
    source: AccessSourceInstance, levelId: String, capability: String, initialPolicy: ScopePolicy?,
    authoringEnabled: Boolean, gateway: ScopeEditorGateway, onClose: () -> Unit,
    navigation: SourceFilterPickerState? = null, icon: SourceIconModel = SourceIconModel(),
    nameFor: (String) -> String? = { null }, changed: (ScopePolicy?) -> Unit,
) {
    val colors = AccessUi.colors
    val session = remember(gateway) { gateway.previewSession() }
    // Names arrive with the previews and choices this session reads; a row shows its name as soon as one does.
    val names by session.labels.collectAsState()
    var policy by rememberSaveable(source.id, levelId, capability, stateSaver = ScopePolicySaver) { mutableStateOf((initialPolicy ?: ScopePolicy.empty(source.id, levelId, capability)).copy(audience = ScopeAudience(levelId, capability))) }
    val declared = source.scopes?.items.orEmpty().map { it.kind }.toSet()
    // The owner can always keep or trim a filter this editor can express. Items can be added only
    // while the account is connected and still declares every kind the filter uses.
    val writable = authoringEnabled && policy.editable
    val pickable = writable && source.available && source.scopes != null &&
        (initialPolicy == null || (initialPolicy.sourceId == source.id && initialPolicy.rules.flatMap { it.match }.all { it.kind in declared }))
    val removeOnly = writable && !pickable
    val savedBoundary = when {
        initialPolicy == null || (initialPolicy.editable && initialPolicy.rules.single().match.isEmpty() && initialPolicy.otherwise == "share") -> SourceFilterBoundary.ALL
        initialPolicy.rules.firstOrNull()?.action == "share" -> SourceFilterBoundary.ONLY
        else -> SourceFilterBoundary.EXCEPT
    }
    var boundary by rememberSaveable(source.id, levelId, capability) { mutableStateOf(savedBoundary) }
    var stage by rememberSaveable(source.id, levelId, capability) { mutableStateOf(if (pickable) SourceFilterStage.MODE else SourceFilterStage.REVIEW) }
    val picker = remember(session, source.id, capability) { navigation ?: SourceFilterPickerState.opening(source) }
    val refs = policy.rules.firstOrNull()?.match.orEmpty()
    val savedRefs = remember(initialPolicy) { initialPolicy?.rules?.firstOrNull()?.match.orEmpty() }
    fun setRefs(value: List<ScopeRef>) { if (writable) policy = policy.copy(rules = listOf(policy.rules.single().copy(match = value))) }
    fun choose(value: SourceFilterBoundary) {
        if (!pickable) return
        boundary = value
        if (value != SourceFilterBoundary.ALL) policy = policy.copy(rules = listOf(ScopeRule(refs, if (value == SourceFilterBoundary.ONLY) "share" else "hide")), otherwise = if (value == SourceFilterBoundary.ONLY) "hide" else "share")
    }
    fun back() {
        if (!pickable) return onClose()
        stage = when (stage) {
            SourceFilterStage.REVIEW -> SourceFilterStage.MATCHES
            SourceFilterStage.MATCHES -> SourceFilterStage.MODE
            SourceFilterStage.MODE -> { onClose(); SourceFilterStage.MODE }
        }
    }
    // Resolve saved names across all kinds before the choices open, including kinds not shown yet.
    // This warms names only; the review below still checks the exact current filter.
    LaunchedEffect(session, initialPolicy, writable) {
        if (!writable || initialPolicy == null || initialPolicy.sourceId != source.id ||
            initialPolicy.rules.flatMap { it.match }.none { session.label(source.id, it) == null && it.identifiers.isNullOrEmpty() }) return@LaunchedEffect
        try { session.preview(initialPolicy.copy(audience = ScopeAudience(levelId, capability))) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* A failed name read cannot change the saved filter. The review asks again. */ }
    }
    // The gateway previews only the shapes this editor can author, and a filter that can only be trimmed is saved without counts.
    val previewing = stage == SourceFilterStage.REVIEW && refs.isNotEmpty() && !removeOnly
    val result = rememberPolicyPreview(session, policy, active = previewing)
    val counted = previewing && result.settled && !result.failed
    if (stage == SourceFilterStage.MATCHES && pickable) {
        SourceFilterPicker(source, session, onClose, capability, refs, picker, icon = icon, nameFor = nameFor, onBack = { stage = SourceFilterStage.MODE },
            onSelectionChange = ::setRefs) { selection -> setRefs(selection); stage = SourceFilterStage.REVIEW }
        return
    }
    val allContent = stage == SourceFilterStage.MODE && boundary == SourceFilterBoundary.ALL
    val title = capabilityTitle(capability)
    Dialog(onDismissRequest = ::back, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = colors.background) {
            AccessTaskScaffold(
                title = "$title filter",
                question = if (stage == SourceFilterStage.MODE) "What should be shared?" else "Review this filter",
                primary = when {
                    !writable || allContent -> "Done"
                    stage == SourceFilterStage.MODE -> "Continue"
                    else -> "Apply filter"
                },
                enabled = when {
                    !writable || stage == SourceFilterStage.MODE -> true
                    removeOnly -> refs.map(::scopeRefKey) != savedRefs.map(::scopeRefKey)
                    else -> counted && policy.withinLimits && refs.isNotEmpty()
                },
                onPrimary = {
                    when {
                        !writable -> onClose()
                        allContent -> changed(null)
                        stage == SourceFilterStage.MODE -> stage = SourceFilterStage.MATCHES
                        removeOnly -> changed(policy.takeIf { refs.isNotEmpty() })
                        counted && policy.withinLimits && refs.isNotEmpty() -> changed(policy)
                    }
                },
                // The first screen only cancels; a later step goes back, with Cancel beside it to leave the editor.
                leading = if (!writable) "Close" else if (stage == SourceFilterStage.MODE || removeOnly) "Cancel" else "Back",
                onLeading = ::back, onCancel = if (pickable && stage != SourceFilterStage.MODE) onClose else null,
                focusKey = result.failure, account = { AccessAccountLine(source.accountName(nameFor), icon) },
            ) {
                if (stage == SourceFilterStage.MODE) {
                    AccessOptions {
                        AccessChoice(ALL_CONTENT, "Allow all content from this account.", boundary == SourceFilterBoundary.ALL) { choose(SourceFilterBoundary.ALL) }
                        AccessChoice("Only matching content", "Continue to select filters that define which content gets shared.", boundary == SourceFilterBoundary.ONLY) { choose(SourceFilterBoundary.ONLY) }
                        AccessChoice("Everything except matching content", "Continue to select filters that define which content never gets shared.", boundary == SourceFilterBoundary.EXCEPT) { choose(SourceFilterBoundary.EXCEPT) }
                    }
                } else {
                    when {
                        !policy.editable -> AccessNotice("This filter uses settings that cannot be changed here. It stays in force as saved.")
                        !writable -> AccessNotice("Filters cannot be changed right now. This saved filter stays in force.")
                        !source.available -> AccessNotice("This account is no longer connected. Saved filters can be removed but not added.")
                        removeOnly -> AccessNotice("This account no longer offers some of these filters. Saved filters can be removed but not added.")
                    }
                    if (!pickable) AccessGap(20.dp)
                    AccessPill(scopePolicyActionLabel(policy), scopePolicyTone(policy))
                    AccessGap(AccessUi.ContentGap)
                    if (policy.editable) {
                        AccessSectionHeading(SELECTED_FILTERS_TITLE)
                        AccessGap(4.dp)
                        if (refs.isEmpty()) Text("No filters left. Applying shares all content from this account.", style = AccessType.RowSecondary, color = colors.secondary, modifier = Modifier.padding(vertical = 8.dp))
                        // An item saved by its id alone has no name until a preview or the choices supply one.
                        refs.forEachIndexed { index, ref ->
                            AccessSelectedFilterRow(ref, source, names, last = index == refs.lastIndex, count = result.count(ref).takeIf { counted }, counting = previewing && result.counting,
                                depth = scopeItemDepth(result.preview, ref), remove = if (removeOnly) { { setRefs(refs.filterNot { scopeRefKey(it) == scopeRefKey(ref) }) } } else null)
                        }
                        if (pickable && !policy.withinLimits) { AccessGap(12.dp); AccessNotice("$FILTER_LIMIT_MESSAGE Go back and remove some.", error = true) }
                    } else SavedRules(policy, source, names)
                    if (policy.editable && previewing) {
                        AccessGap(AccessUi.SectionGap)
                        AccessSectionHeading("Result")
                        AccessGap(AccessUi.HeadingGap)
                        val failure = result.failure
                        val preview = result.preview
                        when {
                            failure != null -> { AccessNotice(accessManagementError(failure, reading = true), error = true); AccessTextAction("Try again", onClick = result.retry) }
                            !counted || preview == null -> AccessProgressLine(COUNTING_MESSAGE)
                            else -> FilterResult(preview, policy, pickable, ::setRefs)
                        }
                    }
                }
            }
        }
    }
}

/**
 * What a filter's result says about records it cannot compare with the filter yet: the gateway does not
 * yet have, or is still updating, the details a filter on their source matches them on, so they
 * stay hidden until those details arrive.
 */
internal fun uncheckedRecordsLine(count: Long): String =
    if (count == 1L) "1 record stays hidden until its details finish syncing." else "${accessCount(count)} records stay hidden until their details finish syncing."
internal const val UNCHECKED_RECORDS_EXPLANATION = "Omnesis doesn’t have the details it needs to check them yet. Nothing is shared by mistake while they sync."

/** The result of a filter: how many records it shares and hides, then examples and other known addresses of its people. */
@Composable
private fun FilterResult(result: ScopePreview, policy: ScopePolicy, writable: Boolean, setRefs: (List<ScopeRef>) -> Unit) {
    val colors = AccessUi.colors
    AccessStatPair(result.visible, result.hidden)
    if (result.unknown > 0) {
        AccessGap(12.dp)
        Text(uncheckedRecordsLine(result.unknown), style = AccessType.RowSecondary, color = colors.primary)
        AccessGap(4.dp)
        Text(UNCHECKED_RECORDS_EXPLANATION, style = AccessType.RowSecondary, color = colors.secondary)
    }
    val refs = policy.rules.firstOrNull()?.match.orEmpty()
    val proposals = result.identifierProposals.orEmpty().filter { proposal -> writable && proposal.itemIndex in refs.indices && refs[proposal.itemIndex].kind == "participant" && proposal.identifiers.any { it !in refs[proposal.itemIndex].identifiers.orEmpty() } }
    var examples by remember { mutableStateOf(false) }
    var offered by remember { mutableStateOf<ScopeIdentifierProposal?>(null) }
    if (result.samples.isNotEmpty() || proposals.isNotEmpty()) AccessGap(8.dp)
    if (result.samples.isNotEmpty()) DisclosureRow("See examples", last = proposals.isEmpty()) { examples = true }
    proposals.forEachIndexed { index, proposal -> DisclosureRow("Other addresses for ${proposal.label}", last = index == proposals.lastIndex) { offered = proposal } }
    if (examples) AccessDialog(title = "Examples", confirm = "Done", onConfirm = { examples = false }, onDismiss = { examples = false }) {
        result.samples.forEach { sample ->
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(sample.title, style = AccessType.Subtitle, color = colors.primary, modifier = Modifier.weight(1f))
                if (sample.visible && !sample.unknown) AccessPill("Shared", AccessPillTone.ACCENT) else AccessPill(if (sample.unknown) "Not checked · hidden" else "Hidden", AccessPillTone.OUTLINE)
            }
        }
    }
    offered?.let { proposal ->
        val added = proposal.identifiers.filterNot { it in refs.getOrNull(proposal.itemIndex)?.identifiers.orEmpty() }
        AccessDialog(title = "Other addresses for ${proposal.label}", confirm = "Add", dismiss = "Cancel", onDismiss = { offered = null },
            onConfirm = { offered = null; setRefs(refs.mapIndexed { index, ref -> if (index == proposal.itemIndex) ref.copy(identifiers = (ref.identifiers.orEmpty() + added).distinct()) else ref }) }) {
            added.forEach { Text(it.value, style = AccessType.Subtitle, color = colors.primary, modifier = Modifier.padding(vertical = 4.dp)) }
            Text("Adding them matches this person’s content from these addresses too.", style = AccessType.RowSecondary, color = colors.secondary, modifier = Modifier.padding(top = 8.dp))
        }
    }
}

/** A row that opens more detail. */
@Composable
private fun DisclosureRow(label: String, last: Boolean, open: () -> Unit) {
    val colors = AccessUi.colors
    AccessRow(Modifier.clickable(role = Role.Button, onClick = open), last = last) {
        Text(label, style = AccessType.RowTitle.copy(fontWeight = FontWeight.Normal), color = colors.primary, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = colors.muted, modifier = Modifier.size(22.dp))
    }
}

/** A saved filter this editor cannot author, stated rule by rule as it is stored. */
@Composable
private fun SavedRules(policy: ScopePolicy, source: AccessSourceInstance, names: Map<Pair<String, String>, String>) {
    val colors = AccessUi.colors
    AccessSectionHeading("Saved rules")
    AccessGap(AccessUi.HeadingGap)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        policy.maxAge?.let { Text("Maximum age: $it", style = AccessType.RowSecondary, color = colors.secondary) }
        policy.rules.forEach { rule ->
            Text("${rule.action.replaceFirstChar { it.uppercase() }} matching records", style = AccessType.RowTitle, color = colors.primary)
            rule.match.forEach { ref -> AccessDetailText(filterItemLabel(ref, source.id, names) ?: savedSelectionName(ref.kind, source)) }
        }
        Text("Otherwise: ${policy.otherwise}", style = AccessType.RowSecondary, color = colors.secondary)
    }
}
