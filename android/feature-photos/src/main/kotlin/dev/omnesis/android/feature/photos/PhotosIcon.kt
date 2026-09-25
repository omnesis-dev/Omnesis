// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import java.util.Base64

/**
 * The photos source's glyph — a Lucide `image` SVG (ISC-licensed) tinted to
 * the same system-blue as iOS's `PhotosIcon.swift`, embedded as a base64
 * data URI so the portal's strict CSP (`img-src 'self' data: blob:`) lets it
 * through. Not Apple's or any first-party Photos app icon — see
 * `TRADEMARKS.md`.
 *
 * Must produce the SAME rendered SVG bytes as
 * `ios/Sources/Omnesis/Photos/PhotosIcon.swift` so the portal shows one
 * stable icon for the source no matter which platform registered it.
 */

private const val IMAGE_SVG =
    """<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>"""

/** iOS system blue — matches `PhotosIcon.swift`'s tint exactly. */
private const val PHOTOS_TINT = "#0A84FF"

internal fun tintLucideSvg(svg: String, color: String): String =
    svg.replace("stroke=\"currentColor\"", "stroke=\"$color\"")

internal fun svgDataUri(svg: String): String =
    "data:image/svg+xml;base64," + Base64.getEncoder().encodeToString(svg.toByteArray(Charsets.UTF_8))

/** Rides every sync-state write and source registration as the source's display icon. */
val PHOTOS_ICON_DATA_URI: String = svgDataUri(tintLucideSvg(IMAGE_SVG, PHOTOS_TINT))
