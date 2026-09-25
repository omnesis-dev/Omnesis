// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.appusage

import java.util.Base64

/**
 * The android-app-usage source's glyph — a minimal three-bar chart (not
 * sourced from a specific icon library), tinted Android green and embedded
 * as a base64 data URI so the portal's strict CSP (`img-src 'self' data:
 * blob:`) lets it through. Same construction shape as `CallLogIcon`.
 */

private const val BAR_CHART_SVG =
    """<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>"""

/** Android green. */
private const val APP_USAGE_TINT = "#3DDC84"

internal fun tintSvg(svg: String, color: String): String =
    svg.replace("stroke=\"currentColor\"", "stroke=\"$color\"")

internal fun svgDataUri(svg: String): String =
    "data:image/svg+xml;base64," + Base64.getEncoder().encodeToString(svg.toByteArray(Charsets.UTF_8))

/** Rides every sync-state write as the source's display icon. */
val APP_USAGE_ICON_DATA_URI: String = svgDataUri(tintSvg(BAR_CHART_SVG, APP_USAGE_TINT))
