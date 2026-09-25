// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Textsms
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.BriefRecordDto
import dev.omnesis.android.ui.common.TimeFormat
import java.time.Instant
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/** One glanceable Briefs row with talk-back and trailing triage actions. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun BriefSwipeRow(
    brief: BriefRecordDto,
    unread: Boolean,
    now: Instant,
    onOpen: () -> Unit,
    onQuickClear: () -> Unit,
    onAsk: () -> Unit,
    onDictate: () -> Unit,
    onMoreOptions: () -> Unit,
    actionsRevealed: Boolean,
    onActionsRevealed: () -> Unit,
    onActionsClosed: () -> Unit,
) {
    var menuOpen by remember { mutableStateOf(false) }

    Box {
        LeftSwipeActionBox(
            onFullSwipe = onQuickClear,
            actionsRevealed = actionsRevealed,
            onActionsRevealed = onActionsRevealed,
            onActionsClosed = onActionsClosed,
            background = { closeActions, accessible ->
                BriefSwipeActions(
                    clearLabel = brief.kind.clearActionLabel,
                    accessible = accessible,
                    onMore = {
                        closeActions()
                        onActionsClosed()
                        onMoreOptions()
                    },
                    onClear = {
                        closeActions()
                        onActionsClosed()
                        onQuickClear()
                    },
                )
            },
        ) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(OmTheme.colors.bgPrimary)
                    .combinedClickable(
                        onClick = onOpen,
                        onLongClickLabel = "Ask or dictate",
                        onLongClick = { menuOpen = true },
                    )
                    .semantics {
                        customActions = listOf(
                            CustomAccessibilityAction("Ask") { onAsk(); true },
                            CustomAccessibilityAction("Dictate") { onDictate(); true },
                            CustomAccessibilityAction("More") {
                                onActionsClosed()
                                onMoreOptions()
                                true
                            },
                            CustomAccessibilityAction(brief.kind.clearActionLabel) {
                                onActionsClosed()
                                onQuickClear()
                                true
                            },
                        )
                    },
            ) {
                BriefRow(brief = brief, unread = unread, now = now)
            }
        }
        DropdownMenu(
            expanded = menuOpen,
            onDismissRequest = { menuOpen = false },
            modifier = Modifier.testTag("briefLongPressMenu"),
        ) {
            DropdownMenuItem(
                text = { Text("Ask") },
                leadingIcon = { Icon(Icons.Outlined.Textsms, contentDescription = null) },
                onClick = { menuOpen = false; onAsk() },
            )
            DropdownMenuItem(
                text = { Text("Dictate") },
                leadingIcon = { Icon(Icons.Outlined.Mic, contentDescription = null) },
                onClick = { menuOpen = false; onDictate() },
            )
        }
    }
}

/** A physical left-swipe recognizer that deliberately leaves closed-row right drags alone. */
@Composable
private fun LeftSwipeActionBox(
    onFullSwipe: () -> Unit,
    actionsRevealed: Boolean,
    onActionsRevealed: () -> Unit,
    onActionsClosed: () -> Unit,
    background: @Composable (closeActions: () -> Unit, accessible: Boolean) -> Unit,
    content: @Composable () -> Unit,
) {
    val density = LocalDensity.current
    val viewConfiguration = LocalViewConfiguration.current
    val scope = rememberCoroutineScope()
    val currentOnFullSwipe by rememberUpdatedState(onFullSwipe)
    val currentOnActionsRevealed by rememberUpdatedState(onActionsRevealed)
    val currentOnActionsClosed by rememberUpdatedState(onActionsClosed)
    val settleJob = remember { arrayOfNulls<Job>(1) }
    var widthPx by remember { mutableFloatStateOf(0f) }
    val actionsWidthPx = with(density) { 144.dp.toPx() }
    var offsetPx by remember(actionsRevealed, actionsWidthPx) {
        mutableFloatStateOf(if (actionsRevealed) -actionsWidthPx else 0f)
    }

    fun animateOffsetTo(target: Float, after: (() -> Unit)? = null) {
        settleJob[0]?.cancel()
        settleJob[0] = scope.launch {
            animate(
                initialValue = offsetPx,
                targetValue = target,
                animationSpec = spring(dampingRatio = 0.9f, stiffness = 500f),
            ) { value, _ -> offsetPx = value }
            after?.invoke()
        }
    }

    Box(
        Modifier
            .fillMaxWidth()
            .onSizeChanged { widthPx = it.width.toFloat() }
            .pointerInput(widthPx, actionsWidthPx) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Main)
                    settleJob[0]?.cancel()
                    val restingOffset = offsetPx
                    var totalX = 0f
                    var totalY = 0f
                    var decided = false
                    var claimed = false
                    var settleScheduled = false

                    try {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Main)
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) {
                                if (claimed) {
                                    val releasedOffset = (restingOffset + totalX).coerceIn(-widthPx, 0f)
                                    when {
                                        releasedOffset <= -widthPx * 0.55f -> {
                                            currentOnActionsClosed()
                                            currentOnFullSwipe()
                                        }
                                        releasedOffset <= -actionsWidthPx / 2f ->
                                            animateOffsetTo(-actionsWidthPx) { currentOnActionsRevealed() }
                                        else -> animateOffsetTo(0f) { currentOnActionsClosed() }
                                    }
                                    settleScheduled = true
                                }
                                break
                            }

                            val delta = change.positionChange()
                            totalX += delta.x
                            totalY += delta.y
                            if (!decided &&
                                (abs(totalX) >= viewConfiguration.touchSlop ||
                                    abs(totalY) >= viewConfiguration.touchSlop)
                            ) {
                                decided = true
                                claimed = (totalX < 0f || restingOffset < 0f) &&
                                    abs(totalX) > abs(totalY) * 1.5f &&
                                    !change.isConsumed
                            }
                            if (claimed) {
                                offsetPx = (restingOffset + totalX).coerceIn(-widthPx, 0f)
                                change.consume()
                            }
                        }
                    } finally {
                        if (claimed && !settleScheduled && offsetPx != 0f) {
                            animateOffsetTo(0f) { currentOnActionsClosed() }
                        }
                    }
                }
            },
    ) {
        val actionsAccessible = actionsRevealed || offsetPx <= -actionsWidthPx / 2f
        Box(Modifier.matchParentSize()) {
            background(
                {
                    animateOffsetTo(0f) { currentOnActionsClosed() }
                },
                actionsAccessible,
            )
        }
        Box(
            Modifier
                .offset { IntOffset(offsetPx.roundToInt(), 0) }
                .testTag("briefSwipeForeground"),
        ) { content() }
    }
}

@Composable
private fun BriefSwipeActions(
    clearLabel: String,
    accessible: Boolean,
    onMore: () -> Unit,
    onClear: () -> Unit,
) {
    Box(
        Modifier
            .fillMaxSize()
            .background(OmTheme.colors.bgSecondary)
            .testTag("briefSwipeBackground"),
    ) {
        Row(
            Modifier.fillMaxSize()
                .then(if (accessible) Modifier else Modifier.clearAndSetSemantics {}),
            horizontalArrangement = Arrangement.Absolute.Right,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BriefSwipeAction(
                label = "More",
                tag = "briefSwipeMore",
                icon = { Icon(Icons.Outlined.MoreHoriz, contentDescription = null) },
                background = OmTheme.colors.textMuted,
                onClick = onMore,
            )
            BriefSwipeAction(
                label = clearLabel,
                tag = "briefSwipeClear",
                icon = { Icon(Icons.Outlined.Check, contentDescription = null) },
                background = OmTheme.colors.success,
                onClick = onClear,
            )
        }
    }
}

@Composable
private fun BriefSwipeAction(
    label: String,
    tag: String,
    icon: @Composable () -> Unit,
    background: androidx.compose.ui.graphics.Color,
    onClick: () -> Unit,
) {
    Column(
        Modifier
            .width(72.dp)
            .fillMaxHeight()
            .background(background)
            .testTag(tag)
            .clickable(onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides OmTheme.colors.bgPrimary) { icon() }
        Text(label, style = MaterialTheme.typography.labelSmall, color = OmTheme.colors.bgPrimary)
    }
}

@Composable
private fun BriefRow(brief: BriefRecordDto, unread: Boolean, now: Instant) {
    val colors = OmTheme.colors
    // Side insets come from the list's content padding (matching the Privacy
    // feed). The unread dot lives in that inset so the title aligns with the
    // Privacy feed's rows: the row starts 12.dp into the inset and the 8.dp
    // dot plus its 4.dp gap fill the rest. The slot is identical whether the
    // dot is painted or transparent, so marking a brief read never shifts text.
    // Note: `offset` rather than negative `padding` — Compose padding must be
    // non-negative and throws otherwise.
    Row(
        Modifier.fillMaxWidth().padding(vertical = OmSpacing.md).offset(x = (-12).dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            Modifier.padding(top = 6.dp).size(8.dp).clip(CircleShape)
                .background(if (unread) colors.accent else colors.bgPrimary),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text(
                brief.title,
                style = MaterialTheme.typography.bodyLarge.copy(
                    fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                ),
                color = colors.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (brief.description.isNotBlank()) {
                Text(
                    briefRowPlainDescription(brief.description),
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(
                TimeFormat.relative(isoToEpochMillis(brief.createdAt), now.toEpochMilli()),
                style = MaterialTheme.typography.labelSmall,
                color = colors.textMuted,
            )
        }
    }
}

private fun isoToEpochMillis(iso: String): Long =
    runCatching { Instant.parse(iso).toEpochMilli() }.getOrDefault(0L)
