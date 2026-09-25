// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.SubcomposeAsyncImage
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * Generic, source-agnostic icon model resolved from the gateway (`source-meta.json` brand
 * art or descriptor `imageDataUri`/`url`), never from a per-source drawable. [imageData]
 * may be a `data:` URI (PNG or SVG) or an http URL. `data:` URIs are decoded by the
 * app's [dev.omnesis.android.designsystem.image.DataUriFetcher] (Coil 2.x can't fetch
 * them natively). When absent, a neutral document glyph is shown (never a source-specific
 * initial/colour).
 */
data class SourceIconModel(
    val imageData: String? = null,
    val fallbackInitial: String = "?",
    val accentColor: Color? = null,
    val bgColor: Color? = null,
)

/**
 * Source brand icon. Ported from the iOS `SourceIconView`: the gateway-supplied art
 * renders edge-to-edge (it carries its own padding/shape) at [size] (default 22dp, the
 * iOS default), with NO background box and NO shrink. Falls back to a neutral `doc.text`
 * glyph when the gateway provides no art OR the art fails to load — so an icon never
 * renders as an invisible blank box.
 */
@Composable
fun SourceIcon(
    model: SourceIconModel,
    modifier: Modifier = Modifier,
    size: Dp = 22.dp,
) {
    val data = model.imageData
    if (data.isNullOrBlank()) {
        NeutralSourceGlyph(modifier.size(size))
    } else {
        SubcomposeAsyncImage(
            model = data,
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = modifier.size(size),
            loading = { NeutralSourceGlyph(Modifier.fillMaxSize()) },
            error = { NeutralSourceGlyph(Modifier.fillMaxSize()) },
        )
    }
}

/** Neutral document glyph shown when no source art is available or it fails to load. */
@Composable
private fun NeutralSourceGlyph(modifier: Modifier) {
    Icon(
        imageVector = Icons.Outlined.Description,
        contentDescription = null,
        tint = OmTheme.colors.textSecondary,
        modifier = modifier,
    )
}

/** Parses `#RRGGBB` / `#AARRGGBB` (with or without `#`) into a Compose [Color], or null. */
fun parseHexColor(hex: String?): Color? {
    val cleaned = hex?.trim()?.removePrefix("#") ?: return null
    val argb = runCatching {
        when (cleaned.length) {
            6 -> 0xFF000000L or cleaned.toLong(16)
            8 -> cleaned.toLong(16)
            else -> null
        }
    }.getOrNull() ?: return null
    return Color(argb)
}
