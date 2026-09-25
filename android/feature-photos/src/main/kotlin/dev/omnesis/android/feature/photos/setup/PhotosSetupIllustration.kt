// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.setup.ui.SetupCard
import dev.omnesis.android.setup.ui.asSetupForeground
import dev.omnesis.android.setup.ui.setupPalette

/**
 * The disclosure as a picture: a photo held behind a lock on this phone, and
 * only the lines read from it crossing to the gateway. Every line is invented.
 */
@Composable
fun PhotosSetupIllustration(modifier: Modifier = Modifier) {
    val palette = setupPalette
    val tint = PhotosSetupCopy.tint
    SetupCard(
        modifier.semantics { contentDescription = "A photo stays on this phone; only the text and details read from it are sent." },
        verticalPadding = 12.dp,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PhotoTile()
            Icon(
                Icons.AutoMirrored.Filled.ArrowForward,
                contentDescription = null,
                tint = tint.asSetupForeground(palette),
                modifier = Modifier.size(18.dp),
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                listOf(
                    "text: “kickoff goals · q3”",
                    "labels: whiteboard, office",
                    "added: 12 Mar, 10:05",
                    "place: Harbor District",
                ).forEach { line ->
                    Text(
                        line,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(6.dp))
                            .background(palette.chip)
                            .padding(horizontal = 7.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp),
                        color = palette.chipText,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun PhotoTile() {
    val shape = RoundedCornerShape(11.dp)
    Box(
        Modifier
            .width(72.dp)
            .height(84.dp)
            .clip(shape)
            .background(Brush.linearGradient(listOf(Color(0xFF2B4C7A), Color(0xFF15253D))))
            .border(1.dp, Color(0xFF2A3D57), shape),
    ) {
        Column(Modifier.padding(start = 12.dp, top = 18.dp, end = 14.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
            listOf(1f, 0.7f, 0.85f).forEach { fraction ->
                Box(
                    Modifier
                        .fillMaxWidth(fraction)
                        .height(3.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(Color(0xFFE9EEF5).copy(alpha = 0.75f)),
                )
            }
        }
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(5.dp)
                .size(20.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Color(0xFF0B121D).copy(alpha = 0.8f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Lock, contentDescription = null, tint = Color(0xFFE6EDF3), modifier = Modifier.size(12.dp))
        }
    }
}
