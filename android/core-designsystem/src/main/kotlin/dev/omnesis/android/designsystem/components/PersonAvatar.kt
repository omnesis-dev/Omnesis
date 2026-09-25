// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.absoluteValue

private val AVATAR_PALETTE = listOf(
    Color(0xFF5B6CFF), Color(0xFF00897B), Color(0xFFD81B60), Color(0xFF6D4C41),
    Color(0xFF3949AB), Color(0xFF00838F), Color(0xFFAD1457), Color(0xFF2E7D32),
    Color(0xFF7B1FA2), Color(0xFFEF6C00), Color(0xFF455A64),
)

/** Deterministic initials from a person's name (first + last initial, or first two chars). */
fun personInitials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return when {
        parts.isEmpty() -> "?"
        parts.size == 1 -> parts[0].take(2).uppercase()
        else -> "${parts.first().first()}${parts.last().first()}".uppercase()
    }
}

/** Deterministic, source-agnostic avatar color derived from the name hash. */
fun avatarColor(name: String): Color =
    AVATAR_PALETTE[name.hashCode().absoluteValue % AVATAR_PALETTE.size]

@Composable
fun PersonAvatar(
    name: String,
    modifier: Modifier = Modifier,
    isSelf: Boolean = false,
    size: Dp = 40.dp,
) {
    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(avatarColor(name))
            .then(if (isSelf) Modifier.border(2.dp, Color(0xFF2E7D32), CircleShape) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = personInitials(name),
            color = Color.White,
            style = MaterialTheme.typography.labelLarge,
        )
    }
}
