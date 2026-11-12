// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.ui

import androidx.annotation.DrawableRes
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyListAnchorType
import androidx.wear.compose.foundation.lazy.ScalingLazyListScope
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.PositionIndicator
import androidx.wear.compose.material.Scaffold
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeSource
import androidx.wear.compose.material.TimeText
import androidx.wear.compose.material.TimeTextDefaults
import androidx.wear.compose.material.Vignette
import androidx.wear.compose.material.VignettePosition

/** How much a button asks for attention. */
enum class ButtonEmphasis {
    /** The screen's main action. */
    PRIMARY,

    /** An action beside the main one. */
    TONAL,

    /** A way out, drawn as text alone. */
    PLAIN,
}

/** The smallest height and width anything pressable takes, so a fingertip can hit it. */
val MinimumTouchTarget: Dp = 48.dp

/** A pill-shaped button with a label and an optional leading icon. */
@Composable
fun PillButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    emphasis: ButtonEmphasis = ButtonEmphasis.PRIMARY,
    @DrawableRes icon: Int? = null,
    enabled: Boolean = true,
    tag: String? = null,
) {
    val background = when (emphasis) {
        ButtonEmphasis.PRIMARY -> WearPalette.Accent
        ButtonEmphasis.TONAL -> WearPalette.Tonal
        ButtonEmphasis.PLAIN -> Color.Transparent
    }
    val foreground = when (emphasis) {
        ButtonEmphasis.PRIMARY -> WearPalette.OnAccent
        ButtonEmphasis.TONAL -> WearPalette.Accent
        ButtonEmphasis.PLAIN -> WearPalette.SecondaryText
    }
    Row(
        modifier = modifier
            .then(if (tag != null) Modifier.testTag(tag) else Modifier)
            .defaultMinSize(minWidth = MinimumTouchTarget, minHeight = MinimumTouchTarget)
            .clip(CircleShape)
            .background(background)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(18.dp), tint = foreground)
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text = text,
            color = foreground,
            style = if (emphasis == ButtonEmphasis.PLAIN) MaterialTheme.typography.caption1 else MaterialTheme.typography.button,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
}

/** A round button showing an icon alone; [label] is what a screen reader says. */
@Composable
fun CircleIconButton(
    @DrawableRes icon: Int,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Box(
        modifier = modifier
            .size(MinimumTouchTarget)
            .clip(CircleShape)
            .background(WearPalette.Tonal)
            .clickable(enabled = enabled, onClickLabel = label, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painterResource(icon), contentDescription = label, modifier = Modifier.size(22.dp), tint = WearPalette.Accent)
    }
}

/** A line of supporting text under an icon, as a status header. */
@Composable
fun StatusLabel(text: String, @DrawableRes icon: Int, color: Color, modifier: Modifier = Modifier) {
    Row(modifier = modifier, verticalAlignment = Alignment.CenterVertically) {
        Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(14.dp), tint = color)
        Spacer(Modifier.width(4.dp))
        Text(text = text, color = color, style = MaterialTheme.typography.caption2)
    }
}

/** The room a screen's content keeps clear at each edge. */
data class ScreenInsets(val horizontal: Dp, val top: Dp, val bottom: Dp)

/**
 * The room content leaves at each edge. A round screen is narrowest at its
 * top and bottom, so text there is inset further than on a square one.
 */
@Composable
fun screenInsets(underTime: Boolean): ScreenInsets {
    val configuration = LocalConfiguration.current
    val width = configuration.screenWidthDp.dp
    val height = configuration.screenHeightDp.dp
    return if (configuration.isScreenRound) {
        // A fifth of the way down a disc is where it is first as wide as the
        // side insets assume, so a line of text starting there is not clipped.
        ScreenInsets(horizontal = width * 0.1f, top = height * (if (underTime) 0.2f else 0.1f), bottom = height * 0.2f)
    } else {
        ScreenInsets(horizontal = width * 0.05f, top = if (underTime) 26.dp else 8.dp, bottom = 12.dp)
    }
}

/**
 * A scrolling screen: a column that starts under the time, scrolls by touch
 * and by the crown, and shows where it is. Content shorter than the screen is
 * centred. [fadesAtEdges] darkens the top and bottom, for a screen of text
 * that scrolls under the curve of a round display.
 */
@Composable
fun WatchColumn(
    modifier: Modifier = Modifier,
    showTime: Boolean = true,
    fadesAtEdges: Boolean = false,
    content: ScalingLazyListScope.() -> Unit,
) {
    val listState = rememberScalingLazyListState(initialCenterItemIndex = 0)
    val insets = screenInsets(underTime = showTime)
    Scaffold(
        modifier = modifier,
        vignette = { if (fadesAtEdges) Vignette(vignettePosition = VignettePosition.TopAndBottom) },
        timeText = { if (showTime) WatchTime() },
        positionIndicator = { PositionIndicator(scalingLazyListState = listState) },
    ) {
        ScalingLazyColumn(
            modifier = Modifier.fillMaxSize(),
            state = listState,
            contentPadding = PaddingValues(
                start = insets.horizontal,
                end = insets.horizontal,
                top = insets.top,
                bottom = insets.bottom,
            ),
            verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
            anchorType = ScalingLazyListAnchorType.ItemStart,
            autoCentering = null,
            content = content,
        )
    }
}

/** The time at the top of a screen. A capture shows a fixed time so its image never changes. */
@Composable
fun WatchTime() {
    val source = if (LocalInspectionMode.current) {
        FixedTime
    } else {
        TimeTextDefaults.timeSource(TimeTextDefaults.timeFormat())
    }
    TimeText(timeSource = source)
}

private object FixedTime : TimeSource {
    override val currentTime: String
        @Composable get() = "10:09"
}

/**
 * Three accent dots that bounce in a staggered wave: the "still working"
 * signal, in the same motion as the phone app's. Drawn still for a capture.
 */
@Composable
fun ThinkingDots(modifier: Modifier = Modifier) {
    Row(modifier = modifier.clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        if (LocalInspectionMode.current) {
            STILL_DOTS.forEach { Dot(lift = it) }
        } else {
            val wave = rememberInfiniteTransition(label = "thinking")
            repeat(STILL_DOTS.size) { index ->
                val lift by wave.animateFloat(
                    initialValue = 0f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(
                        animation = tween(durationMillis = 650, easing = FastOutSlowInEasing),
                        repeatMode = RepeatMode.Reverse,
                        initialStartOffset = StartOffset(index * 180),
                    ),
                    label = "dot",
                )
                Dot(lift)
            }
        }
    }
}

/** One dot, from resting ([lift] 0) to the top of its bounce ([lift] 1). */
@Composable
private fun Dot(lift: Float) {
    Box(
        Modifier
            .offset(y = (-2 * lift).dp)
            .size(4.dp)
            .alpha(0.25f + 0.75f * lift)
            .background(WearPalette.Accent, CircleShape),
    )
}

private val STILL_DOTS = listOf(1f, 0.55f, 0.1f)
