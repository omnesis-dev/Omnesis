// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos.analyzers

import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import dev.omnesis.android.feature.photos.PhotoAnalysisFragment
import dev.omnesis.android.feature.photos.PhotoAnalysisInput
import dev.omnesis.android.feature.photos.PhotoAnalyzer
import kotlinx.coroutines.tasks.await
import kotlinx.serialization.json.JsonPrimitive

/**
 * Barcode/QR decoding via ML Kit's Barcode Scanning (already a dependency
 * elsewhere in the app, for QR device-pairing) — new-photos tier only. The
 * decoded payload text is folded into content AND promoted to
 * `metadata.tags`; the raw payload + symbology are kept in `metadata.extra`
 * for rendering only, per the serving rule. Mirrors iOS's `BarcodeAnalyzer`
 * (`VNDetectBarcodesRequest`).
 */
class BarcodeAnalyzer : PhotoAnalyzer {
    override val identifier = "barcode"

    private val scanner = BarcodeScanning.getClient()

    override suspend fun isAvailable(): Boolean = true

    override suspend fun analyze(input: PhotoAnalysisInput): PhotoAnalysisFragment? {
        val bitmap = input.bitmap ?: return null
        val barcodes = scanner.process(InputImage.fromBitmap(bitmap, 0)).await()
        val payloads = barcodes.mapNotNull { it.rawValue }.filter { it.isNotBlank() }
        if (payloads.isEmpty()) return null

        return PhotoAnalysisFragment(
            textLines = payloads,
            tags = payloads,
            extra = mapOf(
                "barcodeFormats" to JsonPrimitive(
                    barcodes.mapNotNull { it.rawValue?.let { _ -> it.format.toString() } }.joinToString(","),
                ),
            ),
        )
    }
}
