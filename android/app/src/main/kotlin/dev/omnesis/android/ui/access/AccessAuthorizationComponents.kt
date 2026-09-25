// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.border
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisColors
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessSourceInstance

/**
 * One source list. Checked rows are allowed, a single pair of options decides what happens to a
 * source connected later, and the refusal the list earns is printed inside it, named for every
 * capability the list governs.
 */
@Composable
internal fun SourceRuleEditor(
    title: String,
    scope: AccessSourceScope,
    sources: List<AccessSourceInstance>,
    value: AccessSourceSelectionState,
    iconFor: (String) -> SourceIconModel,
    update: (AccessSourceSelectionState) -> Unit,
) {
    val known = sources.filter { it.available }.mapTo(mutableSetOf()) { it.id }
    var query by remember(title) { mutableStateOf("") }
    val shown = sources.filter { query.isBlank() || it.name.contains(query, true) || it.id.contains(query, true) }
    Column(
        modifier = Modifier.selectableGroup(),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        SectionTitle(title)
        Text(
            "Checked sources are allowed. You can change this access later.",
            color = OmTheme.colors.textSecondary,
            style = MaterialTheme.typography.bodyMedium,
        )
        if (sources.isEmpty()) {
            Text(
                "No sources are connected.",
                color = OmTheme.colors.textSecondary,
                style = MaterialTheme.typography.bodyMedium,
            )
        } else {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("Search sources") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${known.count(value::allows)} of ${known.size} allowed",
                    color = OmTheme.colors.textSecondary,
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.weight(1f))
                OutlinedButton(onClick = { update(value.allowAll(known)) }) { Text("Allow all") }
                OutlinedButton(onClick = { update(value.blockAll(known)) }) { Text("Block all") }
            }
            shown.forEach { source ->
                SourceSelectionRow(source, value, iconFor) { update(value.setAllowed(source.id, it)) }
            }
            if (shown.isEmpty()) {
                Text(
                    "No sources match that search.",
                    color = OmTheme.colors.textSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        sourceBoundaryError(value, known, scope)?.let { FieldError(it) }
        SubsectionTitle("When you connect a new source")
        RadioRow("Keep it blocked until I allow it", null, !value.futureSourcesAllowed) {
            update(value.setFutureSourcesAllowed(false, known))
        }
        RadioRow("Allow it automatically", null, value.futureSourcesAllowed) {
            update(value.setFutureSourcesAllowed(true, known))
        }
    }
}

@Composable
private fun SourceSelectionRow(
    source: AccessSourceInstance,
    value: AccessSourceSelectionState,
    iconFor: (String) -> SourceIconModel,
    update: (Boolean) -> Unit,
) {
    val enabled = source.available
    val checked = source.available && value.allows(source.id)
    // Many rows of one list being picked from, so each is kept tight: the row
    // is the target, and the name carries it rather than the padding. iOS draws
    // the same row the same way.
    Row(
        Modifier.fillMaxWidth().toggleable(
            value = checked,
            enabled = enabled,
            role = Role.Checkbox,
            onValueChange = update,
        ).padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        SourceIcon(iconFor(source.id), size = 20.dp, modifier = Modifier.padding(horizontal = OmSpacing.sm))
        Column(Modifier.weight(1f)) {
            Text(
                source.name,
                fontWeight = FontWeight.Medium,
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                source.id,
                color = OmTheme.colors.textSecondary,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (!source.available) Text("Currently unavailable", color = OmTheme.colors.danger, fontSize = 11.sp)
        }
    }
    HorizontalDivider(color = OmTheme.colors.border)
}

/**
 * One capability, as the same pill everywhere it is named.
 *
 * A granted capability is lit in its own colour and a withheld one is the word gone faint, so a
 * capability's position never moves and a granted capability is never the withheld grey.
 */
@Composable
internal fun CapabilityBadge(
    capability: AccessCapabilitySlot,
    granted: Boolean,
    unreviewed: Boolean = false,
) {
    val tone = capabilityTone(capability, granted, unreviewed)
    val color = tone.color(OmTheme.colors)
    Box(
        Modifier
            .border(
                width = 1.dp,
                color = if (tone == AccessCapabilityTone.WITHHELD) Color.Transparent else color.copy(alpha = .55f),
                shape = RoundedCornerShape(50),
            )
            .padding(horizontal = 7.dp, vertical = 2.dp)
            .semantics {
                contentDescription = capabilityBadgeDescription(capability, granted, unreviewed)
            },
    ) {
        Text(
            capability.label.uppercase(),
            color = if (tone == AccessCapabilityTone.WITHHELD) color.copy(alpha = .55f) else color,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.4.sp,
            maxLines = 1,
        )
    }
}

/** Three fixed slots in a stable order, so scanning them answers which capabilities are held. */
@Composable
internal fun CapabilityTriad(
    answer: Boolean,
    direct: Boolean,
    notes: Boolean,
    unreviewed: Boolean = false,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        CapabilityBadge(AccessCapabilitySlot.ANSWER, answer, unreviewed)
        CapabilityBadge(AccessCapabilitySlot.DIRECT, direct)
        CapabilityBadge(AccessCapabilitySlot.NOTES, notes)
    }
}

internal fun AccessCapabilityTone.color(c: OmnesisColors): Color = when (this) {
    AccessCapabilityTone.REVIEWED -> c.success
    AccessCapabilityTone.RAW -> c.danger
    AccessCapabilityTone.WRITE -> c.accent
    AccessCapabilityTone.WARNING -> c.warning
    AccessCapabilityTone.WITHHELD -> c.textMuted
}

/**
 * The last look before access is granted: which connection gets it, which access level it uses,
 * and what that reaches. The permissions are the new level's as the form holds them, the
 * existing level's, or the replaced connection's, stated with the same rows either way. [legacyConnectionName] is the
 * connection a gateway that predates connections reconnects the client to. iOS and the portal
 * state the same rows in the same order.
 */
@Composable
internal fun ReviewStep(
    request: AccessAuthorizationRequest,
    overview: AccessOverview,
    form: AccessAuthorizationForm,
    legacyConnectionName: String? = null,
) {
    val review = remember(form, overview, request, legacyConnectionName) {
        reviewSummary(request, overview, form, legacyConnectionName)
    }
    val permissions = review.permissions
    val answerOn = permissions.answerEnabled || request.requiresAnswer
    val unreviewed = answerOn && permissions.answerRelease == AccessAnswerReleaseChoice.UNREVIEWED
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.lg)) {
        SectionTitle("Review access")
        ReviewRow("Connection", review.connectionName)
        review.accessLevel?.let { ReviewRow("Access level", it) }
        review.replaces?.let { ReviewRow("Replaces", it) }
        // The same three badges the capabilities were chosen with, so the thing being
        // approved looks like the thing that was picked.
        CapabilityTriad(
            answer = answerOn,
            direct = permissions.directEnabled,
            notes = permissions.notesEnabled,
            unreviewed = unreviewed,
        )
        permissions.sourceScopes(answerOn).forEach { scope ->
            ReviewRow("${scope.label} sources", sourceSummary(permissions.sources(scope), overview))
        }
        if (answerOn) {
            ReviewRow("Answer privacy", permissions.answerPrivacySummary(overview), warning = unreviewed)
        }
        if (permissions.notesEnabled) {
            ReviewRow("Notes", "Save notes; the agent\u2019s name is recorded")
        }
        sharedLevelFootnote(review.otherConnections)?.let {
            Text(it, color = OmTheme.colors.textSecondary)
        }
        Text(
            "Access can be edited or revoked later from Settings \u2192 Access in the Omnesis Portal.",
            color = OmTheme.colors.textSecondary,
        )
    }
}

@Composable
internal fun WizardActions(
    first: Boolean,
    last: Boolean,
    canContinue: Boolean,
    deciding: Boolean,
    onBack: () -> Unit,
    onContinue: () -> Unit,
    onDeny: () -> Unit,
    onAllow: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (first) TextButton(onClick = onDeny, enabled = !deciding) { Text("Deny") }
        else OutlinedButton(onClick = onBack, enabled = !deciding) { Text("Back") }
        Spacer(Modifier.weight(1f))
        Button(
            onClick = if (last) onAllow else onContinue,
            enabled = canContinue && !deciding,
            modifier = Modifier.height(48.dp),
        ) {
            if (deciding) OmSpinner(Modifier.size(18.dp)) else Text(if (last) "Allow access" else "Continue")
        }
    }
}

/**
 * One capability, on or off.
 *
 * [warning] is the capability's own consequence, stated once, here. It is quiet while the
 * capability is one option among three and turns bold and red the moment it applies.
 */
@Composable
internal fun CapabilityCard(
    title: String,
    detail: String,
    checked: Boolean,
    locked: Boolean,
    warning: String? = null,
    onChange: (Boolean) -> Unit,
) {
    val c = OmTheme.colors
    Card(
        modifier = Modifier.fillMaxWidth().toggleable(
            value = checked,
            enabled = !locked,
            role = Role.Checkbox,
            onValueChange = onChange,
        ),
        colors = CardDefaults.cardColors(containerColor = c.bgSecondary),
        border = when {
            !checked -> null
            warning != null -> BorderStroke(1.dp, c.danger)
            else -> BorderStroke(1.dp, c.accent)
        },
        shape = RoundedCornerShape(OmRadius.medium),
    ) {
        Row(Modifier.padding(OmSpacing.lg), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(checked, onCheckedChange = null, enabled = !locked)
            Column(Modifier.padding(start = OmSpacing.sm)) {
                Text(title, fontWeight = FontWeight.SemiBold)
                Text(detail, color = c.textSecondary, style = MaterialTheme.typography.bodyMedium)
                warning?.let {
                    Text(
                        it,
                        color = if (checked) c.danger else c.textSecondary,
                        fontWeight = if (checked) FontWeight.Bold else FontWeight.Normal,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
}

/**
 * One option in a group. [warning] is the amber a chosen-but-risky option carries: danger red
 * belongs to Direct alone, and two dangers on one step means neither is read as one.
 */
@Composable
internal fun RadioCard(title: String, detail: String?, selected: Boolean, warning: Boolean = false, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().selectable(
            selected = selected,
            role = Role.RadioButton,
            onClick = onClick,
        ),
        colors = CardDefaults.cardColors(containerColor = OmTheme.colors.bgSecondary),
        shape = RoundedCornerShape(OmRadius.medium),
    ) {
        Row(Modifier.padding(OmSpacing.lg), verticalAlignment = Alignment.Top) {
            RadioButton(selected, onClick = null)
            Column(Modifier.padding(start = OmSpacing.sm)) {
                Text(title, fontWeight = FontWeight.SemiBold, color = if (warning) OmTheme.colors.warning else OmTheme.colors.textPrimary)
                detail?.takeIf(String::isNotEmpty)?.let {
                    Text(
                        it,
                        color = if (warning) OmTheme.colors.warning else OmTheme.colors.textSecondary,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
        }
    }
}

@Composable
internal fun RadioRow(title: String, detail: String?, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().selectable(selected, role = Role.RadioButton, onClick = onClick)
            .padding(vertical = OmSpacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected, onClick = null)
        Column(Modifier.padding(start = OmSpacing.sm)) {
            Text(title, fontWeight = FontWeight.Medium)
            detail?.let { Text(it, color = OmTheme.colors.textSecondary, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable internal fun SubsectionTitle(text: String) =
    Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)

@Composable internal fun SectionTitle(text: String) =
    Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)

/** A refusal, printed beside the control that earns it rather than at the foot of the step. */
@Composable internal fun FieldError(text: String) =
    Text(text, color = OmTheme.colors.danger, style = MaterialTheme.typography.bodyMedium)

@Composable internal fun WarningCard(text: String) {
    Card(colors = CardDefaults.cardColors(containerColor = OmTheme.colors.danger.copy(alpha = .1f))) {
        Text(text, color = OmTheme.colors.danger, modifier = Modifier.padding(OmSpacing.md))
    }
}

/**
 * One fact of the review, its label above its value. [warning] is the amber an unreviewed
 * release carries here as everywhere else: danger red belongs to Direct alone.
 */
@Composable
private fun ReviewRow(label: String, value: String, warning: Boolean = false) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, color = OmTheme.colors.textSecondary)
        Text(
            value,
            fontWeight = FontWeight.SemiBold,
            color = if (warning) OmTheme.colors.warning else OmTheme.colors.textPrimary,
        )
    }
}

