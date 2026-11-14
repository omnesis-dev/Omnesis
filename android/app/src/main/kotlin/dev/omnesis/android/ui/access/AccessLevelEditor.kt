// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.*
import kotlinx.serialization.Serializable

/** The draft as it stood when a decision was opened from [from], so cancelling the decision returns to both. */
@Serializable
private data class EnteredDecision(val from: AccessLevelPage, val draft: AccessLevelDraft)

private val EnteredDecisionSaver = Saver<EnteredDecision?, String>(
    save = { entered -> entered?.let { OmnesisJson.encodeToString(EnteredDecision.serializer(), it) } },
    restore = { OmnesisJson.decodeFromString(EnteredDecision.serializer(), it) },
)

/** The top bar of a level screen: one leading action, and Cancel beside Back only where Back does not already leave. */
private enum class AccessLevelNavigation { CLOSE, CANCEL_DECISION, BACK, BACK_AND_CANCEL }

@Composable
internal fun AccessLevelEditor(
    state: AccessManagementState, gateway: FilterEditorGateway, iconFor: (String) -> SourceIconModel,
    nameFor: (String) -> String?, update: (AccessLevelDraft) -> Unit, save: () -> Unit,
    close: () -> Unit, reload: () -> Unit, readPolicy: ((String) -> Unit)? = null,
) {
    val draft = state.draft ?: return
    val overview = state.overview ?: return
    val creating = draft.id == NEW_ACCESS_LEVEL_ID
    var page by rememberSaveable(draft.id, draft.expectedRevision) { mutableStateOf(if (creating) AccessLevelPage.PERMISSIONS else AccessLevelPage.OVERVIEW) }
    // The open filter is held by source id so it survives a configuration change.
    var filter by rememberSaveable(draft.id) { mutableStateOf<Pair<String, AccessCapability>?>(null) }
    var entered by rememberSaveable(draft.id, draft.expectedRevision, stateSaver = EnteredDecisionSaver) { mutableStateOf<EnteredDecision?>(null) }
    var discard by remember { mutableStateOf(false) }
    var returnToReview by rememberSaveable(draft.id, draft.expectedRevision) { mutableStateOf(false) }
    var reviewCapabilities by rememberSaveable { mutableStateOf(emptySet<AccessCapability>()) }
    var requiredReviewPages by rememberSaveable { mutableStateOf<List<AccessLevelPage>>(emptyList()) }
    var attempted by remember(page) { mutableStateOf(false) }
    val session = remember(gateway) { gateway.editorSession() }
    val filterNavigation = remember(session, draft.id, draft.expectedRevision) { SourceFilterNavigation() }
    val original = draft.savedLevel(overview)
    val conflict = state.conflict || (!creating && overview.levels.firstOrNull { it.id == draft.id }?.revision != draft.expectedRevision)
    // What a reversed choice set aside is not itself a change.
    val changed = if (creating) draft.copy(removedRules = emptyMap(), separateDirect = null) != AccessLevelDraft.opening(null, overview) else draft.isChangedFrom(original)
    val pages = draft.createPages()
    fun leave() { if (state.loading) return; if (changed) discard = true else close() }
    fun back() {
        if (state.loading) return
        entered = null
        if (returnToReview) { returnToReview = false; requiredReviewPages = emptyList(); page = AccessLevelPage.REVIEW; return }
        when {
            !creating && page != AccessLevelPage.OVERVIEW -> page = AccessLevelPage.OVERVIEW
            creating && pages.indexOf(page) > 0 -> page = pages[pages.indexOf(page) - 1]
            else -> leave()
        }
    }
    // A decision opened with "Change", from the level page or from a review, can be cancelled back to both.
    fun enter(target: AccessLevelPage) {
        if (target != AccessLevelPage.REVIEW && (!creating || returnToReview)) entered = EnteredDecision(page, draft)
        page = target
    }
    fun cancelDecision() {
        if (state.loading) return
        val origin = entered
        entered = null; returnToReview = false; requiredReviewPages = emptyList()
        origin?.let { update(it.draft) }
        page = origin?.from ?: AccessLevelPage.OVERVIEW
    }
    BackHandler(enabled = filter == null) { back() }
    val error = draft.pageError(page, overview)
    val primary = when (page) {
        AccessLevelPage.OVERVIEW -> "Review changes"
        AccessLevelPage.REVIEW -> if (state.error != null && !conflict && state.errorCode != "level-in-use") "Retry save" else if (creating) "Create access level" else "Save changes"
        else -> if (creating && (!returnToReview || requiredReviewPages.isNotEmpty())) "Continue" else "Done"
    }
    val navigation = when {
        page == AccessLevelPage.OVERVIEW -> AccessLevelNavigation.CLOSE
        entered != null -> AccessLevelNavigation.CANCEL_DECISION
        !creating -> AccessLevelNavigation.BACK
        pages.indexOf(page) == 0 -> AccessLevelNavigation.CLOSE
        else -> AccessLevelNavigation.BACK_AND_CANCEL
    }
    AccessTaskScaffold(
        title = if (creating) NEW_ACCESS_LEVEL_LABEL else "Edit access level", question = page.question(creating), subtitle = page.subtitle,
        // Only the level page names the level above its question.
        caption = if (page == AccessLevelPage.OVERVIEW) original?.name ?: draft.name.ifBlank { "Access level" } else null,
        primary = primary, enabled = !state.loading && when (page) {
            AccessLevelPage.OVERVIEW -> changed
            AccessLevelPage.REVIEW -> !conflict && state.errorCode != "level-in-use" && draft.validFor(overview) && (creating || changed)
            else -> error == null
        },
        onPrimary = {
            attempted = true
            if (draft.pageError(page, overview) == null) {
                when {
                    page == AccessLevelPage.REVIEW -> save()
                    page == AccessLevelPage.OVERVIEW -> page = AccessLevelPage.REVIEW
                    returnToReview -> {
                        // A permission added from the review brings its own decisions, asked before returning to it.
                        requiredReviewPages = if (page == AccessLevelPage.PERMISSIONS) {
                            val added = draft.readingCapabilities.filter { it !in reviewCapabilities }
                            draft.createPages().filter { candidate -> when (candidate) {
                                AccessLevelPage.ANSWER_DATA, AccessLevelPage.RELEASE -> AccessCapability.ANSWER in added
                                AccessLevelPage.DIRECT_CHOICE, AccessLevelPage.DIRECT_DATA -> AccessCapability.DIRECT in added
                                AccessLevelPage.FUTURE -> added.isNotEmpty()
                                else -> false
                            } }
                        } else requiredReviewPages.dropWhile { it != page }.drop(1)
                        val next = requiredReviewPages.firstOrNull() ?: draft.createPages().firstOrNull { it != AccessLevelPage.REVIEW && draft.pageError(it, overview) != null }
                        if (next == null) { returnToReview = false; entered = null; page = AccessLevelPage.REVIEW } else page = next
                    }
                    // Direct switched on asks for its accounts next; Cancel there undoes both decisions.
                    !creating && page == AccessLevelPage.PERMISSIONS && entered?.draft?.rule(AccessCapability.DIRECT) == null && draft.rule(AccessCapability.DIRECT) != null ->
                        page = AccessLevelPage.DIRECT_DATA
                    !creating -> { entered = null; page = AccessLevelPage.OVERVIEW }
                    else -> page = pages.getOrElse(pages.indexOf(page) + 1) { AccessLevelPage.REVIEW }
                }
            }
        },
        // One leading action per screen. Only a later step of a new level also offers Cancel, which abandons the level.
        leading = when (navigation) {
            AccessLevelNavigation.CLOSE -> "Close"
            AccessLevelNavigation.CANCEL_DECISION -> "Cancel"
            AccessLevelNavigation.BACK, AccessLevelNavigation.BACK_AND_CANCEL -> "Back"
        },
        onLeading = when (navigation) {
            AccessLevelNavigation.CLOSE -> ::leave
            AccessLevelNavigation.CANCEL_DECISION -> ::cancelDecision
            AccessLevelNavigation.BACK, AccessLevelNavigation.BACK_AND_CANCEL -> ::back
        },
        onCancel = if (navigation == AccessLevelNavigation.BACK_AND_CANCEL) ::leave else null,
        footer = draft.accountsNote(page, overview),
        busy = state.loading, focusKey = state.error,
        banner = if (conflict) { { AccessBanner(ACCESS_LEVEL_CONFLICT_MESSAGE, "Load the latest version and discard my changes", enabled = !state.loading, onAction = reload) } } else null,
    ) {
        if (state.loading) { AccessProgressLine("Saving…"); AccessGap(16.dp) }
        // A conflict's own code is said by the banner; any other refusal is said here.
        state.error?.takeIf { !conflict || it != "stale-revision" }?.let { message ->
            AccessNotice(message, error = true)
            if (!conflict && page == AccessLevelPage.REVIEW && state.errorCode == "level-in-use") {
                original?.rules?.firstOrNull { it.capability == AccessCapability.ANSWER }?.let { answer ->
                    AccessTextAction("Restore Answer", enabled = !state.loading) { update(draft.setRule(answer)) }
                }
                AccessTextAction("Retry save after moving integrations", enabled = !state.loading && draft.validFor(overview), onClick = save)
            }
            AccessGap(16.dp)
        }
        if (error != null && attempted) { AccessNotice(error, error = true); AccessGap(16.dp) }
        CompositionLocalProvider(LocalAccessEditingEnabled provides !state.loading) {
            val edit: (AccessLevelDraft) -> Unit = { if (!state.loading) update(it) }
            val openFilter: (AccessSourceInstance, AccessCapability) -> Unit = { source, capability -> if (!state.loading) filter = source.id to capability }
            when (page) {
                AccessLevelPage.OVERVIEW -> AccessLevelOverview(draft, overview) { if (!state.loading) enter(it) }
                AccessLevelPage.REVIEW -> AccessLevelReview(draft, overview, session, iconFor, nameFor, edit) { target ->
                    if (!state.loading) {
                        reviewCapabilities = draft.readingCapabilities.toSet(); requiredReviewPages = emptyList(); returnToReview = true
                        // A new level asks about Direct on one step whenever Answer is allowed too.
                        enter(if (creating && target == AccessLevelPage.DIRECT_DATA && draft.rule(AccessCapability.ANSWER) != null) AccessLevelPage.DIRECT_CHOICE else target)
                    }
                }
                else -> AccessLevelDecisionControls(page, draft, overview, iconFor, nameFor, readPolicy, edit, openFilter)
            }
        }
    }
    filter?.let { (sourceId, capability) ->
        AccessLevelFilterEditor(draft, overview, sourceId, capability, session, filterNavigation, iconFor, nameFor, onClose = { filter = null }) { policy ->
            update(draft.setPolicy(policy, sourceId, capability)); filter = null
        }
    }
    if (discard) AccessDialog(title = "Discard these changes?", body = "Your saved access level will stay unchanged.", confirm = "Discard changes", dismiss = "Keep editing",
        destructive = true, onConfirm = { discard = false; close() }, onDismiss = { discard = false })
}

/** What starts a new access level, wherever it is offered, and what its editor is titled. */
internal const val NEW_ACCESS_LEVEL_LABEL = "New access level"

/** What the banner of a level edited elsewhere says. */
internal const val ACCESS_LEVEL_CONFLICT_MESSAGE = "This access level changed elsewhere. Your changes are kept. Load the latest version before saving."
