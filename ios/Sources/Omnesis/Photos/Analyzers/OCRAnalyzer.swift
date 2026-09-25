// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Vision)
import Vision

/// Extracts on-screen text via `VNRecognizeTextRequest` — the baseline
/// tier that runs for EVERY photo (backfill and new alike), per the
/// issue's "OCR every image" constraint. Always available on-device;
/// no model download, no capability gate.
public struct OCRAnalyzer: PhotoAnalyzer {
    public let identifier = "ocr"

    public init() {}

    public func isAvailable() async -> Bool {
        true
    }

    public func analyze(_ input: PhotoAnalysisInput) async -> PhotoAnalysisFragment? {
        guard let image = input.image else { return nil }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        guard !lines.isEmpty else { return nil }
        return PhotoAnalysisFragment(textLines: lines)
    }
}
#endif
