// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.*

/** What "Change" on a decision reads out: "Change name", "Change Answer data". A capability keeps its capital. */
internal fun changeDescription(title: String): String =
    "Change " + if (ACCESS_CAPABILITIES.any { title.startsWith(it.title) }) title else title.replaceFirstChar { it.lowercase() }

/** The level page: every decision of the level with what it holds, each opened by its "Change". */
@Composable
internal fun AccessLevelOverview(draft: AccessLevelDraft, overview: AccessOverview, change: (AccessLevelPage) -> Unit) {
    val decisions = levelDecisions(draft.name, draft.serializedRules, overview, linked = draft.directLinked)
    Column {
        decisions.forEachIndexed { index, decision ->
            AccessDecisionRow(decision, last = index == decisions.lastIndex, action = "Change") { change(decision.page) }
        }
    }
}

/**
 * The last screen before saving. A new level states its name, then every decision. An edit states what
 * changed with each side of the change, what stays as saved, and who the change reaches.
 */
@Composable
internal fun AccessLevelReview(
    draft: AccessLevelDraft, overview: AccessOverview, session: FilterEditorSession, iconFor: (String) -> SourceIconModel,
    nameFor: (String) -> String?, update: (AccessLevelDraft) -> Unit, change: (AccessLevelPage) -> Unit,
) {
    val colors = AccessUi.colors
    if (draft.id == NEW_ACCESS_LEVEL_ID) {
        AccessNameField(draft, overview, update)
        AccessGap(12.dp)
        AccessDecisionSummary(draft.serializedRules, overview, linked = draft.directLinked, change = change)
        return
    }
    val changes = draft.changes(overview)
    AccessSectionHeading("Changes")
    AccessGap(AccessUi.HeadingGap)
    if (changes.isEmpty()) Text("No changes yet.", style = AccessType.RowSecondary, color = colors.secondary)
    changes.forEachIndexed { index, difference ->
        if (index > 0) { AccessGap(8.dp); AccessDivider(); AccessGap(8.dp) }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(difference.title, style = AccessType.RowTitle, color = colors.primary, modifier = Modifier.weight(1f).semantics { heading() })
            AccessTextAction("Change", enabled = LocalAccessEditingEnabled.current, alignment = Alignment.CenterEnd, description = changeDescription(difference.title)) { change(difference.page) }
        }
        val capability = difference.page.capability()
        if (capability != null) ChangedAccounts(draft, overview, capability, session, iconFor, nameFor)
        else {
            AccessBeforeAfterRow(after = false) { difference.beforeCapabilities?.let { AccessCapabilityPills(it) } ?: AccessChangeValue(difference.before, after = false) }
            AccessBeforeAfterRow(after = true) { difference.afterCapabilities?.let { AccessCapabilityPills(it) } ?: AccessChangeValue(difference.after, after = true) }
        }
    }
    val unchanged = draft.unchangedDecisions(overview)
    if (unchanged.isNotEmpty()) {
        AccessGap(AccessUi.SectionGap)
        AccessUnchangedBlock(unchanged)
    }
    draft.savedLevel(overview)?.let {
        AccessGap(AccessUi.SectionGap)
        AccessLevelImpact(it.users(overview))
    }
}

/** The line a review closes its "Affected" section with. */
internal const val AFFECTED_CONNECTIONS_NOTE = "Connected agents receive the new permissions when they refresh. They do not need to reconnect."

/** Who an edit reaches: the connections and integrations on the level, by name. */
@Composable
private fun AccessLevelImpact(users: AccessLevelUsers) {
    val colors = AccessUi.colors
    AccessSectionHeading("Affected")
    AccessGap(AccessUi.HeadingGap)
    if (!users.inUse) {
        Text("No connections use this access level yet.", style = AccessType.RowSecondary, color = colors.secondary)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        users.connections.forEach { AccessConnectionName(it, integration = false) }
        if (users.connections.isEmpty() && users.connectionCount > 0) Text(connectionCountLabel(users.connectionCount), style = AccessType.RowTitle, color = colors.primary)
        users.integrations.forEach { AccessConnectionName(it, integration = true) }
    }
    AccessGap(16.dp)
    Text(AFFECTED_CONNECTIONS_NOTE, style = AccessType.RowSecondary, color = colors.secondary)
}

/** A connection by name; an integration carries its pill. */
@Composable
internal fun AccessConnectionName(name: String, integration: Boolean, modifier: Modifier = Modifier) {
    Row(modifier.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(name, style = AccessType.RowTitle.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Normal), color = AccessUi.colors.primary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (integration) AccessTag("Integration", AccessUi.colors.secondary)
    }
}

/** Every account whose share of one capability an edit changes, each laid out by [accountChangeParts]. */
@Composable
private fun ChangedAccounts(draft: AccessLevelDraft, overview: AccessOverview, capability: AccessCapability, session: FilterEditorSession, iconFor: (String) -> SourceIconModel, nameFor: (String) -> String?) {
    draft.changedAccounts(capability, overview).forEachIndexed { index, change -> key(change.sourceId) {
        if (index > 0) AccessGap(20.dp)
        val source = overview.sources.firstOrNull { it.id == change.sourceId } ?: disconnectedAccount(change.sourceId, nameFor)
        AccessAccountLine(source.accountName(nameFor), accessSourceIcon(source, iconFor), Modifier.padding(bottom = 6.dp))
        // An account that is no longer connected has nothing to count.
        val connected = overview.sources.any { it.id == change.sourceId }
        val editor = rememberFilterEditor(session, change.sourceId).editor
        val before = change.before.filter?.let { rememberPolicyPreview(session, it) }
        val after = change.after.filter?.let { rememberPolicyPreview(session, it) }
        accountChangeParts(change.before, change.after).forEach { part ->
            when (part) {
                is AccountChangePart.Side -> AccessBeforeAfterRow(part.after, pill = true) { AccountSideValue(part.share, (if (part.after) after else before).takeIf { connected }, part.after) }
                // One side's items align under that side's value; the merged list spans the row.
                is AccountChangePart.Items -> Column(Modifier.padding(start = if (part.after == null) 0.dp else AccessUi.BeforeAfterLabelWidth)) {
                    part.items.forEachIndexed { itemIndex, item ->
                        val state = when (part.after) {
                            false -> before
                            true -> after
                            null -> if (item.mark == FilterItemMark.REMOVED) before else after
                        } ?: return@forEachIndexed
                        ReviewedFilterItem(item.ref, source, editor, session, state, last = itemIndex == part.items.lastIndex, mark = item.mark)
                    }
                }
            }
        }
    } }
}

/** One side of an account's change: how many records its filter shares and hides, then the pill that says what the side reads. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AccountSideValue(share: AccountShare, state: PolicyPreviewState?, after: Boolean) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        state?.takeIf { it.policy.editable }?.let { Column(Modifier.align(Alignment.CenterVertically)) { PolicyCounts(it, after) } }
        Box(Modifier.align(Alignment.CenterVertically)) { AccessPill(share.status, share.tone) }
    }
}

/** One item of a reviewed filter, named and counted as its side's preview knows it. */
@Composable
private fun ReviewedFilterItem(ref: FilterRef, source: AccessSourceInstance, editor: FilterEditor?, session: FilterEditorSession, state: PolicyPreviewState, last: Boolean, mark: FilterItemMark? = null) {
    val hints by session.hints.collectAsState()
    AccessSelectedFilterRow(ref, source.id, editor.fieldOf(ref), hints, last, preview = state.preview, count = state.count(ref), counting = state.counting, mark = mark)
}

/**
 * Every decision a set of rules holds, after its name, each as the level page states it. [change] adds a
 * "Change" to the decisions it is offered for; [linked] is a level whose Direct uses Answer's sources.
 */
@Composable
internal fun AccessDecisionSummary(rules: List<AccessGrantRule>, overview: AccessOverview, linked: Boolean = false, change: ((AccessLevelPage) -> Unit)? = null) {
    val decisions = levelDecisions("", rules, overview, linked).drop(1)
    Column {
        decisions.forEachIndexed { index, decision ->
            AccessDecisionRow(decision, last = index == decisions.lastIndex, action = "Change".takeIf { change != null }) { change?.invoke(decision.page) }
        }
    }
}
