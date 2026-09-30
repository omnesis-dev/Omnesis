// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.briefs

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * A brief's row while it is being dictated to: the row *is* the recording surface.
 *
 * The mic pulses, the transcript streams in where the description was, and tapping
 * anywhere stops and sends. Replacing the row rather than opening a sheet is the point —
 * the user is answering *this* brief, and the answer should happen where the brief is
 * rather than on a surface that hides the feed.
 *
 * [displayText] is the committed utterances plus the in-flight guess, so the words appear
 * as they are heard rather than in silence until the recogniser finalises.
 */
@Composable
fun BriefRowDictating(
    title: String,
    displayText: String,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OmTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .background(colors.bgPrimary)
            .clickable(onClick = onStop)
            // Side insets come from the list's content padding (matching the
            // Privacy feed), so the row carries only its vertical padding.
            .padding(vertical = OmSpacing.md)
            .semantics { contentDescription = "Recording. Tap to stop and send." },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        PulsingMic()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
            Text(
                title,
                style = MaterialTheme.typography.labelMedium,
                color = colors.textMuted,
            )
            Text(
                displayText.ifBlank { "Listening…" },
                style = MaterialTheme.typography.bodyLarge,
                color = if (displayText.isBlank()) colors.textMuted else colors.textPrimary,
            )
        }
    }
}

/**
 * The accent-filled mic, breathing while the recogniser is hot.
 *
 * The pulse is frozen under `LocalInspectionMode`. An infinite animation never idles, and
 * the screenshot lane waits for idle — so an ungated one does not merely animate in a
 * still, it hangs the capture forever, writing no PNGs at all.
 */
@Composable
private fun PulsingMic() {
    val colors = OmTheme.colors
    val scale = if (LocalInspectionMode.current) {
        1f
    } else {
        val transition = rememberInfiniteTransition(label = "dictationPulse")
        val animated by transition.animateFloat(
            initialValue = 1f,
            targetValue = 1.18f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 700, easing = LinearEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "dictationPulseScale",
        )
        animated
    }
    Box(
        Modifier
            .size(40.dp)
            .scale(scale)
            .clip(CircleShape)
            .background(colors.accent),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Outlined.Mic,
            contentDescription = null,
            tint = androidx.compose.ui.graphics.Color.White,
            modifier = Modifier.size(20.dp),
        )
    }
}
