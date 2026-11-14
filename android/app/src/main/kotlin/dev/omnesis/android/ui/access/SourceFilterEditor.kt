// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.CancellationException

internal enum class SourceFilterBoundary { ALL, ONLY, EXCEPT }

private enum class SourceFilterStage { MODE, MATCHES, REVIEW }

/** Carries the filter being edited across a configuration change. */
private val SourceFilterSaver = Saver<SourceFilter, String>(
    save = { OmnesisJson.encodeToString(SourceFilter.serializer(), it) },
    restore = { OmnesisJson.decodeFromString(SourceFilter.serializer(), it) },
)

/**
 * The filter [draft] holds for one account under [capability], opened in the editor below. Every screen that edits a
 * level's filters opens them here; [changed] receives the edited filter, or null for no filter.
 */
@Composable
internal fun AccessLevelFilterEditor(
    draft: AccessLevelDraft, overview: AccessOverview, sourceId: String, capability: AccessCapability, session: FilterEditorSession,
    navigation: SourceFilterNavigation, iconFor: (String) -> SourceIconModel, nameFor: (String) -> String?, onClose: () -> Unit, changed: (SourceFilter?) -> Unit,
) {
    val source = overview.sources.firstOrNull { it.id == sourceId } ?: disconnectedAccount(sourceId, nameFor)
    SourceFilterEditor(source, draft.id, capability.wire, draft.rule(capability)?.scopePolicies?.firstOrNull { it.sourceId == source.id },
        overview.sourceFilters?.enabled == true, session, onClose = onClose, navigation = navigation.of(source, capability),
        icon = accessSourceIcon(source, iconFor), nameFor = nameFor, changed = changed)
}

/**
 * One account’s filter for one capability, in three steps: what to share, which content matches, and a
 * review of the result. A filter whose account is no longer connected, or no longer offers a field the filter
 * matches on, opens on its review, where saved items can be removed but none added. A filter this editor
 * cannot author, or any filter while editing is switched off, is shown as saved and only closed. Counts never
 * hold up applying a filter: they arrive by themselves.
 */
@Composable
internal fun SourceFilterEditor(
    source: AccessSourceInstance, levelId: String, capability: String, initialPolicy: SourceFilter?,
    authoringEnabled: Boolean, gateway: FilterEditorGateway, onClose: () -> Unit,
    navigation: SourceFilterPickerState? = null, icon: SourceIconModel = SourceIconModel(),
    nameFor: (String) -> String? = { null }, changed: (SourceFilter?) -> Unit,
) {
    val colors = AccessUi.colors
    val session = remember(gateway) { gateway.editorSession() }
    // Names arrive with the previews and choices this session reads; a row shows its name as soon as one does.
    val hints by session.hints.collectAsState()
    var policy by rememberSaveable(source.id, levelId, capability, stateSaver = SourceFilterSaver) { mutableStateOf((initialPolicy ?: SourceFilter.empty(source.id, levelId, capability)).copy(audience = FilterAudience(levelId, capability))) }
    // Read for a disconnected account too: the gateway still names and captions its saved entries, and says it is gone.
    val editor = rememberFilterEditor(session, source.id).editor
    val connected = source.available && source.filterable && editor?.connected != false
    val savedRefs = remember(initialPolicy) { initialPolicy?.rules?.firstOrNull()?.match.orEmpty() }
    // The owner can always keep or trim a filter this editor can express. Items can be added only while the account
    // is connected and still offers every field the saved filter matches on.
    val writable = authoringEnabled && policy.editable
    val offered = editor == null || (initialPolicy == null || (initialPolicy.sourceId == source.id && savedRefs.all { editor.field(it.fieldPath) != null }))
    val pickable = writable && connected && offered
    val removeOnly = writable && !pickable
    val savedBoundary = when {
        initialPolicy == null || (initialPolicy.editable && initialPolicy.rules.single().match.isEmpty() && initialPolicy.otherwise == "share") -> SourceFilterBoundary.ALL
        initialPolicy.rules.firstOrNull()?.action == "share" -> SourceFilterBoundary.ONLY
        else -> SourceFilterBoundary.EXCEPT
    }
    var boundary by rememberSaveable(source.id, levelId, capability) { mutableStateOf(savedBoundary) }
    var chosenStage by rememberSaveable(source.id, levelId, capability) { mutableStateOf(if (pickable) SourceFilterStage.MODE else SourceFilterStage.REVIEW) }
    val stage = if (pickable) chosenStage else SourceFilterStage.REVIEW
    val picker = remember(session, source.id, capability) { navigation ?: SourceFilterPickerState() }
    val refs = policy.rules.firstOrNull()?.match.orEmpty()
    fun setRefs(value: List<FilterRef>) { if (writable) policy = policy.copy(rules = listOf(policy.rules.single().copy(match = value))) }
    fun choose(value: SourceFilterBoundary) {
        if (!pickable) return
        boundary = value
        if (value != SourceFilterBoundary.ALL) policy = policy.copy(rules = listOf(FilterRule(refs, if (value == SourceFilterBoundary.ONLY) "share" else "hide")), otherwise = if (value == SourceFilterBoundary.ONLY) "hide" else "share")
    }
    fun back() {
        if (!pickable) return onClose()
        chosenStage = when (stage) {
            SourceFilterStage.REVIEW -> SourceFilterStage.MATCHES
            SourceFilterStage.MATCHES -> SourceFilterStage.MODE
            SourceFilterStage.MODE -> { onClose(); SourceFilterStage.MODE }
        }
    }
    // Resolve saved names before the choices open, including fields not shown yet.
    // This warms names only; the review below still asks for the exact current filter.
    LaunchedEffect(session, initialPolicy, writable) {
        if (!writable || initialPolicy == null || initialPolicy.sourceId != source.id ||
            initialPolicy.rules.flatMap { it.match }.none { session.label(source.id, it) == null }) return@LaunchedEffect
        try { session.preview(initialPolicy.copy(audience = FilterAudience(levelId, capability))) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* A failed name read cannot change the saved filter. The review asks again. */ }
    }
    // The gateway previews only the shapes this editor can author, and a filter that can only be trimmed is saved without counts.
    val previewing = stage == SourceFilterStage.REVIEW && refs.isNotEmpty() && !removeOnly
    val result = rememberPolicyPreview(session, policy, active = previewing)
    if (stage == SourceFilterStage.MATCHES) {
        SourceFilterPicker(source, session, onClose, capability, refs, picker, icon = icon, nameFor = nameFor, onBack = { chosenStage = SourceFilterStage.MODE },
            onSelectionChange = ::setRefs) { selection -> setRefs(selection); chosenStage = SourceFilterStage.REVIEW }
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
                    removeOnly -> refs.map(::filterRefKey) != savedRefs.map(::filterRefKey)
                    else -> policy.withinLimits && refs.isNotEmpty()
                },
                onPrimary = {
                    when {
                        !writable -> onClose()
                        allContent -> changed(null)
                        stage == SourceFilterStage.MODE -> chosenStage = SourceFilterStage.MATCHES
                        removeOnly -> changed(policy.takeIf { refs.isNotEmpty() })
                        policy.withinLimits && refs.isNotEmpty() -> changed(policy)
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
                    val notice = when {
                        !policy.editable -> "This filter uses settings that cannot be changed here. It stays in force as saved."
                        !writable -> "Filters cannot be changed right now. This saved filter stays in force."
                        // A gone account, or one with nothing to filter on, is explained in the gateway's words.
                        removeOnly -> editor?.profileText
                        else -> null
                    }
                    notice?.let { AccessNotice(it); AccessGap(20.dp) }
                    AccessPill(scopePolicyActionLabel(policy), scopePolicyTone(policy))
                    AccessGap(AccessUi.ContentGap)
                    if (policy.editable) {
                        AccessSectionHeading(SELECTED_FILTERS_TITLE)
                        AccessGap(4.dp)
                        if (refs.isEmpty()) Text("No filters left. Applying shares all content from this account.", style = AccessType.RowSecondary, color = colors.secondary, modifier = Modifier.padding(vertical = 8.dp))
                        // An item saved by its id alone has no name until a preview or the choices supply one.
                        refs.forEachIndexed { index, ref ->
                            AccessSelectedFilterRow(ref, source.id, editor.fieldOf(ref), hints, last = index == refs.lastIndex, preview = result.preview,
                                count = result.count(ref), counting = previewing && result.counting,
                                remove = if (removeOnly) { { setRefs(refs.filterNot { filterRefKey(it) == filterRefKey(ref) }) } } else null)
                        }
                        if (pickable && !policy.withinLimits) { AccessGap(12.dp); AccessNotice(FILTER_LIMIT_MESSAGE, error = true) }
                    } else SavedRules(policy, source, editor, hints)
                    if (policy.editable && previewing) {
                        AccessGap(AccessUi.SectionGap)
                        AccessSectionHeading("Result")
                        AccessGap(AccessUi.HeadingGap)
                        val failure = result.failure
                        val preview = result.preview
                        when {
                            failure != null -> { AccessNotice(COUNTS_UNAVAILABLE_MESSAGE, error = true); AccessTextAction("Try again", onClick = result.retry) }
                            preview == null || !result.settled -> AccessProgressLine(COUNTING_MESSAGE)
                            !preview.connected -> Unit
                            else -> FilterResult(preview)
                        }
                    }
                }
            }
        }
    }
}

/**
 * The result of a filter: how many records it shares and hides, then, only when there are any, the gateway's
 * sentences for records too old for the filter and records it cannot match.
 */
@Composable
private fun FilterResult(result: FilterPreview) {
    val colors = AccessUi.colors
    AccessStatPair(result.visible, result.hidden)
    listOfNotNull(result.tooOldText, result.unmatchedText).forEach { line ->
        AccessGap(12.dp)
        Text(line, style = AccessType.RowSecondary, color = colors.secondary)
    }
}

/** A saved filter this editor cannot author, stated rule by rule as it is stored. */
@Composable
private fun SavedRules(policy: SourceFilter, source: AccessSourceInstance, editor: FilterEditor?, hints: Map<Pair<String, String>, FilterEntryHint>) {
    val colors = AccessUi.colors
    AccessSectionHeading("Saved rules")
    AccessGap(AccessUi.HeadingGap)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        policy.rules.forEach { rule ->
            Text("${rule.action.replaceFirstChar { it.uppercase() }} matching records", style = AccessType.RowTitle, color = colors.primary)
            rule.match.forEach { ref -> AccessDetailText(filterItemLabel(ref, source.id, hints) ?: savedSelectionName(editor.fieldOf(ref))) }
        }
        Text("Otherwise: ${policy.otherwise}", style = AccessType.RowSecondary, color = colors.secondary)
    }
}
