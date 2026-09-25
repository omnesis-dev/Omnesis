// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.graphics.Bitmap
import kotlinx.serialization.json.JsonElement

/**
 * Input to a [PhotoAnalyzer]. [bitmap] is `null` for analyzers that only
 * need asset metadata (e.g. [dev.omnesis.android.feature.photos.analyzers.PlaceAnalyzer],
 * which reads EXIF GPS tags via the asset's [PhotoAssetRef.uri]) — decoding
 * pixels is the caller's responsibility so a metadata-only analyzer never
 * pays that cost.
 */
data class PhotoAnalysisInput(
    val asset: PhotoAssetRef,
    val bitmap: Bitmap? = null,
)

/**
 * One analyzer's contribution to a photo's document. Every field is
 * additive — [merge] folds every analyzer's fragment into one before
 * [PhotosDocumentBuilder] composes the final `DocumentInputDto`. Mirrors
 * iOS's `PhotoAnalysisFragment` exactly
 * (`ios/Sources/Omnesis/Photos/PhotoAnalyzer.swift`).
 */
data class PhotoAnalysisFragment(
    /** OCR'd text or other detected text — prose for the document body. */
    val textLines: List<String> = emptyList(),
    /** Scene/object/barcode labels — folded into content AND promoted to `metadata.tags`. */
    val tags: List<String> = emptyList(),
    /** Reverse-geocoded place name. Folded into title/content — never left in `extra` alone. */
    val placeName: String? = null,
    /** Rendering-only structured data (raw lat/long, label confidences, raw barcode payload). */
    val extra: Map<String, JsonElement> = emptyMap(),
) {
    companion object {
        /**
         * Fold a list of per-analyzer fragments into one. Later fragments'
         * [placeName] wins on conflict (in practice only the place analyzer
         * ever sets it); everything else concatenates/unions.
         */
        fun merge(fragments: List<PhotoAnalysisFragment>): PhotoAnalysisFragment {
            val textLines = mutableListOf<String>()
            val tags = mutableListOf<String>()
            var placeName: String? = null
            val extra = mutableMapOf<String, JsonElement>()
            for (fragment in fragments) {
                textLines += fragment.textLines
                tags += fragment.tags
                fragment.placeName?.let { placeName = it }
                extra += fragment.extra
            }
            return PhotoAnalysisFragment(textLines, tags, placeName, extra)
        }
    }
}

/**
 * One independently-gated on-device analysis signal. Each analyzer
 * declares its own availability (device capability, OS version, model
 * download state) and produces a typed fragment merged into the document —
 * so OCR, place resolution, labeling, and barcode detection are
 * each independently absent-when-unavailable. Mirrors iOS's `PhotoAnalyzer`
 * protocol.
 */
interface PhotoAnalyzer {
    val identifier: String

    /** Whether this analyzer can run right now. Checked once per sync page. */
    suspend fun isAvailable(): Boolean

    /** Produce this analyzer's fragment for one photo, or null if it found nothing. */
    suspend fun analyze(input: PhotoAnalysisInput): PhotoAnalysisFragment?
}
