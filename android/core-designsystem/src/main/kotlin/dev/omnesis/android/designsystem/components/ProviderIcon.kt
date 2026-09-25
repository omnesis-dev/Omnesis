// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import android.net.Uri
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import coil.compose.SubcomposeAsyncImage
import dev.omnesis.android.designsystem.theme.OmTheme
import java.util.Base64
import java.util.Locale

private val EMPTY_PROVIDER_IDS = setOf("local", "none", "replay")

/** SVG markup obtained from the paired gateway, keyed by catalog provider id. */
val LocalProviderLogos = compositionLocalOf<Map<String, String>> { emptyMap() }

@Composable
fun ProviderLogos(logos: Map<String, String>, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalProviderLogos provides logos, content = content)
}

/** Provider brand art supplied by the gateway, with a neutral fallback. */
@Composable
fun ProviderIcon(providerId: String, modifier: Modifier = Modifier, size: Dp = 14.dp) {
    if (providerId in EMPTY_PROVIDER_IDS) return
    val data = LocalProviderLogos.current[providerId]
    if (data.isNullOrBlank()) {
        NeutralBackendGlyph(modifier.size(size))
    } else {
        val tint = "#%06X".format(Locale.ROOT, OmTheme.colors.textPrimary.toArgb() and 0xFFFFFF)
        val imageData = remember(data, tint) { Uri.parse(providerLogoDataUri(data, tint)) }
        SubcomposeAsyncImage(
            model = imageData,
            contentDescription = providerId,
            contentScale = ContentScale.Fit,
            modifier = modifier.size(size),
            loading = { NeutralBackendGlyph(Modifier.fillMaxSize()) },
            error = { NeutralBackendGlyph(Modifier.fillMaxSize()) },
        )
    }
}

internal fun providerLogoDataUri(svg: String, foregroundColor: String): String =
    "data:image/svg+xml;base64," + Base64.getEncoder().encodeToString(
        svg.replace("currentColor", foregroundColor).toByteArray(Charsets.UTF_8),
    )

/** Backend icon; custom names use the same neutral mark until catalog art is known. */
@Composable
fun BackendBrandIcon(key: String, modifier: Modifier = Modifier, size: Dp = 18.dp) {
    ProviderIcon(providerId = key, modifier = modifier, size = size)
}

@Composable
private fun NeutralBackendGlyph(modifier: Modifier) {
    Icon(
        imageVector = Icons.Default.Dns,
        contentDescription = null,
        tint = OmTheme.colors.textSecondary,
        modifier = modifier,
    )
}
