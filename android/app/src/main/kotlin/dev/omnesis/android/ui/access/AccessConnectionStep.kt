// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.unit.dp
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessOverview

/**
 * What the approved connection is called and which access level it uses — or, in replace
 * mode, which existing connection the new sign-in takes over. iOS and the portal ask the same
 * questions in the same words. The step is drawn with the level editor's headings, option cards
 * and name field. [levelNameTaken] marks the access level name the gateway refused as already
 * in use.
 */
@Composable
internal fun ConnectionStep(
    request: AccessAuthorizationRequest,
    overview: AccessOverview,
    form: AccessAuthorizationForm,
    nowMillis: Long,
    levelNameTaken: Boolean,
    update: (AccessAuthorizationForm) -> Unit,
) {
    val choice = form.connection ?: return
    val set: (AccessConnectionChoice) -> Unit = { update(form.copy(connection = it)) }
    if (choice.replacing) {
        ReplaceConnection(request, overview, choice, nowMillis, set)
    } else {
        ChooseAccessLevel(request, overview, form, choice, nowMillis, levelNameTaken, update, set)
    }
}

/** A heading of the step with the sentence that explains its choice. */
@Composable
private fun StepSection(title: String, explanation: String) {
    AccessSectionHeading(title)
    AccessGap(8.dp)
    Text(explanation, style = AccessType.Subtitle, color = AccessUi.colors.secondary)
    AccessGap(AccessUi.HeadingGap)
}

/** What marks the level or connection the gateway suggests for this agent. */
private const val SUGGESTED_TAG = "Suggested"

@Composable
private fun ChooseAccessLevel(
    request: AccessAuthorizationRequest,
    overview: AccessOverview,
    form: AccessAuthorizationForm,
    choice: AccessConnectionChoice,
    nowMillis: Long,
    levelNameTaken: Boolean,
    update: (AccessAuthorizationForm) -> Unit,
    set: (AccessConnectionChoice) -> Unit,
) {
    val suggested = choice.suggestedLevel(overview)
    Column {
        AccessSectionHeading("Connection name")
        AccessGap(AccessUi.HeadingGap)
        AccessNameField(choice.name, "Connection name", choice.nameError) { set(choice.copy(name = it)) }
        AccessGap(AccessUi.SectionGap)
        StepSection("Access level", "Connections that use the same access level share its permissions.")
        AccessOptions {
            choice.orderedLevels(overview).forEach { level ->
                val isSuggested = level.id == suggested?.id
                // A level that cannot serve this request cannot be picked, and says why.
                val unavailable = unavailableReason(level.rules, request)
                AccessChoice(level.name, null, choice.levelId == level.id, enabled = unavailable == null, tag = SUGGESTED_TAG.takeIf { isSuggested }, extra = {
                    AccessCapabilityPills(AccessCapabilityHoldings.of(level.rules), Modifier.alpha(if (unavailable == null) 1f else .55f))
                    AccessDetailText(connectionCountLabel(level.connectionCount), enabled = unavailable == null)
                    if (isSuggested) choice.proposal.match?.let { AccessDetailText("${it.connectionName} uses this access level.", enabled = unavailable == null) }
                    unavailable?.let { AccessDetailText(it) }
                }) { set(choice.copy(levelId = level.id)) }
            }
            AccessChoice(NEW_ACCESS_LEVEL_LABEL, null, choice.levelId == null) { set(choice.copy(levelId = null)) }
            // The new level is named as the level editor names one, under the option that creates it.
            if (choice.levelId == null) AccessNameField(form.level, overview, { update(form.copy(level = it)) }, taken = levelNameTaken)
        }
        if (liveConnections(overview, nowMillis).isNotEmpty()) {
            AccessGap(AccessUi.HeadingGap)
            AccessTextAction("Signing in again? Replace a connection", wrapping = true) { set(choice.copy(replacing = true)) }
        }
    }
}

@Composable
private fun ReplaceConnection(
    request: AccessAuthorizationRequest,
    overview: AccessOverview,
    choice: AccessConnectionChoice,
    nowMillis: Long,
    set: (AccessConnectionChoice) -> Unit,
) {
    val suggestedId = choice.suggestedConnection(overview, nowMillis)?.id
    Column {
        StepSection("Replace a connection", "The new sign-in takes over the chosen connection’s name and access level. Its old sign-in stops working.")
        AccessOptions {
            liveConnections(overview, nowMillis).forEach { target ->
                val isSuggested = target.id == suggestedId
                val unavailable = unavailableReason(target.grant.rules, request)
                AccessChoice(target.name, null, choice.connectionId == target.id, enabled = unavailable == null, tag = SUGGESTED_TAG.takeIf { isSuggested }, extra = {
                    overview.levels.firstOrNull { it.id == target.grant.levelId }?.let { AccessDetailText(connectionLevelLabel(it.name), enabled = unavailable == null) }
                    AccessDetailText(lastUsedLabel(target.lastUsedAt, nowMillis), enabled = unavailable == null)
                    if (isSuggested) AccessDetailText("Already connected on this device.", enabled = unavailable == null)
                    unavailable?.let { AccessDetailText(it) }
                }) { set(choice.copy(connectionId = target.id)) }
            }
        }
        AccessGap(AccessUi.HeadingGap)
        AccessTextAction("Connect as a new connection instead", wrapping = true) { set(choice.copy(replacing = false)) }
    }
}
