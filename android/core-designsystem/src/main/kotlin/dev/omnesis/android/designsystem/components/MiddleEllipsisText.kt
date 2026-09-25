// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.layout
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer

/**
 * Single-line text that truncates in the MIDDLE (keeping head + tail) rather than the end —
 * so a trailing token stays visible ("openai · text-embedding-…-small", "long…document.pdf").
 * Ports the iOS `.truncationMode(.middle)`. Compose 1.7 has no `TextOverflow.MiddleEllipsis`,
 * so we measure against the available width and splice "…".
 *
 * Implemented as a leaf (`Modifier.layout` + `Modifier.drawBehind`) rather than
 * `BoxWithConstraints`: callers may live inside a `Modifier.height(IntrinsicSize.Min)` parent,
 * and `BoxWithConstraints` throws under intrinsic measurement. A leaf draws the text itself with
 * the real incoming `maxWidth` and reports a clean single-line height upward.
 */
@Composable
fun MiddleEllipsisText(
    text: String,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
) {
    val measurer = rememberTextMeasurer()
    val resolvedStyle = style.merge(TextStyle(color = color))
    // Single-line natural height, used for the intrinsic / unconstrained path.
    val naturalHeight = remember(text, resolvedStyle) {
        measurer.measure(text, resolvedStyle, maxLines = 1, softWrap = false).size.height
    }
    var layoutRef by remember { mutableStateOf<TextLayoutResult?>(null) }
    Box(
        modifier
            .layout { measurable, constraints ->
                val maxPx = constraints.maxWidth.toFloat()
                val resolved = middleTruncate(text, resolvedStyle, maxPx, measurer)
                val tl = measurer.measure(
                    text = resolved,
                    style = resolvedStyle,
                    maxLines = 1,
                    softWrap = false,
                )
                layoutRef = tl
                // Under a weighted parent the incoming width is fixed (minWidth == maxWidth);
                // report the full width so the leaf doesn't end up centred in the slot. When
                // width is unbounded (intrinsic pass / wrap) report the natural text width.
                val w = if (constraints.minWidth == constraints.maxWidth && constraints.hasBoundedWidth) {
                    constraints.maxWidth
                } else {
                    tl.size.width.coerceAtMost(if (constraints.hasBoundedWidth) constraints.maxWidth else tl.size.width)
                }
                val h = tl.size.height.coerceAtLeast(naturalHeight)
                // Empty placeable — the modifier chain owns size + drawing.
                val placeable = measurable.measure(
                    constraints.copy(minWidth = 0, maxWidth = 0, minHeight = 0, maxHeight = h),
                )
                layout(w, h) { placeable.place(0, 0) }
            }
            .drawBehind {
                layoutRef?.let { drawText(it) }
            },
    )
}

private fun middleTruncate(
    text: String,
    style: TextStyle,
    maxWidthPx: Float,
    measurer: TextMeasurer,
): String {
    if (maxWidthPx <= 0f) return text
    fun fits(s: String): Boolean =
        measurer.measure(s, style, maxLines = 1, softWrap = false).size.width <= maxWidthPx
    if (fits(text)) return text
    val ellipsis = "…"
    // Binary-search the largest head/tail split that still fits.
    var lo = 0
    var hi = text.length
    var best = ellipsis
    while (lo <= hi) {
        val keep = (lo + hi) / 2
        val head = keep - keep / 2
        val tail = keep / 2
        if (head + tail >= text.length) { hi = keep - 1; continue }
        val candidate = text.take(head) + ellipsis + text.takeLast(tail)
        if (fits(candidate)) { best = candidate; lo = keep + 1 } else hi = keep - 1
    }
    return best
}
