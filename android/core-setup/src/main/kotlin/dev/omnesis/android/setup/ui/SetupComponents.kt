// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.withInfiniteAnimationFrameMillis
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.NorthEast
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.setup.SetupHighlight
import dev.omnesis.android.setup.SetupLedger
import dev.omnesis.android.setup.SetupStatusKind
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.flow.SetupBusy
import kotlin.math.max
import kotlin.math.min

/** Where the current step sits in the walk: [current] of [total], zero-based. */
data class SetupProgress(val total: Int, val current: Int)

/** The landing ground with a halo of [tint] spilling down from the top edge. */
@Composable
fun SetupBackdrop(tint: Color, modifier: Modifier = Modifier) {
    val palette = setupPalette
    Canvas(modifier.fillMaxSize()) {
        drawRect(palette.base)
        drawRect(
            Brush.radialGradient(
                0.00f to tint.copy(alpha = palette.haloAlpha),
                0.42f to tint.copy(alpha = palette.haloAlpha * 0.38f),
                0.78f to tint.copy(alpha = palette.haloAlpha * 0.06f),
                1.00f to tint.copy(alpha = 0f),
                center = Offset(size.width / 2f, -size.height * 0.08f),
                radius = max(size.width, size.height) * 0.62f,
            ),
        )
    }
}

/**
 * One setup page: backdrop, an optional progress bar, a scrolling body and a
 * pinned action area that stays reachable however long the body is.
 */
@Composable
fun SetupPageScaffold(
    tint: Color,
    modifier: Modifier = Modifier,
    progress: SetupProgress? = null,
    /** Centers a body that fits the screen, instead of leaving it hanging from the top. */
    centered: Boolean = false,
    bottom: @Composable ColumnScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val palette = setupPalette
    Box(modifier.fillMaxSize()) {
        SetupBackdrop(tint)
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.safeDrawing)
                .padding(horizontal = 20.dp),
        ) {
            // A walk of one page has nowhere to show progress through.
            if (progress != null && progress.total > 1) {
                Spacer(Modifier.height(14.dp))
                SetupProgressBar(progress, tint)
            }
            val scroll = rememberScrollState()
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .verticalScroll(scroll)
                        .heightIn(min = maxHeight)
                        .padding(top = 22.dp, bottom = 18.dp),
                    verticalArrangement = if (centered) {
                        Arrangement.spacedBy(14.dp, Alignment.CenterVertically)
                    } else {
                        Arrangement.spacedBy(14.dp)
                    },
                    content = content,
                )
                // Content continues under the actions: fade it out so it reads as scrollable, not cut.
                if (scroll.canScrollForward) {
                    Box(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .height(24.dp)
                            .background(Brush.verticalGradient(listOf(palette.base.copy(alpha = 0f), palette.base))),
                    )
                }
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 2.dp, bottom = 14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                content = bottom,
            )
        }
    }
}

/** One segment per walked step: done steps muted, the current one lit, the rest pending. */
@Composable
fun SetupProgressBar(progress: SetupProgress, tint: Color, modifier: Modifier = Modifier) {
    val palette = setupPalette
    val description = "Step ${progress.current + 1} of ${progress.total}"
    Row(
        modifier.fillMaxWidth().semantics { contentDescription = description },
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        repeat(progress.total) { index ->
            val color = when {
                index < progress.current -> palette.textPrimary.copy(alpha = 0.55f)
                index == progress.current -> tint.asSetupForeground(palette)
                else -> palette.segmentPending
            }
            Box(
                Modifier
                    .weight(1f)
                    .height(3.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(color),
            )
        }
    }
}

/** A step's glyph on a rounded tile filled and outlined with its tint. */
@Composable
fun SetupGlyphTile(glyph: ImageVector, tint: Color, modifier: Modifier = Modifier, tileSize: Dp = 54.dp) {
    val palette = setupPalette
    val shape = RoundedCornerShape(tileSize * 0.29f)
    Box(
        modifier
            .size(tileSize)
            .clip(shape)
            .background(tint.copy(alpha = 0.16f).compositeOver(palette.card))
            .border(1.dp, tint.copy(alpha = 0.45f), shape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(glyph, contentDescription = null, tint = tint.asSetupForeground(palette), modifier = Modifier.size(tileSize * 0.48f))
    }
}

/** The Omnesis mark, white on the brand gradient, softly lit from behind. */
@Composable
fun SetupBrandMark(mark: Painter, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(20.dp)
    Box(
        modifier
            .size(64.dp)
            .drawBehind {
                drawCircle(
                    Brush.radialGradient(
                        0f to SetupBrandTint.copy(alpha = 0.45f),
                        1f to SetupBrandTint.copy(alpha = 0f),
                        radius = size.minDimension * 0.95f,
                    ),
                    radius = size.minDimension * 0.95f,
                )
            }
            .clip(shape)
            .background(Brush.linearGradient(SetupGradient)),
        contentAlignment = Alignment.Center,
    ) {
        Image(mark, contentDescription = "Omnesis", colorFilter = ColorFilter.tint(Color.White), modifier = Modifier.size(38.dp))
    }
}

/**
 * Connected's mark: the Omnesis mark itself, large and centred, on a soft
 * brand glow with no tile behind it — white on the dark ground, brand blue on
 * the light one.
 */
@Composable
fun SetupConnectedMark(mark: Painter, modifier: Modifier = Modifier) {
    val palette = setupPalette
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(132.dp)
                .drawBehind {
                    drawCircle(
                        Brush.radialGradient(
                            0f to SetupBrandTint.copy(alpha = if (palette.isDark) 0.42f else 0.2f),
                            1f to SetupBrandTint.copy(alpha = 0f),
                            radius = size.minDimension / 2f,
                        ),
                        radius = size.minDimension / 2f,
                    )
                },
            contentAlignment = Alignment.Center,
        ) {
            Image(
                mark,
                contentDescription = "Omnesis",
                colorFilter = ColorFilter.tint(if (palette.isDark) Color.White else SetupBrandInk),
                modifier = Modifier.size(76.dp),
            )
        }
    }
}

@Composable
fun SetupTitle(text: String, modifier: Modifier = Modifier, centered: Boolean = false) {
    Text(
        text,
        modifier = modifier.fillMaxWidth().semantics { heading() },
        style = MaterialTheme.typography.titleLarge.copy(fontSize = 28.sp, lineHeight = 33.sp, letterSpacing = (-0.4).sp),
        fontWeight = FontWeight.Bold,
        color = setupPalette.textPrimary,
        textAlign = if (centered) TextAlign.Center else TextAlign.Start,
    )
}

@Composable
fun SetupBody(text: String, modifier: Modifier = Modifier, centered: Boolean = false) {
    Text(
        text,
        modifier = modifier.fillMaxWidth(),
        style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 21.sp),
        color = setupPalette.textSecondary,
        textAlign = if (centered) TextAlign.Center else TextAlign.Start,
    )
}

/** The prominent disclosure, with its background-access clause emphasised wherever it appears. */
@Composable
fun SetupDisclosure(text: String, modifier: Modifier = Modifier) {
    val palette = setupPalette
    val emphasis = BACKGROUND_CLAUSE
    val start = text.indexOf(emphasis)
    val annotated = buildAnnotatedString {
        if (start < 0) {
            append(text)
        } else {
            append(text.substring(0, start))
            withStyle(SpanStyle(color = palette.textPrimary, fontWeight = FontWeight.SemiBold)) { append(emphasis) }
            append(text.substring(start + emphasis.length))
        }
    }
    Text(
        annotated,
        modifier = modifier.fillMaxWidth(),
        style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 21.sp),
        color = palette.textSecondary,
    )
}

private const val BACKGROUND_CLAUSE = "including while the app is closed"

@Composable
fun SetupFinePrint(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier = modifier.fillMaxWidth(),
        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp, lineHeight = 17.sp),
        color = setupPalette.textMuted,
        textAlign = TextAlign.Center,
    )
}

/** A small uppercase section label, with an optional leading glyph. */
@Composable
fun SetupLabel(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    val palette = setupPalette
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        if (icon != null) Icon(icon, contentDescription = null, tint = palette.textMuted, modifier = Modifier.size(13.dp))
        Text(
            text.uppercase(),
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp, letterSpacing = 0.8.sp),
            fontWeight = FontWeight.SemiBold,
            color = palette.textMuted,
        )
    }
}

@Composable
fun SetupCard(
    modifier: Modifier = Modifier,
    horizontalPadding: Dp = 14.dp,
    verticalPadding: Dp = 12.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val palette = setupPalette
    val shape = RoundedCornerShape(16.dp)
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(palette.card)
            .border(1.dp, palette.cardBorder, shape)
            .padding(horizontal = horizontalPadding, vertical = verticalPadding),
        content = content,
    )
}

/** "You'll be able to ask" and the example question. */
@Composable
fun SetupAskCard(question: String, modifier: Modifier = Modifier) {
    SetupCard(modifier) {
        SetupLabel("You'll be able to ask", icon = Icons.Outlined.ChatBubbleOutline)
        Spacer(Modifier.height(5.dp))
        Text(
            "“$question”",
            style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.5.sp, lineHeight = 21.sp),
            fontWeight = FontWeight.Medium,
            color = setupPalette.textPrimary,
        )
    }
}

@Composable
fun SetupChip(text: String, modifier: Modifier = Modifier) {
    val palette = setupPalette
    Text(
        text,
        modifier = modifier
            .clip(CircleShape)
            .background(palette.chip)
            .padding(horizontal = 11.dp, vertical = 6.dp),
        style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 17.sp),
        color = palette.chipText,
    )
}

/** A chip for what never leaves: outlined with a dashed rule, no fill. */
@Composable
fun SetupDashedChip(text: String, modifier: Modifier = Modifier) {
    val palette = setupPalette
    val rule = if (palette.isDark) Color(0xFF3A4A60) else Color(0xFFB3C0CF)
    Text(
        text,
        modifier = modifier
            .drawBehind {
                val stroke = 1.dp.toPx()
                drawRoundRect(
                    color = rule,
                    topLeft = Offset(stroke / 2f, stroke / 2f),
                    size = Size(size.width - stroke, size.height - stroke),
                    cornerRadius = CornerRadius(size.height / 2f),
                    style = Stroke(width = stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))),
                )
            }
            .padding(horizontal = 11.dp, vertical = 6.dp),
        style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 17.sp),
        color = palette.textSecondary,
    )
}

/** A chip the user can switch on and off, lit with [tint] while selected. */
@Composable
fun SetupToggleChip(text: String, selected: Boolean, tint: Color, onToggle: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val palette = setupPalette
    val shape = CircleShape
    Row(
        modifier
            .minimumInteractiveComponentSize()
            .clip(shape)
            .background(if (selected) tint.copy(alpha = 0.16f).compositeOver(palette.card) else Color.Transparent)
            .border(1.dp, if (selected) tint.copy(alpha = 0.55f) else palette.cardBorder, shape)
            .toggleable(value = selected, role = Role.Checkbox, onValueChange = onToggle)
            // Tall enough that rows spaced by the 48dp touch target read as one group.
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (selected) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = tint.asSetupForeground(palette), modifier = Modifier.size(14.dp))
        }
        Text(
            text,
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 17.sp),
            color = if (selected) palette.textPrimary else palette.textSecondary,
        )
    }
}

/**
 * One ledger section: a labelled row of wrapping chips. [rowSpacing] is the
 * gap between wrapped rows; toggle chips already carry a 48dp touch target
 * that spaces their rows, so a section of them passes none.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SetupLedgerSection(
    label: String,
    icon: ImageVector?,
    modifier: Modifier = Modifier,
    rowSpacing: Dp = 6.dp,
    chips: @Composable () -> Unit,
) {
    Column(modifier.fillMaxWidth().padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SetupLabel(label, icon = icon)
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(rowSpacing),
        ) {
            chips()
        }
    }
}

/**
 * What crosses to the gateway, any section the step adds, what the system also
 * asks for, and what stays behind — the same sections in the flow and in the
 * source's Settings disclosure.
 */
@Composable
fun SetupLedgerSections(ledger: SetupLedger, extraSection: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth()) {
        SetupLedgerSection("Sent to your gateway", Icons.Outlined.NorthEast) {
            ledger.sent.forEach { SetupChip(it) }
        }
        if (extraSection != null) {
            LedgerRule()
            extraSection()
        }
        if (ledger.alsoAsked.isNotEmpty()) {
            LedgerRule()
            SetupLedgerSection("Also asked", Icons.Outlined.Info) {
                ledger.alsoAsked.forEach { SetupChip(it) }
            }
        }
        LedgerRule()
        SetupLedgerSection(ledger.staysLabel, Icons.Outlined.Lock) {
            ledger.stays.forEach { SetupDashedChip(it) }
        }
    }
}

@Composable
private fun LedgerRule() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(setupPalette.cardBorder))
}

@Composable
fun SetupLedgerCard(ledger: SetupLedger, modifier: Modifier = Modifier, extraSection: (@Composable () -> Unit)? = null) {
    SetupCard(modifier, verticalPadding = 2.dp) { SetupLedgerSections(ledger, extraSection) }
}

/** Icon rows for a step that sends nothing to the gateway. */
@Composable
fun SetupHighlightsCard(highlights: List<SetupHighlight>, tint: Color, modifier: Modifier = Modifier) {
    val palette = setupPalette
    SetupCard(modifier, verticalPadding = 14.dp) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            highlights.forEach { highlight ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(
                        Modifier
                            .size(34.dp)
                            .clip(RoundedCornerShape(10.dp))
                            .background(tint.copy(alpha = 0.16f).compositeOver(palette.card)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(highlight.icon, contentDescription = null, tint = tint.asSetupForeground(palette), modifier = Modifier.size(18.dp))
                    }
                    Text(
                        highlight.text,
                        style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 20.sp),
                        color = palette.textPrimary,
                    )
                }
            }
        }
    }
}

/** The one gradient action a page leads with; carries the busy state of the step it runs. */
@Composable
fun SetupPrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: SetupBusy = SetupBusy.IDLE,
    /** What the button says while [busy] is WORKING. */
    workingLabel: String = "Working…",
) {
    val shape = RoundedCornerShape(26.dp)
    val palette = setupPalette
    val fill = if (enabled) Modifier.background(Brush.linearGradient(SetupGradient), shape) else Modifier.background(palette.segmentPending, shape)
    Box(
        modifier
            .heightIn(min = 52.dp)
            .clip(shape)
            .then(fill)
            .clickable(enabled = enabled && busy == SetupBusy.IDLE, role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        when (busy) {
            SetupBusy.IDLE -> Text(
                label,
                style = MaterialTheme.typography.titleSmall.copy(fontSize = 16.sp, lineHeight = 20.sp),
                fontWeight = FontWeight.SemiBold,
                color = if (enabled) Color.White else palette.textSecondary,
                textAlign = TextAlign.Center,
            )
            SetupBusy.WORKING, SetupBusy.WAITING_FOR_SYSTEM -> Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                OmSpinner(modifier = Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp)
                Text(
                    setupBusyLabel(busy, workingLabel),
                    style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp, lineHeight = 20.sp),
                    fontWeight = FontWeight.Medium,
                    color = Color.White,
                )
            }
        }
    }
}

/** Words for a busy button, never a bare spinner: Android's prompt or screen is up, or the enable is running. */
fun setupBusyLabel(busy: SetupBusy, workingLabel: String): String = when (busy) {
    SetupBusy.WAITING_FOR_SYSTEM -> "Waiting for Android…"
    SetupBusy.WORKING, SetupBusy.IDLE -> workingLabel
}

/** An outlined pill for a second, equally valid answer (a device choice). */
@Composable
fun SetupSecondaryButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val palette = setupPalette
    val shape = RoundedCornerShape(26.dp)
    Box(
        modifier
            .heightIn(min = 52.dp)
            .clip(shape)
            .background(palette.card.copy(alpha = 0.7f))
            .border(1.dp, palette.cardBorder, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 18.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.titleSmall.copy(fontSize = 16.sp, lineHeight = 20.sp),
            fontWeight = FontWeight.SemiBold,
            color = palette.textPrimary,
            textAlign = TextAlign.Center,
        )
    }
}

/** A quiet text action: "Not now", "Skip for now", "Open Settings". */
@Composable
fun SetupTextAction(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    color: Color = setupPalette.link,
    enabled: Boolean = true,
) {
    Text(
        label,
        modifier = modifier
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 14.dp),
        style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp, lineHeight = 20.sp),
        fontWeight = FontWeight.Medium,
        color = if (enabled) color else color.copy(alpha = 0.45f),
        textAlign = TextAlign.Center,
    )
}

/** Whether a [SetupCheckRing] has finished drawing, for tests, which cannot see the canvas. */
internal val SetupCheckRingFullyDrawn = SemanticsPropertyKey<Boolean>("SetupCheckRingFullyDrawn")

private var SemanticsPropertyReceiver.setupCheckRingFullyDrawn by SetupCheckRingFullyDrawn

/**
 * The success mark: a ring drawn in [tint], then a check, read by TalkBack as
 * "Done". It draws again every time [drawKey] changes — every outcome that
 * arrives in place on the same page, not only the first — and always ends
 * fully drawn; while motion is reduced it is drawn complete at once. The
 * drawing progress is read only while drawing, so its frames never recompose
 * the page.
 */
@Composable
fun SetupCheckRing(tint: Color, modifier: Modifier = Modifier, diameter: Dp = 88.dp, drawKey: Any? = null) {
    val palette = setupPalette
    val reduced = setupMotionReduced()
    val progress = remember(drawKey) { Animatable(if (reduced) 1f else 0f) }
    LaunchedEffect(drawKey, reduced) {
        if (reduced) {
            progress.snapTo(1f)
        } else {
            progress.animateTo(1f, tween(durationMillis = 900, easing = FastOutSlowInEasing))
        }
    }
    val fullyDrawn = remember(progress) { derivedStateOf { progress.value >= 1f } }.value
    val foreground = tint.asSetupForeground(palette)
    Canvas(
        modifier.size(diameter).semantics {
            contentDescription = "Done"
            setupCheckRingFullyDrawn = fullyDrawn
        },
    ) {
        val drawn = progress.value
        val stroke = diameter.toPx() * 0.05f
        val inset = stroke / 2f
        drawCircle(tint.copy(alpha = 0.12f), radius = size.minDimension / 2f - inset)
        drawArc(
            color = foreground,
            startAngle = -90f,
            sweepAngle = 360f * drawn,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = Size(size.width - stroke, size.height - stroke),
            style = Stroke(width = stroke, cap = StrokeCap.Round),
        )
        val checkAlpha = ((drawn - 0.55f) / 0.45f).coerceIn(0f, 1f)
        if (checkAlpha > 0f) {
            val check = Path().apply {
                moveTo(size.width * 0.30f, size.height * 0.52f)
                lineTo(size.width * 0.44f, size.height * 0.66f)
                lineTo(size.width * 0.71f, size.height * 0.38f)
            }
            drawPath(
                check,
                color = foreground.copy(alpha = checkAlpha),
                style = Stroke(width = stroke * 1.15f, cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
        }
    }
}

/** A calm round badge for an outcome that is not a success. */
@Composable
fun SetupOutcomeBadge(icon: ImageVector, color: Color, modifier: Modifier = Modifier, diameter: Dp = 88.dp) {
    Box(
        modifier
            .size(diameter)
            .clip(CircleShape)
            .background(color.copy(alpha = 0.10f))
            .border(2.dp, color.copy(alpha = 0.35f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(diameter * 0.40f))
    }
}

/** The live sync line under an outcome, with a thin fill while a run is under way. */
@Composable
fun SetupTrack(fraction: Float, tint: Color, modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .height(3.dp)
            .clip(RoundedCornerShape(2.dp))
            .background(setupPalette.segmentPending),
    ) {
        Box(
            Modifier
                .fillMaxWidth(fraction.coerceIn(0f, 1f))
                .fillMaxHeight()
                .background(tint),
        )
    }
}

/** How long the packet takes to travel from this phone to the gateway before it starts again. */
const val CONNECTION_CYCLE_MILLIS = 2_600L

/** Where the packet is along the line, 0 at this phone and 1 at the gateway, [elapsedMillis] into the loop. */
fun connectionPacketPhase(elapsedMillis: Long): Float =
    elapsedMillis.mod(CONNECTION_CYCLE_MILLIS).toFloat() / CONNECTION_CYCLE_MILLIS

/** The packet fades in as it leaves this phone and out as it reaches the gateway. */
fun connectionPacketAlpha(phase: Float): Float = min(1f, min(phase, 1f - phase) * 6f)

/**
 * This phone, a line with a packet travelling along it to the gateway, and
 * the gateway. The packet moves on the frame clock at a steady pace and loops;
 * it rests at the middle, fully drawn, only while motion is reduced.
 */
@Composable
fun SetupConnectionDiagram(modifier: Modifier = Modifier) {
    val palette = setupPalette
    val reduced = setupMotionReduced()
    val phase = produceState(initialValue = 0.5f, reduced) {
        if (reduced) {
            value = 0.5f
            return@produceState
        }
        val start = withInfiniteAnimationFrameMillis { it }
        while (true) {
            withInfiniteAnimationFrameMillis { now -> value = connectionPacketPhase(now - start) }
        }
    }
    val rail = if (palette.isDark) Color(0xFF2B3B52) else Color(0xFFC9D6E6)
    Row(modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.Top) {
        DiagramNode(Icons.Outlined.Smartphone, "This phone")
        Box(Modifier.weight(1f).height(56.dp).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxWidth().height(18.dp)) {
                val y = size.height / 2f
                drawLine(
                    brush = Brush.horizontalGradient(listOf(rail, SetupBrandTint, rail)),
                    start = Offset(0f, y),
                    end = Offset(size.width, y),
                    strokeWidth = 2.dp.toPx(),
                    cap = StrokeCap.Round,
                )
                val now = phase.value
                val alpha = if (reduced) 1f else connectionPacketAlpha(now)
                val x = 5.dp.toPx() + (size.width - 10.dp.toPx()) * now
                drawCircle(SetupBrandTint.copy(alpha = 0.35f * alpha), radius = 9.dp.toPx(), center = Offset(x, y))
                drawCircle(Color(0xFF9CD4FF).copy(alpha = alpha), radius = 5.dp.toPx(), center = Offset(x, y))
            }
        }
        DiagramNode(Icons.Filled.Dns, "Your gateway")
    }
}

@Composable
private fun DiagramNode(icon: ImageVector, label: String) {
    val palette = setupPalette
    val shape = RoundedCornerShape(16.dp)
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Box(
            Modifier
                .size(56.dp)
                .clip(shape)
                .background(palette.card)
                .border(1.dp, palette.cardBorder, shape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = palette.textPrimary, modifier = Modifier.size(26.dp))
        }
        Text(label, style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.5.sp), color = palette.textSecondary)
    }
}

/** The gateway this phone paired with, and that its certificate checked out. */
@Composable
fun SetupVerifiedCard(host: String, modifier: Modifier = Modifier) {
    val palette = setupPalette
    SetupCard(modifier, verticalPadding = 14.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Filled.VerifiedUser, contentDescription = null, tint = OmTheme.colors.success, modifier = Modifier.size(24.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    host,
                    style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 20.sp),
                    fontWeight = FontWeight.SemiBold,
                    color = palette.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text("Connection verified", style = MaterialTheme.typography.bodySmall, color = palette.textSecondary)
            }
        }
    }
}

/** How a Choose row reads. */
sealed interface SetupChooseRowState {
    data class Selectable(val selected: Boolean) : SetupChooseRowState
    data object On : SetupChooseRowState
    data class Disabled(val reason: String) : SetupChooseRowState
}

@Composable
fun SetupChooseRow(
    name: String,
    value: String,
    glyph: ImageVector,
    tint: Color,
    state: SetupChooseRowState,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = setupPalette
    val shape = RoundedCornerShape(16.dp)
    val selected = (state as? SetupChooseRowState.Selectable)?.selected == true
    val interactive = if (state is SetupChooseRowState.Selectable) {
        Modifier.toggleable(value = selected, role = Role.Switch, onValueChange = { onToggle() })
    } else {
        Modifier
    }
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (selected) tint.copy(alpha = 0.09f).compositeOver(palette.card) else palette.card)
            .border(1.dp, if (selected) tint.copy(alpha = 0.55f) else palette.cardBorder, shape)
            .then(interactive)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        val disabled = state is SetupChooseRowState.Disabled
        SetupGlyphTile(glyph, tint, Modifier.alpha(if (disabled) 0.5f else 1f), tileSize = 40.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                name,
                style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.5.sp, lineHeight = 20.sp),
                fontWeight = FontWeight.SemiBold,
                color = if (disabled) palette.textSecondary else palette.textPrimary,
            )
            Text(
                (state as? SetupChooseRowState.Disabled)?.reason ?: value,
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 17.sp),
                color = palette.textSecondary,
            )
        }
        when (state) {
            is SetupChooseRowState.Selectable -> Switch(
                checked = selected,
                onCheckedChange = null,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color.White,
                    checkedTrackColor = palette.toggleOn,
                    checkedBorderColor = Color.Transparent,
                    uncheckedThumbColor = palette.textSecondary,
                    uncheckedTrackColor = palette.segmentPending,
                    uncheckedBorderColor = palette.cardBorder,
                ),
            )
            SetupChooseRowState.On -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(Icons.Filled.Check, contentDescription = null, tint = palette.onText, modifier = Modifier.size(16.dp))
                Text("On", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = palette.onText)
            }
            is SetupChooseRowState.Disabled -> Spacer(Modifier.width(0.dp))
        }
    }
}

/**
 * One source's line on an outcome page and on Finish: its tile and name, then
 * its live sync line with a mark for how it reads and a fill while it runs.
 * A source that is not contributing is dimmed and says why, in [note] or as
 * not set up.
 */
@Composable
fun SetupSourceStatusRow(
    name: String,
    glyph: ImageVector,
    tint: Color,
    status: SetupStatusLine?,
    modifier: Modifier = Modifier,
    note: String? = null,
) {
    val palette = setupPalette
    val shape = RoundedCornerShape(16.dp)
    val dimmed = if (status == null) 0.62f else 1f
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(palette.card)
            .border(1.dp, palette.cardBorder, shape)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SetupGlyphTile(glyph, tint, Modifier.alpha(dimmed), tileSize = 36.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                name,
                modifier = Modifier.alpha(dimmed),
                style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 20.sp),
                fontWeight = FontWeight.SemiBold,
                color = palette.textPrimary,
            )
            Text(
                status?.text ?: note ?: "Not set up · Settings",
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 17.sp),
                color = palette.textSecondary,
            )
            status?.fraction?.let {
                Spacer(Modifier.height(5.dp))
                SetupTrack(it, tint)
            }
        }
        when (status?.kind) {
            SetupStatusKind.SYNCING -> OmSpinner(
                modifier = Modifier.size(17.dp),
                color = tint.asSetupForeground(palette),
                strokeWidth = 2.dp,
            )
            SetupStatusKind.UP_TO_DATE ->
                Icon(Icons.Outlined.CheckCircle, contentDescription = "Up to date", tint = palette.onText, modifier = Modifier.size(19.dp))
            SetupStatusKind.ATTENTION ->
                Icon(Icons.Outlined.WarningAmber, contentDescription = "Needs attention", tint = OmTheme.colors.warning, modifier = Modifier.size(19.dp))
            SetupStatusKind.NOT_SYNCED, null -> Unit
        }
    }
}

/**
 * One way to answer "another device already sends this": equal in weight to
 * the others, with what it does and what follows.
 */
@Composable
fun SetupChoiceCard(
    title: String,
    detail: String,
    glyph: ImageVector,
    tint: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val palette = setupPalette
    val shape = RoundedCornerShape(16.dp)
    Row(
        modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.6f)
            .clip(shape)
            .background(palette.card)
            .border(1.dp, palette.cardBorder, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(glyph, contentDescription = null, tint = tint.asSetupForeground(palette), modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.5.sp, lineHeight = 20.sp),
                fontWeight = FontWeight.SemiBold,
                color = palette.textPrimary,
            )
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.5.sp, lineHeight = 18.sp),
                color = palette.textSecondary,
            )
        }
    }
}
