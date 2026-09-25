// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * Placeholder transcript shown while a resumed conversation's messages are still loading.
 * Opening a stored conversation switches the surface to the target the instant it's tapped
 * ([AgentCoordinator.beginResume]); this skeleton fills the brief gap until the real transcript
 * lands, so navigation never blocks on the network and the user always sees *a* conversation
 * taking shape rather than the previous one lingering. Mirrors the iOS `AgentTranscriptSkeleton`.
 *
 * A few breathing placeholder bubbles — alternating assistant (leading, multi-line) and user
 * (trailing accent pill) — approximate a real transcript's rhythm. The breathing pulse is gated
 * on [LocalInspectionMode] so Roborazzi screenshot capture (which never idles an infinite
 * animation — see android/CLAUDE.md) freezes at a representative frame instead of hanging.
 */
@Composable
fun AgentTranscriptSkeleton(modifier: Modifier = Modifier) {
    val pulse = if (LocalInspectionMode.current) {
        0.55f
    } else {
        val transition = rememberInfiniteTransition(label = "skeletonPulse")
        transition.animateFloat(
            initialValue = 0.35f,
            targetValue = 0.75f,
            animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
            label = "skeletonAlpha",
        ).value
    }
    Column(
        modifier
            .fillMaxSize()
            // Sit below the status bar, then clear the floating menu / new-conversation buttons
            // (which are themselves status-bar-inset in AgentScreen) — inset-aware so the first
            // bar never slides behind them on a tall notch.
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(horizontal = 12.dp)
            .padding(top = 56.dp)
            .semantics { contentDescription = "Loading conversation" },
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        AssistantBlock(listOf(0.86f, 0.72f, 0.50f), pulse)
        UserPill(0.55f, pulse)
        AssistantBlock(listOf(0.90f, 0.76f), pulse)
        UserPill(0.40f, pulse)
        AssistantBlock(listOf(0.80f, 0.64f, 0.68f, 0.36f), pulse)
    }
}

/** A leading-aligned stack of placeholder lines — an assistant reply. */
@Composable
private fun AssistantBlock(lineFractions: List<Float>, pulse: Float) {
    Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        lineFractions.forEach { fraction -> Bar(fraction, pulse) }
    }
}

/** A trailing-aligned accent pill — a user message, matching the real bubble's corner radius. */
@Composable
private fun UserPill(fraction: Float, pulse: Float) {
    Row(Modifier.fillMaxWidth()) {
        Spacer(Modifier.weight(1f))
        Box(
            Modifier
                .fillMaxWidth(fraction)
                .height(34.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(OmTheme.colors.accent.copy(alpha = 0.10f + 0.12f * pulse)),
        )
    }
}

/** One breathing placeholder line. */
@Composable
private fun Bar(fraction: Float, pulse: Float) {
    Box(
        Modifier
            .fillMaxWidth(fraction)
            .height(13.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(OmTheme.colors.bgTertiary.copy(alpha = pulse)),
    )
}
