// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.*

@Composable
internal fun AccessLevelEditor(
    state: AccessManagementState, gateway: ScopeEditorGateway, iconFor: (String) -> SourceIconModel,
    nameFor: (String) -> String?, update: (AccessLevelDraft) -> Unit, save: () -> Unit,
    close: () -> Unit, reload: () -> Unit,
) {
    val draft = state.draft ?: return
    val overview = state.overview ?: return
    val creating = draft.id == "new"
    var page by remember(draft.id, draft.expectedRevision) { mutableStateOf(if (creating) AccessLevelPage.PERMISSIONS else AccessLevelPage.OVERVIEW) }
    var filter by remember(draft.id) { mutableStateOf<Pair<AccessSourceInstance, AccessCapability>?>(null) }
    var discard by remember { mutableStateOf(false) }
    var reloadConfirmation by remember { mutableStateOf(false) }
    var returnToReview by remember(draft.id, draft.expectedRevision) { mutableStateOf(false) }
    var reviewCapabilities by remember { mutableStateOf(emptySet<AccessCapability>()) }
    var requiredReviewPages by remember { mutableStateOf<List<AccessLevelPage>>(emptyList()) }
    var attempted by remember(page) { mutableStateOf(false) }
    val session = remember(gateway) { if (gateway is ScopePreviewSession) gateway else ScopePreviewSession(gateway) }
    val original = draft.originalLevel ?: overview.levels.firstOrNull { it.id == draft.id }
    val conflict = state.conflict || (!creating && overview.levels.firstOrNull { it.id == draft.id }?.revision != draft.expectedRevision)
    val changed = if (creating) draft != AccessLevelDraft.opening(null, overview) else draft.isChangedFrom(original)
    val pages = draft.createPages()
    fun leave() { if (state.loading) return; if (changed) discard = true else close() }
    fun back() {
        if (state.loading) return
        if (returnToReview) { returnToReview = false; requiredReviewPages = emptyList(); page = AccessLevelPage.REVIEW; return }
        when {
            !creating && page != AccessLevelPage.OVERVIEW -> page = AccessLevelPage.OVERVIEW
            creating && pages.indexOf(page) > 0 -> page = pages[pages.indexOf(page) - 1]
            else -> leave()
        }
    }
    BackHandler(enabled = filter == null) { back() }
    val question = when (page) {
        AccessLevelPage.OVERVIEW -> draft.name.ifBlank { "Access level" }
        AccessLevelPage.PERMISSIONS -> "What may it do?"
        AccessLevelPage.ANSWER_DATA -> "Which data may Answer use?"
        AccessLevelPage.DIRECT_CHOICE -> "Which data may Direct read?"
        AccessLevelPage.DIRECT_DATA -> "Choose Direct’s data"
        AccessLevelPage.FUTURE -> "What about new sources?"
        AccessLevelPage.RELEASE -> "How should answers be released?"
        AccessLevelPage.REVIEW -> if (creating) "Review your access level" else "Review your changes"
    }
    val description = when (page) {
        AccessLevelPage.OVERVIEW -> "Change one decision, then review before saving."
        AccessLevelPage.PERMISSIONS -> "Choose the actions this access level allows."
        AccessLevelPage.ANSWER_DATA -> "Select the accounts it may use. Change a selected account to share specific content."
        AccessLevelPage.DIRECT_DATA -> "These records can be read directly, without Answer’s privacy review."
        AccessLevelPage.DIRECT_CHOICE -> "Reuse Answer’s data for this new draft, or choose a separate boundary."
        AccessLevelPage.FUTURE -> "Decide what happens when you connect another source. Your current selections stay the same."
        AccessLevelPage.RELEASE -> "This choice applies to Answer. It does not review Direct access."
        AccessLevelPage.REVIEW -> if (creating) "Check the boundary and give it a name you’ll recognize." else "Only changed decisions are shown below. Nothing is saved yet."
    }
    val error = draft.pageError(page, overview)
    val primary = when (page) {
        AccessLevelPage.OVERVIEW -> "Review changes"
        AccessLevelPage.REVIEW -> if (creating) "Create access level" else "Save changes"
        else -> if (returnToReview && requiredReviewPages.isEmpty()) "Back to review" else if (creating) "Continue" else "Done"
    }
    val footer = when {
        page == AccessLevelPage.REVIEW && !creating -> "Applies to ${original?.connectionCount ?: 0} connections on their next request."
        page == AccessLevelPage.REVIEW -> "You can connect an agent after creating this level."
        page.capability() != null && error != null -> "Choose at least one source to continue."
        else -> null
    }
    AccessTaskScaffold(
        title = if (creating) "New access level" else "Edit access level", question = question, description = description,
        progress = if (creating) "Step ${pages.indexOf(page) + 1} of ${pages.size}" else null,
        primary = primary, enabled = !state.loading && !conflict && when (page) {
            AccessLevelPage.OVERVIEW -> changed
            AccessLevelPage.REVIEW -> draft.validFor(overview) && (creating || changed)
            else -> error == null
        },
        onPrimary = {
            attempted = true
            if (draft.pageError(page, overview) == null) {
                when {
                    page == AccessLevelPage.REVIEW -> save()
                    page == AccessLevelPage.OVERVIEW -> page = AccessLevelPage.REVIEW
                    returnToReview -> {
                        if (page == AccessLevelPage.PERMISSIONS) {
                            val added = draft.readingCapabilities.filter { it !in reviewCapabilities }
                            requiredReviewPages = draft.createPages().filter { candidate -> when (candidate) {
                                AccessLevelPage.ANSWER_DATA, AccessLevelPage.RELEASE -> AccessCapability.ANSWER in added
                                AccessLevelPage.DIRECT_CHOICE, AccessLevelPage.DIRECT_DATA -> AccessCapability.DIRECT in added
                                AccessLevelPage.FUTURE -> added.isNotEmpty()
                                else -> false
                            } }
                        } else requiredReviewPages = requiredReviewPages.dropWhile { it != page }.drop(1)
                        val next = requiredReviewPages.firstOrNull() ?: draft.createPages().firstOrNull { it != AccessLevelPage.REVIEW && draft.pageError(it, overview) != null }
                        if (next == null) { returnToReview = false; page = AccessLevelPage.REVIEW } else page = next
                    }
                    !creating -> page = AccessLevelPage.OVERVIEW
                    else -> page = pages.getOrElse(pages.indexOf(page) + 1) { AccessLevelPage.REVIEW }
                }
            }
        }, onBack = ::back, onCancel = if (page == AccessLevelPage.OVERVIEW || (creating && page == AccessLevelPage.PERMISSIONS)) null else ::leave,
        backLabel = if (page == AccessLevelPage.OVERVIEW || (creating && page == AccessLevelPage.PERMISSIONS)) "Close" else "Back",
        footer = footer, busy = state.loading, focusKey = state.error,
    ) {
        if (state.loading) Text("Saving…", style = MaterialTheme.typography.bodyLarge)
        if (state.error != null || conflict) {
            AccessNotice(if (conflict) "This access level changed on the gateway. Your unsaved draft is still here. Review it, or reload the latest version." else state.error.orEmpty(), error = true)
            if (conflict && state.error != null && state.error != "stale-revision") AccessNotice(state.error, error = true)
            if (conflict) TextButton(onClick = { reloadConfirmation = true }) { Text("Reload latest…") }
            else if (page == AccessLevelPage.REVIEW) TextButton(onClick = { if (draft.pageError(page, overview) == null) save() }, enabled = !state.loading && draft.validFor(overview)) { Text("Retry save") }
        }
        if (attempted && error != null) AccessNotice(error, error = true)
        CompositionLocalProvider(LocalAccessEditingEnabled provides !state.loading) {
        val edit: (AccessLevelDraft) -> Unit = { if (!state.loading) update(it) }
        when (page) {
            AccessLevelPage.OVERVIEW -> AccessLevelOverview(draft, overview) { if (!state.loading) page = it }
            AccessLevelPage.PERMISSIONS -> AccessPermissionsQuestion(draft, overview, edit)
            AccessLevelPage.ANSWER_DATA, AccessLevelPage.DIRECT_DATA -> AccessDataQuestion(draft, overview, page.capability()!!, iconFor, nameFor, edit) { source, capability -> if (!state.loading) filter = source to capability }
            AccessLevelPage.DIRECT_CHOICE -> AccessDirectQuestion(draft, overview, edit)
            AccessLevelPage.FUTURE -> AccessFutureQuestion(draft, overview, edit)
            AccessLevelPage.RELEASE -> AccessReleaseQuestion(draft, overview, edit)
            AccessLevelPage.REVIEW -> AccessLevelReview(draft, overview, session, edit) { target ->
                if (!state.loading) { reviewCapabilities = draft.readingCapabilities.toSet(); requiredReviewPages = emptyList(); returnToReview = true; page = target }
            }
        }
        }
    }
    filter?.let { (source, capability) ->
        SourceFilterEditor(source, draft.id, capability.name.lowercase(), draft.rule(capability)?.scopePolicies?.firstOrNull { it.sourceId == source.id },
            overview.sourceFilters?.enabled == true && source.available, session, onClose = { filter = null }) { policy -> update(draft.setPolicy(policy, source.id, capability)); filter = null }
    }
    if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text("Discard these changes?") },
        text = { Text("Your saved access level will stay unchanged.") },
        confirmButton = { TextButton(onClick = { discard = false; close() }) { Text("Discard changes") } },
        dismissButton = { TextButton(onClick = { discard = false }) { Text("Keep editing") } })
    if (reloadConfirmation) AlertDialog(onDismissRequest = { reloadConfirmation = false }, title = { Text("Reload and discard your draft?") },
        text = { Text("Reloading replaces your unsaved changes with the gateway’s latest version.") },
        confirmButton = { TextButton(onClick = { reloadConfirmation = false; reload() }) { Text("Reload latest") } },
        dismissButton = { TextButton(onClick = { reloadConfirmation = false }) { Text("Keep my draft") } })
}
