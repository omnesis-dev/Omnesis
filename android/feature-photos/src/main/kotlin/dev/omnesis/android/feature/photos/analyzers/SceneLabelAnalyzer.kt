// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.analyzers

import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions
import dev.omnesis.android.feature.photos.PhotoAnalysisFragment
import dev.omnesis.android.feature.photos.PhotoAnalysisInput
import dev.omnesis.android.feature.photos.PhotoAnalyzer
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Scene/object labels via ML Kit's Image Labeling — new-photos tier only
 * (the backfill is OCR + place only). Folded into content AND promoted to
 * `metadata.tags` by `PhotosDocumentBuilder`, per the serving rule. Whole-
 * image classification, not localized detection — the direct parity match
 * to iOS's `SceneLabelAnalyzer` (`VNClassifyImageRequest`, also
 * whole-image-only); ML Kit's separate Object Detection & Tracking API is
 * built for localized bounding-box detection across video frames and would
 * over-shoot this need.
 */
class SceneLabelAnalyzer(
    private val confidenceThreshold: Float = 0.3f,
    private val maxLabels: Int = 5,
) : PhotoAnalyzer {
    override val identifier = "scene-labels"

    private val labeler = ImageLabeling.getClient(
        ImageLabelerOptions.Builder().setConfidenceThreshold(confidenceThreshold).build(),
    )

    override suspend fun isAvailable(): Boolean = true

    override suspend fun analyze(input: PhotoAnalysisInput): PhotoAnalysisFragment? {
        val bitmap = input.bitmap ?: return null
        val labels = labeler.process(InputImage.fromBitmap(bitmap, 0)).await()
            .sortedByDescending { it.confidence }
            .take(maxLabels)
        if (labels.isEmpty()) return null

        val confidences = labels.associate { it.text to JsonPrimitive(it.confidence.toDouble()) }
        return PhotoAnalysisFragment(
            tags = labels.map { it.text },
            extra = mapOf("sceneLabelConfidence" to JsonObject(confidences)),
        )
    }
}
