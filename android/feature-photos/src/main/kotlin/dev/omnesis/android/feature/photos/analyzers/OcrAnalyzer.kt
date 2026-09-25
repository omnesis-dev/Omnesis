// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.analyzers

import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import dev.omnesis.android.feature.photos.PhotoAnalysisFragment
import dev.omnesis.android.feature.photos.PhotoAnalysisInput
import dev.omnesis.android.feature.photos.PhotoAnalyzer
import kotlinx.coroutines.tasks.await

/**
 * OCR via ML Kit's on-device Text Recognition (Latin script) — the baseline
 * tier that runs for EVERY photo (backfill and new alike). Bundled model
 * (statically linked, no download), always available; no capability gate.
 * Mirrors iOS's `OCRAnalyzer` (`VNRecognizeTextRequest`).
 */
class OcrAnalyzer : PhotoAnalyzer {
    override val identifier = "ocr"

    private val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    override suspend fun isAvailable(): Boolean = true

    override suspend fun analyze(input: PhotoAnalysisInput): PhotoAnalysisFragment? {
        val bitmap = input.bitmap ?: return null
        val text = recognizer.process(InputImage.fromBitmap(bitmap, 0)).await()
        val lines = text.textBlocks.flatMap { block -> block.lines.map { it.text } }.filter { it.isNotBlank() }
        if (lines.isEmpty()) return null
        return PhotoAnalysisFragment(textLines = lines)
    }
}
