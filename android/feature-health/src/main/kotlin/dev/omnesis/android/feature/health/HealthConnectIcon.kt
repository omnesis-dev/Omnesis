// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import java.util.Base64

/**
 * The health-connect source's glyph — a Lucide heart-pulse SVG (ISC-licensed)
 * tinted Android green and embedded as a base64 data URI so the portal's strict
 * CSP (`img-src 'self' data: blob:`) lets it through.
 *
 * Android owns its own copy of the construction in
 * `packages/providers-synth/health-connect/src/icons.ts`; the output must stay
 * byte-identical to the TS one so the portal shows a single stable icon for the
 * source no matter which side registered it (asserted by `HealthConnectIconTest`).
 */

private const val HEART_PULSE_SVG =
    """<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/><path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27"/></svg>"""

/** Android green. */
private const val HEALTH_CONNECT_TINT = "#3DDC84"

internal fun tintLucideSvg(svg: String, color: String): String =
    svg.replace("stroke=\"currentColor\"", "stroke=\"$color\"")

internal fun svgDataUri(svg: String): String =
    "data:image/svg+xml;base64," + Base64.getEncoder().encodeToString(svg.toByteArray(Charsets.UTF_8))

/** Rides every sync-state write as the source's display icon. */
val HEALTH_CONNECT_ICON_DATA_URI: String =
    svgDataUri(tintLucideSvg(HEART_PULSE_SVG, HEALTH_CONNECT_TINT))
