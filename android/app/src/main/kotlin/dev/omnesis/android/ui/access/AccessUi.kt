// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AccessSourceInstance
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import kotlinx.coroutines.delay

internal val LocalAccessEditingEnabled = staticCompositionLocalOf { true }

/** The colours every access screen draws with, in the current theme. */
internal data class AccessPalette(
    val background: Color, val surface: Color, val divider: Color,
    val primary: Color, val secondary: Color, val muted: Color,
    val accent: Color, val onAccent: Color, val danger: Color, val success: Color,
)

internal object AccessUi {
    val colors: AccessPalette
        @Composable @ReadOnlyComposable get() {
            val theme = OmTheme.colors
            // Secondary and muted text share the theme's secondary token, which reads at 4.5:1 or more on the page and on surfaces.
            return if (theme.isDark) AccessPalette(theme.bgPrimary, theme.bgSecondary, Color(0xFF232A33), theme.textPrimary, theme.textSecondary, theme.textSecondary, theme.accent, theme.bgPrimary, theme.danger, theme.success)
            else AccessPalette(theme.bgPrimary, Color(0xFFF3F5F8), Color(0xFFE3E7EC), theme.textPrimary, theme.textSecondary, theme.textSecondary, theme.accent, Color.White, theme.danger, theme.success)
        }

    /** The horizontal inset of content, top bar actions and the bottom button. */
    val Inset = 20.dp
    /** The gap between two sections of one screen. */
    val SectionGap = 32.dp
    /** The gap between a section heading and its first row. */
    val HeadingGap = 12.dp
    /** The gap between a screen's title block and its content. */
    val ContentGap = 24.dp
    /** The gap between two option cards. */
    val CardGap = 10.dp
    /** The label column of a Before/After pair, which anything listed under one of its values aligns to. */
    val BeforeAfterLabelWidth = 56.dp
}

private fun accessText(size: TextUnit, line: TextUnit, weight: FontWeight = FontWeight.Normal) = TextStyle(
    fontSize = size, lineHeight = line, fontWeight = weight,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
    lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.Both),
)

/** The type scale of the access screens. */
internal object AccessType {
    val BarTitle = accessText(17.sp, 22.sp, FontWeight.SemiBold)
    val BarAction = accessText(17.sp, 22.sp)
    val Caption = accessText(13.sp, 18.sp, FontWeight.SemiBold)
    val Question = accessText(26.sp, 32.sp, FontWeight.SemiBold).copy(lineBreak = LineBreak.Heading)
    val Subtitle = accessText(15.sp, 21.sp)
    val Heading = accessText(17.sp, 22.sp, FontWeight.SemiBold)
    val RowTitle = accessText(16.sp, 22.sp, FontWeight.Medium)
    val RowSecondary = accessText(14.sp, 20.sp)
    val RowAction = accessText(16.sp, 22.sp)
    val CardTitle = accessText(16.sp, 22.sp, FontWeight.SemiBold).copy(lineBreak = LineBreak.Heading)
    val Pill = accessText(12.sp, 16.sp, FontWeight.SemiBold)
    val CapabilityPill = accessText(11.sp, 14.sp, FontWeight.SemiBold).copy(letterSpacing = .4.sp)
    val Button = accessText(16.sp, 22.sp, FontWeight.SemiBold)
    val Stat = accessText(28.sp, 34.sp, FontWeight.SemiBold)
    val Small = accessText(13.sp, 18.sp)
    val DialogTitle = accessText(18.sp, 24.sp, FontWeight.SemiBold)
}

/** A vertical gap between two parts of a screen. */
@Composable
internal fun AccessGap(height: Dp) = Spacer(Modifier.height(height))

/** A text action of a top bar or a row: accent text over a full-size touch target. A [wrapping] action is a sentence that may take more than one line. */
@Composable
internal fun AccessTextAction(
    label: String, modifier: Modifier = Modifier, enabled: Boolean = true, danger: Boolean = false,
    style: TextStyle = AccessType.RowAction, alignment: Alignment = Alignment.CenterStart, description: String? = null, wrapping: Boolean = false, onClick: () -> Unit,
) {
    val colors = AccessUi.colors
    Box(modifier.defaultMinSize(minWidth = 44.dp, minHeight = 44.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier), contentAlignment = alignment) {
        Text(label, style = style, color = if (!enabled) colors.muted else if (danger) colors.danger else colors.accent, maxLines = if (wrapping) Int.MAX_VALUE else 1)
    }
}

/** The top bar: a centred title, one leading text action and at most one trailing action. */
@Composable
internal fun AccessTopBar(title: String, leading: String, onLeading: () -> Unit, enabled: Boolean = true, trailing: (@Composable () -> Unit)? = null) {
    val colors = AccessUi.colors
    Box(Modifier.fillMaxWidth().background(colors.background).statusBarsPadding().height(56.dp).padding(horizontal = AccessUi.Inset)) {
        AccessTextAction(leading, Modifier.align(Alignment.CenterStart), enabled = enabled, style = AccessType.BarAction, onClick = onLeading)
        Text(title, style = AccessType.BarTitle, color = colors.primary, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.align(Alignment.Center).padding(horizontal = 76.dp).semantics { heading() })
        if (trailing != null) Box(Modifier.align(Alignment.CenterEnd)) { trailing() }
    }
}

/** The one primary action of a screen: a full-width capsule holding a short label. */
@Composable
internal fun AccessPrimaryButton(label: String, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = AccessUi.colors
    Box(modifier.fillMaxWidth().height(52.dp).clip(CircleShape).background(if (enabled) colors.accent else colors.surface)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick), contentAlignment = Alignment.Center) {
        Text(label, style = AccessType.Button, color = if (enabled) colors.onAccent else colors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** The caption, question and subtitle that open a decision, on any screen that asks one. */
@Composable
internal fun AccessQuestionHeader(question: String, modifier: Modifier = Modifier, caption: String? = null, subtitle: String? = null, compact: Boolean = false, account: (@Composable () -> Unit)? = null) {
    val colors = AccessUi.colors
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (caption != null && !compact) Text(caption, style = AccessType.Caption, color = colors.accent, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(question, style = if (compact) AccessType.Heading else AccessType.Question, color = colors.primary, maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.semantics { heading() })
        if (subtitle != null && !compact) Text(subtitle, style = AccessType.Subtitle, color = colors.secondary)
        if (account != null && !compact) account()
    }
}

/**
 * One access task: the top bar, a question with its caption and subtitle, the content, and one primary
 * button pinned under it. Content scrolls above the button and never under it.
 *
 * [leading] is the single top-left action; [onCancel] adds a top-right "Cancel" beside it. [banner] sits
 * above the caption. [account] names the account the question is about, under the subtitle.
 */
@Composable
internal fun AccessTaskScaffold(
    title: String, question: String, primary: String, enabled: Boolean, onPrimary: () -> Unit,
    leading: String, onLeading: () -> Unit, caption: String? = null, subtitle: String? = null,
    onCancel: (() -> Unit)? = null, footer: String? = null, scrollable: Boolean = true, busy: Boolean = false,
    compactHeader: Boolean = false, focusKey: Any? = null, account: (@Composable () -> Unit)? = null,
    banner: (@Composable () -> Unit)? = null, content: @Composable ColumnScope.() -> Unit,
) {
    val colors = AccessUi.colors
    val scroll = rememberScrollState()
    val focus = remember { FocusRequester() }
    Column(Modifier.fillMaxSize().background(colors.background)) {
        AccessTopBar(title, leading, onLeading, enabled = !busy,
            trailing = if (onCancel != null) { { AccessTextAction("Cancel", enabled = !busy, style = AccessType.BarAction, alignment = Alignment.CenterEnd, onClick = onCancel) } } else null)
        Column(Modifier.weight(1f).fillMaxWidth().then(if (scrollable) Modifier.verticalScroll(scroll) else Modifier)
            .padding(horizontal = AccessUi.Inset).padding(top = if (compactHeader) 4.dp else 12.dp, bottom = if (scrollable) 24.dp else 0.dp)) {
            if (banner != null) { banner(); AccessGap(20.dp) }
            AccessQuestionHeader(question, Modifier.focusRequester(focus).focusable(), caption, subtitle, compactHeader, account)
            LaunchedEffect(question, focusKey) { if (scrollable) scroll.scrollTo(0); focus.requestFocus() }
            AccessGap(if (compactHeader) 12.dp else AccessUi.ContentGap)
            content()
        }
        Column(Modifier.fillMaxWidth().background(colors.background).imePadding().navigationBarsPadding().padding(horizontal = AccessUi.Inset).padding(top = 12.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            footer?.let { AccessDetailText(it) }
            AccessPrimaryButton(primary, enabled, onClick = onPrimary)
        }
    }
}

/** A line of secondary text: what an option means, what a row holds, what a screen's button is waiting for. */
@Composable
internal fun AccessDetailText(text: String, enabled: Boolean = true) {
    Text(text, style = AccessType.RowSecondary, color = if (enabled) AccessUi.colors.secondary else AccessUi.colors.muted)
}

/** A section heading in sentence case. */
@Composable
internal fun AccessSectionHeading(text: String, modifier: Modifier = Modifier) {
    Text(text, style = AccessType.Heading, color = AccessUi.colors.primary, modifier = modifier.semantics { heading() })
}

/** The hairline under a row, starting [inset] from the row's leading edge so it lines up with the row's text. */
@Composable
internal fun AccessDivider(inset: Dp = 0.dp) {
    Box(Modifier.fillMaxWidth().padding(start = inset).height(1.dp).background(AccessUi.colors.divider))
}

/** A tick box: accent when ticked, an outline otherwise. */
@Composable
internal fun AccessCheckMark(checked: Boolean, enabled: Boolean = true) {
    val colors = AccessUi.colors
    val shape = RoundedCornerShape(6.dp)
    Box(Modifier.size(22.dp).clip(shape).then(if (checked) Modifier.background(if (enabled) colors.accent else colors.muted) else Modifier.border(1.5.dp, if (enabled) colors.secondary else colors.muted, shape)),
        contentAlignment = Alignment.Center) {
        if (checked) Icon(Icons.Filled.Check, contentDescription = null, tint = colors.onAccent, modifier = Modifier.size(16.dp))
    }
}

/** A radio mark: an accent ring holding a dot when selected, an outline otherwise. */
@Composable
internal fun AccessRadioMark(selected: Boolean, enabled: Boolean = true) {
    val colors = AccessUi.colors
    val tint = if (!enabled) colors.muted else if (selected) colors.accent else colors.secondary
    Box(Modifier.size(22.dp).border(1.5.dp, tint, CircleShape), contentAlignment = Alignment.Center) {
        if (selected) Box(Modifier.size(10.dp).background(tint, CircleShape))
    }
}

/**
 * An option card: its control on the left, an outline once selected, in the danger colour when the choice carries a
 * [warning]. [tag] is a pill beside the title; [extra] is whatever else the option states, under its detail.
 */
@Composable
private fun AccessOptionCard(
    selected: Boolean, enabled: Boolean, modifier: Modifier, title: String, detail: String?, warning: String?,
    tag: String? = null, extra: (@Composable ColumnScope.() -> Unit)? = null, control: @Composable () -> Unit,
) {
    val colors = AccessUi.colors
    val shape = RoundedCornerShape(14.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(colors.surface)
        .then(if (selected) Modifier.border(1.5.dp, if (warning != null) colors.danger else colors.accent, shape) else Modifier)
        .then(modifier).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        control()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (tag == null) Text(title, style = AccessType.CardTitle, color = if (enabled) colors.primary else colors.muted)
            else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(title, style = AccessType.CardTitle, color = if (enabled) colors.primary else colors.muted, modifier = Modifier.weight(1f, fill = false))
                AccessPill(tag, AccessPillTone.ACCENT)
            }
            detail?.let { AccessDetailText(it, enabled) }
            warning?.let { Text(it, style = if (selected) AccessType.RowSecondary.copy(fontWeight = FontWeight.SemiBold) else AccessType.RowSecondary, color = if (selected) colors.danger else colors.secondary) }
            if (extra != null) extra()
        }
    }
}

/** One of several exclusive options. [tag] marks it beside its title; [extra] states more about it under its detail. */
@Composable
internal fun AccessChoice(
    title: String, detail: String?, selected: Boolean, enabled: Boolean = true, tag: String? = null,
    extra: (@Composable ColumnScope.() -> Unit)? = null, choose: () -> Unit,
) {
    val editable = enabled && LocalAccessEditingEnabled.current
    AccessOptionCard(selected, editable, Modifier.selectable(selected = selected, enabled = editable, role = Role.RadioButton, onClick = choose), title, detail, null, tag, extra) {
        AccessRadioMark(selected, editable)
    }
}

/** An option that is on or off. [warning] is a consequence of switching it on; [locked] holds it as it is. */
@Composable
internal fun AccessToggleChoice(title: String, detail: String, checked: Boolean, warning: String? = null, locked: Boolean = false, change: (Boolean) -> Unit) {
    val editable = !locked && LocalAccessEditingEnabled.current
    AccessOptionCard(checked, true, Modifier.toggleable(enabled = editable, value = checked, role = Role.Checkbox, onValueChange = change), title, detail, warning) {
        AccessCheckMark(checked, editable)
    }
}

/** Option cards stacked with the gap they share. */
@Composable
internal fun AccessOptions(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(AccessUi.CardGap), content = content)
}

internal enum class AccessPillTone { NEUTRAL, ACCENT, DANGER, SUCCESS, OUTLINE }

/** A short status label. */
@Composable
internal fun AccessPill(text: String, tone: AccessPillTone = AccessPillTone.NEUTRAL) {
    val colors = AccessUi.colors
    val shape = RoundedCornerShape(6.dp)
    val tint = when (tone) {
        AccessPillTone.ACCENT -> colors.accent
        AccessPillTone.DANGER -> colors.danger
        AccessPillTone.SUCCESS -> colors.success
        AccessPillTone.NEUTRAL -> colors.secondary
        AccessPillTone.OUTLINE -> colors.muted
    }
    val ground = when (tone) {
        AccessPillTone.NEUTRAL -> Modifier.background(colors.surface, shape)
        AccessPillTone.OUTLINE -> Modifier.border(1.dp, colors.muted, shape)
        else -> Modifier.background(tint.copy(alpha = .16f), shape)
    }
    Box(Modifier.height(24.dp).then(ground).padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
        Text(text, style = AccessType.Pill, color = tint, maxLines = 1)
    }
}

/**
 * Which of Answer, Direct and Notes a level allows, as three small pills that always stand in this order:
 * Answer in the success colour, Direct in the danger colour and Notes in the accent colour, each drawn as
 * its colour's text over a faint wash of it with a softened outline. A capability that is not allowed
 * keeps the shape in the muted colour with no wash. Every place that lists a level's capabilities draws
 * them with this row.
 */
@Composable
internal fun AccessCapabilityPills(holdings: AccessCapabilityHoldings, modifier: Modifier = Modifier) {
    Row(modifier.clearAndSetSemantics { contentDescription = holdings.description }, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        ACCESS_CAPABILITIES.forEach { capability -> AccessCapabilityPill(capability, holdings.holds(capability)) }
    }
}

/** One capability's pill, in its colour when [held] and muted otherwise, as [AccessCapabilityPills] draws each. */
@Composable
internal fun AccessCapabilityPill(capability: AccessCapability, held: Boolean) {
    val colors = AccessUi.colors
    val tint = when (capabilityTone(capability, held)) {
        AccessCapabilityTone.REVIEWED -> colors.success
        AccessCapabilityTone.RAW -> colors.danger
        AccessCapabilityTone.WRITE -> colors.accent
        AccessCapabilityTone.WITHHELD -> colors.muted
    }
    AccessTag(capability.title, tint, filled = held)
}

/** A small uppercase tag in [tint]: an outline, with a faint wash of the tint when [filled]. Capability pills and the integration tag share it. */
@Composable
internal fun AccessTag(text: String, tint: Color, filled: Boolean = false) {
    val shape = RoundedCornerShape(5.dp)
    Box(Modifier.height(20.dp).then(if (filled) Modifier.background(tint.copy(alpha = .10f), shape) else Modifier).border(1.dp, tint.copy(alpha = if (filled) .45f else .60f), shape)
        .padding(horizontal = 7.dp), contentAlignment = Alignment.Center) {
        Text(text.uppercase(), style = AccessType.CapabilityPill, color = tint, maxLines = 1)
    }
}

/** A secondary action inside a screen's body: an outlined, full-width button with an accent label that may wrap. */
@Composable
internal fun AccessSecondaryButton(label: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = AccessUi.colors
    val shape = RoundedCornerShape(12.dp)
    Box(modifier.fillMaxWidth().heightIn(min = 44.dp).clip(shape).border(1.dp, colors.divider, shape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp), contentAlignment = Alignment.Center) {
        Text(label, style = AccessType.Button, color = if (enabled) colors.accent else colors.muted, textAlign = TextAlign.Center)
    }
}

/** A notice on the surface colour; an [error] takes the danger tint and is announced at once. */
@Composable
internal fun AccessNotice(message: String, error: Boolean = false) {
    val colors = AccessUi.colors
    Text(message, style = AccessType.Subtitle, color = if (error) colors.primary else colors.secondary,
        modifier = Modifier.fillMaxWidth().background(if (error) colors.danger.copy(alpha = .14f) else colors.surface, RoundedCornerShape(12.dp)).padding(16.dp)
            .semantics { liveRegion = if (error) LiveRegionMode.Assertive else LiveRegionMode.Polite })
}

/** A banner above a screen's caption: what happened, and the one action that answers it. */
@Composable
internal fun AccessBanner(message: String, action: String, enabled: Boolean = true, onAction: () -> Unit) {
    val colors = AccessUi.colors
    Column(Modifier.fillMaxWidth().background(colors.danger.copy(alpha = .14f), RoundedCornerShape(12.dp)).padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp)
        .semantics { liveRegion = LiveRegionMode.Assertive }) {
        Text(message, style = AccessType.Subtitle, color = colors.primary)
        AccessTextAction(action, enabled = enabled, style = AccessType.Subtitle.copy(fontWeight = FontWeight.SemiBold), onClick = onAction)
    }
}

/** A spinner beside what is being waited for. */
@Composable
internal fun AccessProgressLine(text: String) {
    val colors = AccessUi.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        AccessSpinner()
        Text(text, style = AccessType.Subtitle, color = colors.secondary)
    }
}

/** How far a long task has come, as a thin bar that fills from the leading edge. */
@Composable
internal fun AccessProgressBar(fraction: Float, modifier: Modifier = Modifier) {
    val colors = AccessUi.colors
    val shown = fraction.coerceIn(0f, 1f)
    Box(modifier.fillMaxWidth().height(6.dp).clip(CircleShape).background(colors.divider)
        .semantics { progressBarRangeInfo = ProgressBarRangeInfo(shown, 0f..1f) }) {
        Box(Modifier.fillMaxWidth(shown).fillMaxHeight().clip(CircleShape).background(colors.accent))
    }
}

/** A row of a list: at least 56 high, with a hairline under it from [dividerInset] unless it is the section's last. */
@Composable
internal fun AccessRow(modifier: Modifier = Modifier, last: Boolean = false, dividerInset: Dp = 0.dp, alignment: Alignment.Vertical = Alignment.CenterVertically, content: @Composable RowScope.() -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Row(modifier.fillMaxWidth().heightIn(min = 56.dp).padding(vertical = 14.dp), verticalAlignment = alignment, horizontalArrangement = Arrangement.spacedBy(12.dp), content = content)
        if (!last) AccessDivider(dividerInset)
    }
}

/**
 * A decision in a list: its name, what it holds, and a trailing action that opens it. [capabilities] adds
 * their pills under [value]; a null [value] leaves only the pills.
 */
@Composable
internal fun AccessDecisionRow(title: String, value: String?, last: Boolean = false, action: String? = null, actionDescription: String? = null, capabilities: AccessCapabilityHoldings? = null, onAction: () -> Unit = {}) {
    val colors = AccessUi.colors
    AccessRow(last = last) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(if (value == null) 8.dp else 4.dp)) {
            Text(title, style = AccessType.RowTitle, color = colors.primary)
            value?.let { Text(it, style = AccessType.RowSecondary, color = colors.secondary) }
            capabilities?.let { AccessCapabilityPills(it, Modifier.padding(top = if (value == null) 0.dp else 4.dp)) }
        }
        if (action != null) AccessTextAction(action, enabled = LocalAccessEditingEnabled.current, alignment = Alignment.CenterEnd, description = actionDescription, onClick = onAction)
    }
}

/** A decision of a level in a list, as [levelDecisions] states it: a decision of capabilities is shown as their pills. */
@Composable
internal fun AccessDecisionRow(decision: AccessDecision, last: Boolean = false, action: String? = null, onAction: () -> Unit = {}) =
    AccessDecisionRow(decision.title, decision.value.takeIf { decision.capabilities == null }, last, action, changeDescription(decision.title), decision.capabilities, onAction)

/** The names an account is shown by: its source on the first line, the account itself on the second. */
internal data class AccessAccountName(val source: String, val account: String?) {
    val line: String get() = listOfNotNull(source, account).joinToString(" · ")
}

/**
 * Splits an account's display name into its source and its account. [nameFor] is the catalog's name for
 * the source of an id; without one, a name the gateway joined as "source · account" is split there.
 */
internal fun AccessSourceInstance.accountName(nameFor: (String) -> String? = { null }): AccessAccountName {
    nameFor(id)?.let { family -> return AccessAccountName(family, accountLabel(family)) }
    val parts = name.split(" · ", limit = 2)
    return if (parts.size == 2) AccessAccountName(parts[0], parts[1]) else AccessAccountName(name, accountLabel())
}

/** An account the access level still names although no source reports it any more. */
internal fun disconnectedAccount(id: String, nameFor: (String) -> String? = { null }): AccessSourceInstance =
    AccessSourceInstance(id, "${nameFor(id) ?: "Account"} · $DISCONNECTED_ACCOUNT_LABEL", available = false)

internal const val DISCONNECTED_ACCOUNT_LABEL = "no longer connected"

/**
 * The icon of an account: the catalog's art for its id, else for its declared source type, else the art
 * the access overview carries for it. An id the catalog cannot place still shows its source's icon.
 */
internal fun accessSourceIcon(source: AccessSourceInstance, iconFor: (String) -> SourceIconModel): SourceIconModel {
    val byId = iconFor(source.id)
    if (!byId.imageData.isNullOrBlank()) return byId
    source.sourceType?.let(iconFor)?.takeIf { !it.imageData.isNullOrBlank() }?.let { return it }
    return source.icon?.takeIf { it.isNotBlank() }?.let { byId.copy(imageData = it) } ?: byId
}

/** Text on one line that drops its middle, not its end, when it does not fit. */
@Composable
internal fun AccessMiddleText(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    val measurer = rememberTextMeasurer()
    BoxWithConstraints(modifier) {
        val width = constraints.maxWidth
        val shown = remember(text, style, width) {
            fun fits(candidate: String) = measurer.measure(candidate, style, maxLines = 1, softWrap = false).size.width <= width
            if (fits(text)) text else {
                var keep = text.length - 1
                var candidate = "…"
                while (keep > 0) {
                    val head = (keep + 1) / 2
                    candidate = text.take(head).trimEnd() + "…" + text.takeLast(keep - head).trimStart()
                    if (fits(candidate)) break
                    keep--
                }
                candidate
            }
        }
        Text(shown, style = style, color = color, maxLines = 1, softWrap = false, modifier = Modifier.semantics { contentDescription = text })
    }
}

/**
 * An account in a list: an optional tick box, the source's icon, then the source name, the account and a
 * status pill on three lines, with an optional trailing action. The tick box, the icon and the action are
 * centred on the row; the hairline under it spans the row.
 *
 * [checked] null draws no tick box, for a list that is read and not chosen from.
 */
@Composable
internal fun AccessAccountRow(
    name: AccessAccountName, icon: SourceIconModel, last: Boolean = false, checked: Boolean? = null, enabled: Boolean = true,
    onToggle: (Boolean) -> Unit = {}, action: String? = null, actionDescription: String? = null, onAction: () -> Unit = {},
    status: @Composable () -> Unit,
) {
    val colors = AccessUi.colors
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).then(if (checked != null) Modifier.toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = onToggle) else Modifier.semantics(mergeDescendants = true) {})
                .padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (checked != null) AccessCheckMark(checked, enabled)
                SourceIcon(icon, size = 24.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(name.source, style = AccessType.RowTitle, color = colors.primary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    name.account?.let { AccessMiddleText(it, AccessType.RowSecondary, colors.secondary, Modifier.fillMaxWidth()) }
                    Box(Modifier.padding(top = 4.dp)) { status() }
                }
            }
            if (action != null) AccessTextAction(action, Modifier.padding(start = 12.dp), enabled = LocalAccessEditingEnabled.current, alignment = Alignment.CenterEnd, description = actionDescription, onClick = onAction)
        }
        if (!last) AccessDivider()
    }
}

/** The account a question is about, on one line under the question. */
@Composable
internal fun AccessAccountLine(name: AccessAccountName, icon: SourceIconModel, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(top = 4.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        SourceIcon(icon, size = 20.dp)
        AccessMiddleText(name.line, AccessType.Subtitle, AccessUi.colors.secondary, Modifier.weight(1f))
    }
}

/** Lets a child reach both screen edges from inside content inset by [AccessUi.Inset]. */
private fun Modifier.bleedToScreenEdges(): Modifier = layout { measurable, constraints ->
    val extra = AccessUi.Inset.roundToPx() * 2
    val placeable = measurable.measure(constraints.copy(minWidth = constraints.minWidth + extra, maxWidth = constraints.maxWidth + extra))
    layout(placeable.width - extra, placeable.height) { placeable.place(-AccessUi.Inset.roundToPx(), 0) }
}

/** The kinds a filter can match, as tabs in a row that scrolls past both screen edges. */
@Composable
internal fun AccessKindTabs(kinds: List<Pair<String, String>>, selected: String, select: (String) -> Unit) {
    val colors = AccessUi.colors
    val shape = RoundedCornerShape(8.dp)
    Row(Modifier.bleedToScreenEdges().fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = AccessUi.Inset).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        kinds.forEach { (kind, label) ->
            val current = kind == selected
            Box(Modifier.height(36.dp).clip(shape).then(if (current) Modifier.background(colors.surface) else Modifier.border(1.dp, colors.divider, shape))
                .selectable(selected = current, role = Role.Tab, onClick = { select(kind) }).padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                Text(label, style = AccessType.RowSecondary.copy(fontWeight = FontWeight.Medium), color = if (current) colors.primary else colors.secondary, maxLines = 1)
            }
        }
    }
}

/**
 * One side of a change: "Before" or "After" in a fixed leading column, then what that side held. A value
 * that leads with a status pill sets [pill], which drops the label to the pill's centre line.
 */
@Composable
internal fun AccessBeforeAfterRow(after: Boolean, pill: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    val colors = AccessUi.colors
    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Text(if (after) "After" else "Before", style = AccessType.RowSecondary.copy(fontWeight = FontWeight.Medium), color = if (after) colors.accent else colors.secondary,
            modifier = Modifier.width(AccessUi.BeforeAfterLabelWidth).padding(top = if (pill) 2.dp else 0.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp), content = content)
    }
}

/** A value of a Before/After row. */
@Composable
internal fun AccessChangeValue(text: String, after: Boolean) {
    val colors = AccessUi.colors
    Text(text, style = AccessType.RowSecondary, color = if (after) colors.primary else colors.secondary)
}

internal enum class FilterItemMark(val label: String) { ADDED("Added"), REMOVED("Removed") }

/**
 * One item of a filter: its type as a small caption when known, its name, and how many records it matches at the
 * trailing edge. A [mark] says what an edit did to it; a removed item is struck through. While [counting],
 * a small spinner stands where the count will be. [detail] is a second line under the name; [trailing]
 * replaces the count with an action.
 */
@Composable
internal fun AccessFilterItemRow(caption: String?, name: String, count: Long?, last: Boolean = false, mark: FilterItemMark? = null, counting: Boolean = false, detail: String? = null, trailing: (@Composable () -> Unit)? = null) {
    val colors = AccessUi.colors
    val removed = mark == FilterItemMark.REMOVED
    AccessRow(last = last) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            caption?.let { Text(it, style = AccessType.Small, color = colors.secondary) }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(name, style = AccessType.RowTitle.copy(fontWeight = FontWeight.Normal, textDecoration = if (removed) TextDecoration.LineThrough else null),
                    color = if (removed) colors.secondary else colors.primary, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                mark?.let { AccessPill(it.label, if (it == FilterItemMark.ADDED) AccessPillTone.SUCCESS else AccessPillTone.DANGER) }
            }
            detail?.let { Text(it, style = AccessType.RowSecondary, color = colors.secondary) }
        }
        when {
            trailing != null -> trailing()
            count != null -> AccessMatchCount(count)
            counting -> AccessSpinner()
        }
    }
}

/** A count of records as every access screen writes it, with its thousands grouped. */
internal fun accessCount(value: Long): String = "%,d".format(value)

/** How many records an item matches. */
@Composable
internal fun AccessMatchCount(count: Long) {
    Text("${accessCount(count)} matching", style = AccessType.RowSecondary, color = AccessUi.colors.secondary, maxLines = 1)
}

/** What a filter shares and hides, as two equal tiles. */
@Composable
internal fun AccessStatPair(shared: Long, hidden: Long) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        AccessStat(shared, "shared", Modifier.weight(1f))
        AccessStat(hidden, "hidden", Modifier.weight(1f))
    }
}

@Composable
private fun AccessStat(value: Long, label: String, modifier: Modifier) {
    val colors = AccessUi.colors
    Column(modifier.background(colors.surface, RoundedCornerShape(14.dp)).padding(16.dp).semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(accessCount(value), style = AccessType.Stat, color = colors.primary)
        Text(label, style = AccessType.Small, color = colors.secondary)
    }
}

/**
 * The decisions an edit leaves alone, in the muted colour: labels in a leading column, values beside them.
 * Permissions are shown as their pills.
 */
@Composable
internal fun AccessUnchangedBlock(rows: List<AccessDecision>) {
    val colors = AccessUi.colors
    AccessSectionHeading("Unchanged")
    AccessGap(AccessUi.HeadingGap)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        rows.forEach { row ->
            Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(row.title, style = AccessType.RowSecondary, color = colors.muted, modifier = Modifier.width(110.dp))
                row.capabilities?.let { AccessCapabilityPills(it, Modifier.weight(1f)) }
                    ?: Text(row.value, style = AccessType.RowSecondary, color = colors.muted, modifier = Modifier.weight(1f))
            }
        }
    }
}

/**
 * A text field on the surface colour. [label] names the field for a screen reader and stands in the empty
 * field as its placeholder; [error] is printed under the field and [invalid] outlines it without a message.
 * [search] adds a leading magnifier. [sunken] draws the field on the page colour, for a field that sits on
 * a surface card.
 */
@Composable
internal fun AccessTextField(
    value: String, onValueChange: (String) -> Unit, label: String, modifier: Modifier = Modifier, enabled: Boolean = true,
    error: String? = null, invalid: Boolean = error != null, search: Boolean = false, sunken: Boolean = false,
) {
    val colors = AccessUi.colors
    val problem = error
    val shape = RoundedCornerShape(12.dp)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BasicTextField(value, onValueChange, enabled = enabled, singleLine = true, textStyle = AccessType.RowTitle.copy(fontWeight = FontWeight.Normal, color = if (enabled) colors.primary else colors.muted),
            cursorBrush = SolidColor(colors.accent), modifier = Modifier.fillMaxWidth().semantics { contentDescription = label; if (problem != null) this.error(problem) }) { field ->
            Row(Modifier.fillMaxWidth().height(52.dp).background(if (sunken) colors.background else colors.surface, shape)
                .then(if (invalid) Modifier.border(1.5.dp, colors.danger, shape) else Modifier).padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (search) Icon(Icons.Filled.Search, contentDescription = null, tint = colors.secondary, modifier = Modifier.size(20.dp))
                Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) Text(label, style = AccessType.RowTitle.copy(fontWeight = FontWeight.Normal), color = colors.muted, maxLines = 1, modifier = Modifier.clearAndSetSemantics {})
                    field()
                }
            }
        }
        error?.let { Text(it, style = AccessType.RowSecondary, color = colors.danger) }
    }
}

/**
 * A dialog centred on the screen over a 40% black scrim: a title, a body, and text buttons at the trailing
 * edge. [dismiss] is the quiet button; [destructive] draws [confirm] in the danger colour. [content]
 * replaces the plain [body]. A tap on the scrim dismisses.
 */
@Composable
internal fun AccessDialog(
    title: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit, body: String? = null,
    dismiss: String? = null, destructive: Boolean = false, content: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val colors = AccessUi.colors
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        // The scrim is drawn here, so the window's own dimming would darken the screen twice.
        (LocalView.current.parent as? DialogWindowProvider)?.window?.setDimAmount(0f)
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .4f)).pointerInput(onDismiss) { detectTapGestures { onDismiss() } }.padding(horizontal = 28.dp, vertical = 48.dp),
            contentAlignment = Alignment.Center) {
            // A tap on the dialog itself is not a tap on the scrim.
            Column(Modifier.widthIn(max = 340.dp).fillMaxWidth().background(colors.surface, RoundedCornerShape(20.dp)).pointerInput(Unit) { detectTapGestures { } }
                .padding(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 12.dp)) {
                Text(title, style = AccessType.DialogTitle, color = colors.primary, modifier = Modifier.semantics { heading() })
                AccessGap(10.dp)
                if (content != null) Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), content = content)
                else if (body != null) Text(body, style = AccessType.Subtitle, color = colors.secondary)
                AccessGap(12.dp)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp, Alignment.End)) {
                    if (dismiss != null) AccessTextAction(dismiss, style = AccessType.Button, alignment = Alignment.Center, onClick = onDismiss)
                    AccessTextAction(confirm, danger = destructive, style = AccessType.Button, alignment = Alignment.Center, onClick = onConfirm)
                }
            }
        }
    }
}

/**
 * A small indeterminate spinner: an arc turning on a faint ring. A screenshot render holds the arc
 * still at one angle, so a recorded image shows a spinner and never changes between recordings.
 */
@Composable
internal fun AccessSpinner(size: Dp = 16.dp) {
    val colors = AccessUi.colors
    val frozen = LocalInspectionMode.current
    var angle by remember { mutableFloatStateOf(-50f) }
    if (!frozen) LaunchedEffect(Unit) {
        var previous = 0L
        while (true) withInfiniteAnimationFrameNanos { now ->
            if (previous != 0L) angle = (angle + (now - previous) / 1_000_000f * .4f) % 360f
            previous = now
        }
    }
    Canvas(Modifier.size(size)) {
        val stroke = 2.dp.toPx()
        val inner = Size(this.size.width - stroke, this.size.height - stroke)
        drawArc(colors.divider, 0f, 360f, useCenter = false, topLeft = Offset(stroke / 2, stroke / 2), size = inner, style = Stroke(stroke))
        drawArc(colors.accent, angle, 110f, useCenter = false, topLeft = Offset(stroke / 2, stroke / 2), size = inner, style = Stroke(stroke, cap = StrokeCap.Round))
    }
}

/** A row that adds something to the list above it: a plus where the rows have their tick box, then an accent label. */
@Composable
internal fun AccessAddRow(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val colors = AccessUi.colors
    Row(modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(role = Role.Button, onClick = onClick), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(Icons.Filled.Add, contentDescription = null, tint = colors.accent, modifier = Modifier.size(22.dp))
        Text(label, style = AccessType.RowAction, color = colors.accent, maxLines = 1)
    }
}

internal const val ACCESS_REFRESH_INTERVAL_MILLIS = 3_000L

/**
 * Calls [refresh] every [intervalMillis] for as long as [active] holds, so counts and states the gateway is still
 * working out arrive without the owner asking for them. A screenshot render never refreshes.
 */
@Composable
internal fun AccessAutoRefresh(active: Boolean, intervalMillis: Long = ACCESS_REFRESH_INTERVAL_MILLIS, refresh: () -> Unit) {
    val frozen = LocalInspectionMode.current
    val latest by rememberUpdatedState(refresh)
    LaunchedEffect(active, frozen, intervalMillis) {
        if (!active || frozen) return@LaunchedEffect
        while (true) { delay(intervalMillis.coerceAtLeast(500L)); latest() }
    }
}
