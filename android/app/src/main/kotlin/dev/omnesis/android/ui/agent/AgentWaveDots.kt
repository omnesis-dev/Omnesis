// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme
import kotlin.math.roundToInt

// ─── "Still working" wave dots ───────────────────────────────────────────
//
// Every agent surface that has to say "something is still happening" uses the
// same three dots: the turn-level working indicator, the thinking disclosure,
// and the sub-agent card's running marker. They differ only in size and colour,
// so the motion itself lives here once.

/** One full wave, in milliseconds — the portal `agent-thinking-dot` cycle. */
private const val WaveCycleMs = 1300

/**
 * Per-dot phase offsets as a fraction of the cycle — the portal's 0 / 0.18s /
 * 0.36s `animation-delay` over a 1.3s cycle. A delay shifts a dot BACKWARDS
 * through the cycle, so dot 0 peaks first and the crest travels rightwards.
 */
internal val WaveStagger = floatArrayOf(0f, 0.18f / 1.3f, 0.36f / 1.3f)

/** The cycle position a frozen (inspection-mode) render holds — mid-wave, so all three phases show. */
private const val WaveFrozenPhase = 0.30f

/**
 * Three dots travelling a wave: each rises and brightens in turn, then rests dim
 * for the remainder of the cycle, so the row reads as a crest crossing it rather
 * than three dots pulsing together. A faithful port of the portal's
 * `@keyframes agent-thinking-dot` — peak at 35 % of the cycle, back at rest by
 * 70 %, flat until the cycle restarts.
 *
 * ONE infinite transition drives all three dots and each reads it at its own phase
 * offset, so the stagger is exact by construction. The cycle reaches the modifiers
 * as a [State] read only inside their lambdas, so a frame advances layout and draw
 * without recomposing anything.
 *
 * Under inspection (Roborazzi / `@Preview`) no transition is created at all — an
 * always-running animation keeps Compose non-idle and hangs a native capture —
 * and the dots freeze at [WaveFrozenPhase] so the golden still shows the wave.
 */
@Composable
internal fun AgentWaveDots(
    modifier: Modifier = Modifier,
    dotSize: Dp = 5.dp,
    spacing: Dp = 4.dp,
    lift: Dp = 2.dp,
    color: Color = OmTheme.colors.accent,
    restAlpha: Float = 0.25f,
    contentDescription: String = "Working",
) {
    val cycle: State<Float> = if (LocalInspectionMode.current) {
        remember { mutableFloatStateOf(WaveFrozenPhase) }
    } else {
        rememberInfiniteTransition(label = "agentWaveDots")
            .animateFloat(
                initialValue = 0f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(WaveCycleMs, easing = LinearEasing),
                    repeatMode = RepeatMode.Restart,
                ),
                label = "agentWaveCycle",
            )
    }
    Row(
        modifier.semantics { this.contentDescription = contentDescription },
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(spacing),
    ) {
        repeat(3) { i ->
            Box(
                Modifier
                    // The lift is a PLACEMENT offset rather than a draw-time translation, so
                    // the dot's reported bounds rise with it and a test can see the wave.
                    .offset { IntOffset(0, -(lift.toPx() * waveCrest(cycle.value - WaveStagger[i])).roundToInt()) }
                    // Tagged INSIDE the offset so a test reads the lifted position, not the
                    // slot the row reserved for it.
                    .testTag("agentWaveDot$i")
                    .size(dotSize)
                    .clip(CircleShape)
                    .graphicsLayer {
                        alpha = restAlpha + (1f - restAlpha) * waveCrest(cycle.value - WaveStagger[i])
                    }
                    .background(color),
            )
        }
    }
}

/**
 * How far through its rise-and-fall one dot is (0 = at rest, 1 = at the crest) for
 * a cycle position that may be negative or past 1 (a staggered dot's shifted phase
 * wraps into range here). Rises over the first 35 % of the cycle, falls back over
 * the next 35 %, and rests for the last 30 % — the portal keyframes, eased the way
 * the CSS `ease-in-out` shapes each leg.
 */
internal fun waveCrest(rawPhase: Float): Float {
    val phase = ((rawPhase % 1f) + 1f) % 1f
    return when {
        phase < 0.35f -> FastOutSlowInEasing.transform(phase / 0.35f)
        phase < 0.70f -> FastOutSlowInEasing.transform(1f - (phase - 0.35f) / 0.35f)
        else -> 0f
    }
}
