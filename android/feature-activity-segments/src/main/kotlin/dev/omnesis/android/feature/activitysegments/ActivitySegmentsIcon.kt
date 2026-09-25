// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.activitysegments

import java.util.Base64

/**
 * The android-activity-segments source's glyph — two waypoints joined by a
 * route, tinted Android green and embedded as a base64 data URI so the
 * portal's strict CSP (`img-src 'self' data: blob:`) lets it through. Same
 * construction shape as `CallLogIcon`/`AppUsageIcon`.
 */

private const val ROUTE_SVG =
    """<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M7.5 16.5 16.5 7.5"/></svg>"""

/** Android green. */
private const val ACTIVITY_SEGMENTS_TINT = "#3DDC84"

internal fun tintSvg(svg: String, color: String): String =
    svg.replace("stroke=\"currentColor\"", "stroke=\"$color\"")

internal fun svgDataUri(svg: String): String =
    "data:image/svg+xml;base64," + Base64.getEncoder().encodeToString(svg.toByteArray(Charsets.UTF_8))

/** Rides every sync-state write as the source's display icon. */
val ACTIVITY_SEGMENTS_ICON_DATA_URI: String = svgDataUri(tintSvg(ROUTE_SVG, ACTIVITY_SEGMENTS_TINT))
