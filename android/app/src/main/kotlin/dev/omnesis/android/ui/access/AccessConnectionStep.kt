// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.AccessAnswerReleaseMode
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessGrantRule
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.MAX_ACCESS_NAME_LENGTH

/**
 * What the approved connection is called and which access level it uses — or, in replace
 * mode, which existing connection the new sign-in takes over. iOS and the portal ask the same
 * questions in the same words. [levelNameTaken] marks the access level name the gateway
 * refused as already in use.
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
        ChooseAccessLevel(request, overview, choice, nowMillis, levelNameTaken, set)
    }
}

@Composable
private fun ChooseAccessLevel(
    request: AccessAuthorizationRequest,
    overview: AccessOverview,
    choice: AccessConnectionChoice,
    nowMillis: Long,
    levelNameTaken: Boolean,
    set: (AccessConnectionChoice) -> Unit,
) {
    val suggested = choice.suggestedLevel(overview)
    val levels = choice.orderedLevels(overview)
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        NameField("Connection name", choice.name, choice.nameError) { set(choice.copy(name = it)) }
        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            SectionTitle("Access level")
            Helper("Connections that use the same access level share its permissions.")
        }
        ChoiceList(
            footer = {
                // The last option is "New access level"; its name field sits under that title.
                if (choice.levelId == null) {
                    NameField(
                        label = "Access level name",
                        value = choice.levelName,
                        error = choice.levelNameError(overview),
                        taken = levelNameTaken,
                        modifier = Modifier.padding(start = RadioSize + OmSpacing.sm, bottom = OmSpacing.md),
                    ) {
                        set(choice.copy(levelName = it))
                    }
                }
            },
        ) {
            levels.forEach { level ->
                val isSuggested = level.id == suggested?.id
                ChoiceRow(
                    selected = choice.levelId == level.id,
                    unavailableReason = unavailableReason(level.rules, request),
                    onClick = { set(choice.copy(levelId = level.id)) },
                ) {
                    ChoiceTitle(level.name, isSuggested)
                    RulesTriad(level.rules)
                    Detail(connectionCountLabel(level.connectionCount))
                    if (isSuggested) {
                        choice.proposal.match?.let { Detail("${it.connectionName} uses this access level.") }
                    }
                }
                HorizontalDivider(color = OmTheme.colors.border)
            }
            ChoiceRow(
                selected = choice.levelId == null,
                unavailableReason = null,
                onClick = { set(choice.copy(levelId = null)) },
            ) {
                Text("New access level", fontWeight = FontWeight.Medium)
            }
        }
        if (liveConnections(overview, nowMillis).isNotEmpty()) {
            ModeButton("Signing in again? Replace a connection") { set(choice.copy(replacing = true)) }
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
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            SectionTitle("Replace a connection")
            Helper(
                "The new sign-in takes over the chosen connection's name and access level. " +
                    "Its old sign-in stops working.",
            )
        }
        ChoiceList {
            liveConnections(overview, nowMillis).forEachIndexed { index, target ->
                val isSuggested = target.id == suggestedId
                if (index > 0) HorizontalDivider(color = OmTheme.colors.border)
                ChoiceRow(
                    selected = choice.connectionId == target.id,
                    unavailableReason = unavailableReason(target.grant.rules, request),
                    onClick = { set(choice.copy(connectionId = target.id)) },
                ) {
                    ChoiceTitle(target.name, isSuggested)
                    overview.levels.firstOrNull { it.id == target.grant.levelId }?.let { Detail("Uses ${it.name}") }
                    Detail(lastUsedLabel(target.lastUsedAt, nowMillis))
                    if (isSuggested) Detail("Already connected on this device.")
                }
            }
        }
        ModeButton("Connect as a new connection instead") { set(choice.copy(replacing = false)) }
    }
}

/**
 * A radio list on the card ground, so the options read as one group. [footer] sits on the same
 * card below the options but outside the radio group, so a screen reader does not announce it
 * as one of them.
 */
@Composable
private fun ChoiceList(
    footer: @Composable ColumnScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = OmTheme.colors.bgSecondary),
        shape = RoundedCornerShape(OmRadius.medium),
    ) {
        Column(Modifier.padding(horizontal = OmSpacing.lg)) {
            Column(Modifier.selectableGroup(), content = content)
            footer()
        }
    }
}

/** One level or connection to pick. One that cannot serve this request is dimmed and says why. */
@Composable
private fun ChoiceRow(
    selected: Boolean,
    unavailableReason: String?,
    onClick: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val enabled = unavailableReason == null
    Row(
        Modifier
            .fillMaxWidth()
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .padding(vertical = OmSpacing.md),
        verticalAlignment = Alignment.Top,
    ) {
        RadioButton(selected, onClick = null, enabled = enabled, modifier = Modifier.size(RadioSize))
        Column(Modifier.padding(start = OmSpacing.sm).weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Column(
                Modifier.alpha(if (enabled) 1f else .55f),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                content = content,
            )
            unavailableReason?.let { Detail(it) }
        }
    }
}

/** The width of a row's radio, which a row's title and anything indented under it start after. */
private val RadioSize = 24.dp

/** An option's name, with the tag that marks the option suggested for this agent. */
@Composable
private fun ChoiceTitle(name: String, suggested: Boolean) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(name, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f, fill = false))
        if (suggested) SuggestedTag()
    }
}

/** Marks the level the matched connection uses, or the connection this agent already is. */
@Composable
private fun SuggestedTag() {
    val accent = OmTheme.colors.accent
    Box(
        Modifier
            .border(1.dp, accent.copy(alpha = .55f), RoundedCornerShape(50))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    ) {
        Text("Suggested", color = accent, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

/** The capability badges a saved set of permissions holds. */
@Composable
private fun RulesTriad(rules: List<AccessGrantRule>) {
    val answer = rules.firstOrNull { it.capability == AccessCapability.ANSWER }
    CapabilityTriad(
        answer = answer != null,
        direct = rules.any { it.capability == AccessCapability.DIRECT },
        notes = rules.any { it.capability == AccessCapability.NOTES },
        unreviewed = answer?.release?.mode == AccessAnswerReleaseMode.UNREVIEWED,
    )
}

/** Switches between choosing a level and replacing a connection. */
@Composable
private fun ModeButton(label: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, contentPadding = PaddingValues(horizontal = 0.dp, vertical = OmSpacing.xs)) {
        Text(label)
    }
}

@Composable
private fun Helper(text: String) =
    Text(text, color = OmTheme.colors.textSecondary, style = MaterialTheme.typography.bodyMedium)

@Composable
private fun Detail(text: String) =
    Text(text, color = OmTheme.colors.textSecondary, style = MaterialTheme.typography.bodySmall)

/**
 * A name the gateway stores, held to the length it accepts, with the refusal it earns printed
 * under the field. [taken] marks a name the gateway refused, whose refusal is stated above the step.
 *
 * The label sits at the start of the field's line, or above the field when the text is large or
 * the screen narrow. The field carries the label as its description, so a screen reader names
 * the field once instead of reading the label on its own first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NameField(
    label: String,
    value: String,
    error: String?,
    taken: Boolean = false,
    modifier: Modifier = Modifier,
    onChange: (String) -> Unit,
) {
    val stacked = LocalDensity.current.fontScale >= STACKED_LABEL_FONT_SCALE ||
        LocalConfiguration.current.screenWidthDp < STACKED_LABEL_MAX_WIDTH_DP
    val invalid = error != null || taken
    val colors = OutlinedTextFieldDefaults.colors()
    val interactionSource = remember { MutableInteractionSource() }
    // An outlined field built from its parts, so its height fits a single line of the label's
    // text: the stock field is sized for a floating label this row does not use.
    val field = @Composable { fieldModifier: Modifier ->
        BasicTextField(
            value = value,
            onValueChange = { onChange(utf16Prefix(it, MAX_ACCESS_NAME_LENGTH)) },
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(color = OmTheme.colors.textPrimary),
            cursorBrush = SolidColor(if (invalid) colors.errorCursorColor else colors.cursorColor),
            interactionSource = interactionSource,
            modifier = fieldModifier
                .heightIn(min = NAME_FIELD_MIN_HEIGHT)
                .semantics { contentDescription = label },
        ) { innerTextField ->
            OutlinedTextFieldDefaults.DecorationBox(
                value = value,
                innerTextField = innerTextField,
                enabled = true,
                singleLine = true,
                visualTransformation = VisualTransformation.None,
                interactionSource = interactionSource,
                isError = invalid,
                colors = colors,
                contentPadding = OutlinedTextFieldDefaults.contentPadding(top = OmSpacing.sm, bottom = OmSpacing.sm),
                container = {
                    OutlinedTextFieldDefaults.Container(
                        enabled = true,
                        isError = invalid,
                        interactionSource = interactionSource,
                        colors = colors,
                    )
                },
            )
        }
    }
    val labelText = @Composable { labelModifier: Modifier ->
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = labelModifier.clearAndSetSemantics {})
    }
    if (stacked) {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            labelText(Modifier)
            field(Modifier.fillMaxWidth())
            error?.let { FieldError(it) }
        }
    } else {
        Row(
            modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.md),
            verticalAlignment = Alignment.Top,
        ) {
            // Centred on the field's own line, so an error under the field does not move it.
            labelText(
                Modifier
                    .heightIn(min = NAME_FIELD_MIN_HEIGHT)
                    .wrapContentHeight(Alignment.CenterVertically),
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
                field(Modifier.fillMaxWidth())
                error?.let { FieldError(it) }
            }
        }
    }
}

/** A name field's height: one line of text inside a full-size touch target. */
private val NAME_FIELD_MIN_HEIGHT = 48.dp

/** From this font scale a name field's label moves above the field. */
private const val STACKED_LABEL_FONT_SCALE = 1.3f

/** Below this screen width a name field's label moves above the field. */
private const val STACKED_LABEL_MAX_WIDTH_DP = 360
