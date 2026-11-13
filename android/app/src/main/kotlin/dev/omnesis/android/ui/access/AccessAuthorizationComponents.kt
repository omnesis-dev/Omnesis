// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessOverview

/** What the approval is titled once its request is on screen, and what heads its last step. */
internal const val REVIEW_ACCESS_TITLE = "Review access"

/**
 * The last look before access is granted: which connection gets it and which access level it uses.
 * A new level, or the client's own access on a gateway without connections, is followed by every
 * decision this approval made, as the level editor's review of a new level states them; an existing
 * level, chosen or kept by a replaced connection, shows its capability pills on its own row instead.
 * [legacyConnectionName] is the connection a gateway that predates connections reconnects the client
 * to. [change] returns to the step a row was decided on.
 */
@Composable
internal fun ReviewStep(
    request: AccessAuthorizationRequest,
    overview: AccessOverview,
    form: AccessAuthorizationForm,
    legacyConnectionName: String? = null,
    positions: List<AccessAuthorizationPosition> = emptyList(),
    change: (AccessAuthorizationPosition) -> Unit = {},
) {
    val review = remember(form, overview, request, legacyConnectionName) {
        reviewSummary(request, overview, form, legacyConnectionName)
    }
    val connection = positions.firstOrNull { it.step == AccessAuthorizationStep.CONNECTION }
    val permissions = positions.firstOrNull { it.step == AccessAuthorizationStep.PERMISSIONS }
    Column {
        AccessSectionHeading(REVIEW_ACCESS_TITLE)
        AccessGap(AccessUi.HeadingGap)
        val identity = listOfNotNull("Connection" to review.connectionName, review.accessLevel?.let { "Access level" to it }, review.replaces?.let { "Replaces" to it })
        // This approval decides a new level's permissions, or the client's own on a gateway without connections;
        // those decisions follow as rows, Permissions with its pills. An existing level is taken as it is: its
        // row carries the pills it was listed with, so the thing being approved looks like the thing picked.
        val decides = form.decidesPermissions
        identity.forEach { (title, value) ->
            AccessDecisionRow(title, value, action = "Change".takeIf { connection != null }, actionDescription = changeDescription(title),
                capabilities = AccessCapabilityHoldings.of(review.rules).takeIf { title == "Access level" && !decides }) { connection?.let(change) }
        }
        // An existing level is listed read-only under its row, decision by decision as the level page states them.
        if (!decides && review.accessLevel != null && review.replaces == null) {
            val decisions = levelDecisions("", review.rules, overview, directLinkedIn(review.rules)).filter { it.page != AccessLevelPage.NAME && it.page != AccessLevelPage.PERMISSIONS }
            decisions.forEachIndexed { index, decision -> AccessDecisionRow(decision, last = index == decisions.lastIndex) }
        }
        if (decides) AccessDecisionSummary(review.rules, overview, linked = review.linked, change = if (permissions == null) null else { page ->
            val target = if (page == AccessLevelPage.PERMISSIONS) permissions
                else positions.firstOrNull { it.dataPage == page } ?: positions.firstOrNull { it.dataPage != null && it.dataPage.capability() == page.capability() }
            target?.let(change)
        })
        AccessGap(OmSpacing.lg)
        sharedLevelFootnote(review.otherConnections)?.let {
            AccessDetailText(it)
            AccessGap(OmSpacing.sm)
        }
        AccessDetailText("Access can be edited or revoked later from Settings \u2192 Access in the Omnesis Portal.")
    }
}

/**
 * The approval's actions: deny or go back at the leading edge, and the step's one primary action filling the rest.
 * [note] says above them what the step is still waiting for.
 */
@Composable
internal fun WizardActions(
    first: Boolean,
    last: Boolean,
    canContinue: Boolean,
    deciding: Boolean,
    note: String? = null,
    onBack: () -> Unit,
    onContinue: () -> Unit,
    onDeny: () -> Unit,
    onAllow: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = AccessUi.Inset).padding(top = 12.dp, bottom = 16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        note?.let { AccessDetailText(it) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(OmSpacing.md), verticalAlignment = Alignment.CenterVertically) {
            AccessTextAction(if (first) "Deny" else "Back", Modifier.padding(horizontal = OmSpacing.md), enabled = !deciding, danger = first, style = AccessType.Button, alignment = Alignment.Center, onClick = if (first) onDeny else onBack)
            AccessPrimaryButton(if (last) "Allow access" else "Continue", enabled = canContinue && !deciding, modifier = Modifier.weight(1f), onClick = if (last) onAllow else onContinue)
        }
    }
}
