// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Vision)
import Vision

/// Scene/object labels via `VNClassifyImageRequest` — new-photos tier
/// only (the issue scopes rich analysis to new photos; the historical
/// backfill is OCR + place + metadata only). Folded into `content` AND
/// promoted to `metadata.tags` by `PhotosDocumentBuilder`, per the
/// serving rule (a label reachable only via `extra` is never found by
/// search).
public struct SceneLabelAnalyzer: PhotoAnalyzer {
    public let identifier = "scene-labels"

    /// Only labels at or above this confidence are kept — Vision's
    /// classifier returns hundreds of candidates per image, most far
    /// too weak to be a meaningful searchable tag.
    private let confidenceThreshold: Float
    /// Cap on how many labels fold into tags/content per photo.
    private let maxLabels: Int

    public init(confidenceThreshold: Float = 0.3, maxLabels: Int = 5) {
        self.confidenceThreshold = confidenceThreshold
        self.maxLabels = maxLabels
    }

    public func isAvailable() async -> Bool {
        true
    }

    public func analyze(_ input: PhotoAnalysisInput) async -> PhotoAnalysisFragment? {
        guard let image = input.image else { return nil }
        let request = VNClassifyImageRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        let labels = (request.results ?? [])
            .filter { $0.confidence >= confidenceThreshold }
            .sorted { $0.confidence > $1.confidence }
            .prefix(maxLabels)
        guard !labels.isEmpty else { return nil }

        var extra: [String: JSONValue] = [:]
        for label in labels {
            extra[label.identifier] = .double(Double(label.confidence))
        }
        return PhotoAnalysisFragment(
            tags: labels.map(\.identifier),
            extra: ["sceneLabelConfidence": .object(extra)]
        )
    }
}
#endif
