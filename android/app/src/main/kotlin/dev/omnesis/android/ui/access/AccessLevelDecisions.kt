// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.*

/** Which of Answer, Direct and Notes the level allows. [requiredAnswer] holds Answer on for an agent that cannot work without it. */
@Composable
internal fun AccessPermissionsQuestion(draft: AccessLevelDraft, overview: AccessOverview, requiredAnswer: Boolean = false, update: (AccessLevelDraft) -> Unit) {
    AccessOptions {
        ACCESS_CAPABILITIES.forEach { cap ->
            AccessToggleChoice(cap.title, cap.explanation, draft.rule(cap) != null, cap.warning, locked = requiredAnswer && cap == AccessCapability.ANSWER) { update(draft.enabled(cap, it, overview)) }
        }
        if (requiredAnswer) AccessDetailText("Answer is required by this integration.")
    }
}

/**
 * A name the gateway stores, with the reason a typed name cannot be used; an empty field states none. [taken]
 * outlines a name the gateway refused, whose refusal the screen states above the field.
 */
@Composable
internal fun AccessNameField(value: String, label: String, error: String?, taken: Boolean = false, change: (String) -> Unit) {
    val shown = error?.takeIf { value.isNotBlank() }
    AccessTextField(value, change, label = label, enabled = LocalAccessEditingEnabled.current, error = shown, invalid = shown != null || taken)
}

/** The level's name. */
@Composable
internal fun AccessNameField(draft: AccessLevelDraft, overview: AccessOverview, update: (AccessLevelDraft) -> Unit, taken: Boolean = false) {
    AccessNameField(draft.name, ACCESS_LEVEL_NAME_LABEL, draft.nameError(overview), taken) { update(draft.copy(name = it)) }
}

/** The accounts a rule can name: every connected account, then those it still names although no source reports them. */
private fun accountInventory(rule: AccessGrantRule, overview: AccessOverview, nameFor: (String) -> String?): List<AccessSourceInstance> =
    accountIds(overview, listOf(rule)).map { id -> overview.sources.firstOrNull { it.id == id } ?: disconnectedAccount(id, nameFor) }

/** The pill that states what one capability reads from an account. */
@Composable
private fun AccountStatus(allowed: Boolean, policy: ScopePolicy?) {
    when {
        allowed -> AccessPill(scopePolicySummary(policy), scopePolicyTone(policy))
        policy != null -> AccessPill("$NOT_SHARED · saved filter kept", AccessPillTone.OUTLINE)
        else -> AccessPill(NOT_SHARED, AccessPillTone.OUTLINE)
    }
}

/**
 * The accounts one capability reads, each ticked or not, with "Change" opening the account's filter. A
 * [frozen] list only shows them: no search, nothing to tick or change, the whole list muted.
 */
@Composable
internal fun AccessDataQuestion(
    draft: AccessLevelDraft, overview: AccessOverview, capability: AccessCapability,
    iconFor: (String) -> SourceIconModel, nameFor: (String) -> String?, update: (AccessLevelDraft) -> Unit,
    filter: (AccessSourceInstance, AccessCapability) -> Unit, frozen: Boolean = false,
) {
    val colors = AccessUi.colors
    val rule = draft.rule(capability) ?: return
    val authoring = overview.sourceFilters?.enabled
    val known = draft.knownSourceIds(overview)
    val selection = AccessSourceSelectionState.from(rule.sources, known)
    val sources = accountInventory(rule, overview, nameFor)
    var query by remember(capability) { mutableStateOf("") }
    val visible = if (frozen) sources else visibleAccounts(sources, query)
    val editing = LocalAccessEditingEnabled.current && !frozen
    fun choose(next: AccessSourceSelectionState) { update(draft.setBoundary(next.boundary(known), capability, authoring)) }
    fun permitted(next: AccessSourceSelectionState) = draft.canSetBoundary(next.boundary(known), capability, authoring)
    Column(if (frozen) Modifier.alpha(.5f) else Modifier) {
        if (sources.isEmpty()) AccessNotice("No connected accounts are available. Connect a source before granting data access.")
        else {
            if (!frozen) { AccessTextField(query, { query = it }, label = "Search sources", enabled = editing, search = true); AccessGap(8.dp) }
            // The bulk actions reach the accounts the search shows.
            Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                val all = selection.settingAll(visible, true)
                val none = selection.settingAll(visible, false)
                Text("${sources.count { selection.allows(it.id) }} of ${sources.size} allowed", style = AccessType.RowSecondary, color = colors.secondary, modifier = Modifier.weight(1f))
                if (!frozen) {
                    AccessTextAction("Allow all", enabled = editing && permitted(all), alignment = Alignment.CenterEnd) { choose(all) }
                    AccessTextAction("Block all", enabled = editing && permitted(none), alignment = Alignment.CenterEnd) { choose(none) }
                }
            }
            AccessDivider()
            if (visible.isEmpty()) Text("No sources match this search.", style = AccessType.Subtitle, color = colors.secondary, modifier = Modifier.padding(top = 14.dp))
        }
        visible.forEachIndexed { index, source ->
            val allowed = selection.allows(source.id)
            val policy = rule.scopePolicies.firstOrNull { it.sourceId == source.id }
            val next = selection.setAllowed(source.id, !allowed)
            val name = source.accountName(nameFor)
            val filterable = (allowed && authoring == true && source.scopes != null) || policy != null
            // An account that is no longer connected can be taken out of the level, but not put back in.
            AccessAccountRow(name, accessSourceIcon(source, iconFor), last = index == visible.lastIndex, checked = allowed,
                enabled = editing && (source.available || allowed) && permitted(next), onToggle = { choose(next) },
                action = "Change".takeIf { filterable && !frozen }, actionDescription = "Change ${name.source} for ${capability.title}", onAction = { filter(source, capability) }) {
                AccountStatus(allowed, policy)
            }
        }
    }
    if (!frozen && authoring != true && rule.scopePolicies.isNotEmpty()) {
        AccessGap(16.dp)
        AccessNotice("Saved filters cannot be changed right now. They stay in force. You can still turn off a permission.")
    }
}

/**
 * Direct's accounts on a saved level. Beside Answer, Direct is either linked to Answer, which shows Answer's
 * accounts as they stand and cannot be changed here, or has a list of its own; one action above the list
 * switches between the two. Leaving the link restores the list this draft had before linking, or starts
 * from a copy of Answer's. Without Answer, Direct's own list is all there is.
 */
@Composable
internal fun AccessDirectDataQuestion(
    draft: AccessLevelDraft, overview: AccessOverview, iconFor: (String) -> SourceIconModel, nameFor: (String) -> String?,
    update: (AccessLevelDraft) -> Unit, filter: (AccessSourceInstance, AccessCapability) -> Unit,
) {
    val authoring = overview.sourceFilters?.enabled
    val editing = LocalAccessEditingEnabled.current
    if (draft.rule(AccessCapability.ANSWER) == null) return AccessDataQuestion(draft, overview, AccessCapability.DIRECT, iconFor, nameFor, update, filter)
    if (draft.directLinked) {
        Text(DIRECT_LINKED_NOTE, style = AccessType.Subtitle, color = AccessUi.colors.primary)
        AccessGap(12.dp)
        AccessSecondaryButton(DIRECT_OWN_LIST_LABEL, enabled = editing) { update(draft.withDirectSameAsAnswer(false, authoring)) }
        AccessGap(20.dp)
        AccessDataQuestion(draft, overview, AccessCapability.ANSWER, iconFor, nameFor, update, filter, frozen = true)
    } else {
        AccessSecondaryButton(DIRECT_SAME_AS_ANSWER_LABEL, enabled = editing && draft.canCopyAnswer(authoring)) { update(draft.withDirectSameAsAnswer(true, authoring)) }
        AccessGap(20.dp)
        AccessDataQuestion(draft, overview, AccessCapability.DIRECT, iconFor, nameFor, update, filter)
    }
}

/** The accounts a rule allows, read and not chosen from: each with the pill that states its content. */
@Composable
internal fun AccessAccountList(rule: AccessGrantRule, overview: AccessOverview, iconFor: (String) -> SourceIconModel, nameFor: (String) -> String?) {
    val listed = accountInventory(rule, overview, nameFor).filter { sourceAllowed(rule.sources, it.id) }
    if (listed.isEmpty()) Text("No accounts selected.", style = AccessType.RowSecondary, color = AccessUi.colors.secondary)
    Column {
        listed.forEachIndexed { index, source ->
            AccessAccountRow(source.accountName(nameFor), accessSourceIcon(source, iconFor), last = index == listed.lastIndex) {
                AccountStatus(true, rule.scopePolicies.firstOrNull { it.sourceId == source.id })
            }
        }
    }
}

/**
 * Direct beside Answer in a new level: use Answer's sources and filters, which are then listed as they
 * stand, or choose Direct's own accounts on the same screen.
 */
@Composable
internal fun AccessDirectQuestion(
    draft: AccessLevelDraft, overview: AccessOverview, iconFor: (String) -> SourceIconModel, nameFor: (String) -> String?,
    update: (AccessLevelDraft) -> Unit, filter: (AccessSourceInstance, AccessCapability) -> Unit,
) {
    val answer = draft.rule(AccessCapability.ANSWER) ?: return
    val authoring = overview.sourceFilters?.enabled
    AccessOptions {
        AccessChoice(DIRECT_SAME_AS_ANSWER_LABEL, null, draft.directSameAsAnswer, enabled = draft.directSameAsAnswer || draft.canCopyAnswer(authoring)) { update(draft.withDirectSameAsAnswer(true, authoring)) }
        AccessChoice(DIRECT_OWN_LIST_LABEL, null, !draft.directSameAsAnswer) { update(draft.withDirectSameAsAnswer(false, authoring)) }
    }
    AccessGap(20.dp)
    if (draft.directSameAsAnswer) AccessAccountList(answer, overview, iconFor, nameFor)
    else AccessDataQuestion(draft, overview, AccessCapability.DIRECT, iconFor, nameFor, update, filter)
}

/** Whether each reading permission takes in sources connected later. A linked Direct follows Answer. */
@Composable
internal fun AccessFutureQuestion(draft: AccessLevelDraft, overview: AccessOverview, update: (AccessLevelDraft) -> Unit) {
    val linked = draft.directLinked
    val capabilities = if (linked) listOf(AccessCapability.ANSWER) else draft.readingCapabilities
    capabilities.forEachIndexed { index, cap ->
        val rule = draft.rule(cap) ?: return@forEachIndexed
        val known = draft.knownSourceIds(overview)
        val value = AccessSourceSelectionState.from(rule.sources, known)
        fun set(allowed: Boolean) { if (allowed != value.futureSourcesAllowed) update(draft.setBoundary(value.setFutureSourcesAllowed(allowed, known).boundary(known), cap, overview.sourceFilters?.enabled)) }
        if (index > 0) AccessGap(AccessUi.SectionGap)
        AccessSectionHeading(if (linked) "Answer and Direct" else cap.title)
        AccessGap(AccessUi.HeadingGap)
        AccessOptions {
            AccessChoice("Keep new sources blocked", "I will allow each new source when I am ready.", !value.futureSourcesAllowed) { set(false) }
            AccessChoice("Allow new sources automatically", "New sources will be included without another approval.", value.futureSourcesAllowed) { set(true) }
        }
    }
}

/** How answers leave: reviewed by a chosen privacy policy, or released as they are. [readPolicy] opens the chosen policy's text where a screen can show it. */
@Composable
internal fun AccessReleaseQuestion(draft: AccessLevelDraft, overview: AccessOverview, readPolicy: ((String) -> Unit)? = null, update: (AccessLevelDraft) -> Unit) {
    val answer = draft.rule(AccessCapability.ANSWER) ?: return
    val reviewed = draft.requireAnswerPolicySelection || answer.release?.mode == AccessAnswerReleaseMode.REVIEWED
    val chosen = answer.release?.policyFamilyId?.takeIf { answer.release?.mode == AccessAnswerReleaseMode.REVIEWED && !draft.requireAnswerPolicySelection }
    AccessOptions {
        AccessChoice("Review answers with a privacy policy", "The selected privacy policy reviews each answer before it is released.", reviewed) {
            if (!reviewed) {
                val family = overview.startingPolicyId
                update(if (family == null) draft.copy(requireAnswerPolicySelection = true) else draft.setRule(answer.copy(release = AccessAnswerRelease.reviewed(family))).copy(requireAnswerPolicySelection = false))
            }
        }
        if (reviewed) {
            if (overview.policyFamilies.isEmpty()) AccessNotice("No published privacy policy is available. Publish one in Privacy, then return here. Releasing without privacy review is a separate choice below.")
            else PolicyPicker(overview.policyFamilies, chosen) { family -> update(draft.setRule(answer.copy(release = AccessAnswerRelease.reviewed(family))).copy(requireAnswerPolicySelection = false)) }
            if (chosen != null && overview.policyFamilies.none { it.id == chosen }) AccessNotice("The saved privacy policy is no longer published. It stays in force until you choose a different release setting.")
            else if (chosen != null && readPolicy != null) AccessTextAction("Read this policy") { readPolicy(chosen) }
        }
        AccessChoice("Release without privacy review", "The agent can only see data from allowed records, but no privacy reviewer checks the answer.", !reviewed) {
            update(draft.setRule(answer.copy(release = AccessAnswerRelease.unreviewed())).copy(requireAnswerPolicySelection = false))
        }
    }
}

/** The privacy policy that reviews answers, shown as a field that opens the published policies. */
@Composable
private fun PolicyPicker(families: List<AccessPolicyFamilySummary>, chosen: String?, choose: (String) -> Unit) {
    val colors = AccessUi.colors
    val editing = LocalAccessEditingEnabled.current
    var open by remember { mutableStateOf(false) }
    val name = families.firstOrNull { it.id == chosen }?.name
    Box {
        Row(Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(12.dp)).background(colors.surface)
            .clickable(enabled = editing, role = Role.DropdownList, onClickLabel = "Choose a privacy policy") { open = true }
            .padding(horizontal = 16.dp).semantics { contentDescription = "Privacy policy: ${name ?: "none chosen"}" },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(name ?: "Choose a policy", style = AccessType.RowTitle.copy(fontWeight = FontWeight.Normal), color = if (name != null) colors.primary else colors.muted,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = null, tint = colors.secondary, modifier = Modifier.size(22.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            families.forEach { family -> DropdownMenuItem(text = { Text(family.name) }, onClick = { choose(family.id); open = false }) }
        }
    }
}
