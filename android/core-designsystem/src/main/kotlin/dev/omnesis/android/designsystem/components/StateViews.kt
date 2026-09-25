// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.animation.core.withInfiniteAnimationFrameNanos
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.progressSemantics
import androidx.compose.material3.ProgressIndicatorDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Diameter used when the caller supplies no size, matching Material's circular indicator. */
private val SpinnerDiameter = 40.dp

/** Arc length of the sweep, in degrees — enough of the circle to read as motion. */
private const val SPINNER_SWEEP_DEGREES = 270f

/** A full revolution per second. */
private const val SPINNER_DEGREES_PER_MS = 360f / 1000f

/** Where the frozen arc starts under inspection, so a captured spinner is not axis-aligned. */
private const val SPINNER_FROZEN_START_DEGREES = 135f

/**
 * Indeterminate progress spinner: an arc sweeping once per second.
 *
 * The rotation is driven straight off the frame clock rather than an animation, because
 * Material's indeterminate `CircularProgressIndicator` is built from an `InfiniteTransition`
 * and so honours the system animator duration scale. With animations switched off — developer
 * options, battery saver, or the reduce-motion accessibility setting — every keyframe snaps to
 * its end value, the arc's start and end angles converge on the same degree, and the sweep
 * collapses to a zero-length stroke that paints as a single dot. The frame clock ignores that
 * scale, so the spinner keeps turning in those settings the way iOS's `UIActivityIndicatorView`
 * does.
 *
 * `withInfiniteAnimationFrameNanos` rather than `withFrameNanos`: frames requested through it
 * are excluded from idleness accounting, so a screen holding a spinner still reaches idle for
 * Espresso and the Compose test clock. A plain frame loop never lets a test settle.
 *
 * Under [LocalInspectionMode] the arc freezes at a representative angle: an unbounded animation
 * never reaches idle and would **hang the native screenshot capture**. Both paths draw the same
 * arc, so a recorded golden shows exactly what a user sees. Use this — never a raw
 * `CircularProgressIndicator` — for any indeterminate spinner in the app.
 */
@Composable
fun OmSpinner(
    modifier: Modifier = Modifier,
    color: Color = ProgressIndicatorDefaults.circularColor,
    strokeWidth: Dp = ProgressIndicatorDefaults.CircularStrokeWidth,
) {
    val frozen = LocalInspectionMode.current
    var rotation by remember { mutableFloatStateOf(SPINNER_FROZEN_START_DEGREES) }
    if (!frozen) {
        LaunchedEffect(Unit) {
            var previousFrameNanos = 0L
            while (true) {
                withInfiniteAnimationFrameNanos { frameNanos ->
                    if (previousFrameNanos != 0L) {
                        val elapsedMs = (frameNanos - previousFrameNanos) / 1_000_000f
                        rotation = (rotation + elapsedMs * SPINNER_DEGREES_PER_MS) % 360f
                    }
                    previousFrameNanos = frameNanos
                }
            }
        }
    }
    // The caller's own size wins: their modifier constrains the default that follows it.
    // `progressSemantics` keeps the arc announcing itself as indeterminate progress, which a
    // bare Canvas would not — a screen that is only a spinner would otherwise be silent.
    Canvas(modifier.then(Modifier.progressSemantics().size(SpinnerDiameter))) {
        val stroke = strokeWidth.toPx()
        val inset = stroke / 2f
        drawArc(
            color = color,
            startAngle = rotation,
            sweepAngle = SPINNER_SWEEP_DEGREES,
            useCenter = false,
            topLeft = Offset(inset, inset),
            size = Size(size.width - stroke, size.height - stroke),
            style = Stroke(width = stroke, cap = StrokeCap.Round),
        )
    }
}

/** Centered progress spinner. */
@Composable
fun LoadingView(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        OmSpinner()
    }
}

/** Error state with a human message and an optional retry. Mirrors the iOS GatewayErrorView. */
@Composable
fun ErrorView(
    message: String,
    modifier: Modifier = Modifier,
    onRetry: (() -> Unit)? = null,
) {
    Column(
        modifier = modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        if (onRetry != null) {
            Spacer(Modifier.height(16.dp))
            Button(onClick = onRetry) { Text("Retry") }
        }
    }
}

/** Neutral empty state. */
@Composable
fun EmptyView(message: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}
