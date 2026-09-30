// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import kotlin.math.log10

/**
 * A 0–1 level for a recording meter from a peak amplitude (0–32767): its loudness in
 * decibels over the bottom [floorDb] of the range, so quiet speech still moves the meter
 * visibly while room tone barely does.
 */
fun audioLevel(peak: Int, floorDb: Float = 50f): Float {
    if (peak <= 0) return 0f
    val db = 20f * log10(peak.coerceAtMost(MAX_PEAK) / MAX_PEAK.toFloat())
    return ((db + floorDb) / floorDb).coerceIn(0f, 1f)
}

private const val MAX_PEAK = 32_767
