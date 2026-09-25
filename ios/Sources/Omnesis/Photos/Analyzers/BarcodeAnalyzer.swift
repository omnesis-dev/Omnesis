// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Vision)
import Vision

/// Barcode/QR detection via `VNDetectBarcodesRequest` — new-photos tier
/// only. The decoded payload text is folded into `content` AND
/// promoted to `metadata.tags`; the raw payload + symbology are kept in
/// `metadata.extra` for rendering only, per the serving rule.
public struct BarcodeAnalyzer: PhotoAnalyzer {
    public let identifier = "barcode"

    public init() {}

    public func isAvailable() async -> Bool {
        true
    }

    public func analyze(_ input: PhotoAnalysisInput) async -> PhotoAnalysisFragment? {
        guard let image = input.image else { return nil }
        let request = VNDetectBarcodesRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        let payloads = (request.results ?? []).compactMap(\.payloadStringValue)
        guard !payloads.isEmpty else { return nil }
        return PhotoAnalysisFragment(
            textLines: payloads,
            tags: payloads,
            extra: ["barcodePayloads": .array(payloads.map { JSONValue.string($0) })]
        )
    }
}
#endif
