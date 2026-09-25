// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * Join a failure code and a provider disposition into the one machine-readable line the
 * failure surfaces print — `http_api_error · HTTP 404 · NOT_FOUND · param=model`. Blank or
 * absent halves drop out; `null` when neither is carried, so the caller renders nothing.
 * Pure, so the vocabulary is testable without a render.
 */
fun failureDetailLine(code: String?, detail: String?): String? =
    listOfNotNull(code?.takeIf { it.isNotBlank() }, detail?.takeIf { it.isNotBlank() })
        .takeIf { it.isNotEmpty() }
        ?.joinToString(" · ")

/**
 * The quiet second line under a humanized failure sentence: the failure's code and, when the
 * provider reported one, its disposition — monospaced and muted, so it reads as a diagnostic
 * to quote rather than as part of the explanation. Renders nothing when there is nothing to say.
 */
@Composable
fun OmFailureDetailLine(code: String?, detail: String?, modifier: Modifier = Modifier) {
    val line = failureDetailLine(code, detail) ?: return
    Text(
        line,
        style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
        color = OmTheme.colors.textMuted,
        modifier = modifier,
    )
}
