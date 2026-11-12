// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import dev.omnesis.android.wear.R
import kotlin.math.PI
import kotlin.math.pow
import kotlin.math.sin

/**
 * The mark inside two outward, fading ripples, as Tell Omnesis draws it on
 * the phone, sized for the wrist. Voice changes the light, never the rhythm
 * of the rings. The rings stand still when the microphone is closed, when
 * the person has turned animations off, and for a capture.
 */
@Composable
fun CaptureHalo(
    listening: Boolean,
    level: Float,
    size: Dp,
    reduceMotion: Boolean,
    modifier: Modifier = Modifier,
) {
    val animate = listening && !reduceMotion && !LocalInspectionMode.current
    val phase: Float? = if (animate) {
        val ripple = rememberInfiniteTransition(label = "halo")
        val value by ripple.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(RIPPLE_MILLIS, easing = LinearEasing), RepeatMode.Restart),
            label = "ripple",
        )
        value
    } else {
        null
    }
    val target = if (listening) level.coerceIn(0f, 1f) else 0f
    val energy = if (reduceMotion || LocalInspectionMode.current) {
        target
    } else {
        val eased by animateFloatAsState(target, tween(300), label = "level")
        eased
    }
    Box(modifier = modifier.size(size).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val unit = this.size.minDimension / HALO_POINTS
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(WearPalette.Accent.copy(alpha = 0.14f + energy * 0.12f), Color.Transparent),
                    center = center,
                    radius = 48 * unit,
                ),
                radius = 48 * unit,
            )
            repeat(RINGS) { index ->
                val progress = phase?.let { (it + index.toFloat() / RINGS) % 1f }
                val travel = progress?.let { 1 - (1 - it).pow(2) } ?: ((index + 1f) / RINGS)
                val opacity = progress?.let { 0.48f * sin(PI.toFloat() * it) * (1 - 0.35f * it) }
                    ?: if (listening) 0.26f else 0.12f
                drawCircle(
                    color = WearPalette.Accent.copy(alpha = opacity),
                    radius = (44 + 52 * travel) / 2 * unit,
                    style = Stroke(width = 1.5f * unit),
                )
            }
        }
        Image(
            painter = painterResource(R.drawable.omnesis_mark),
            contentDescription = null,
            modifier = Modifier.size(size * (36f / HALO_POINTS)).scale(if (reduceMotion) 1f else 1 + energy * 0.025f),
            colorFilter = ColorFilter.tint(WearPalette.Accent),
        )
    }
}

/** The halo is drawn on a 96-point square and scaled to the size it is given. */
private const val HALO_POINTS = 96f
private const val RINGS = 2
private const val RIPPLE_MILLIS = 1600
