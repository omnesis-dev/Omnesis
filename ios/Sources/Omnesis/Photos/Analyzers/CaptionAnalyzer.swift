// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Vision)
import Vision
#endif
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Abstraction over the on-device caption model so the caption pipeline
/// is testable without Apple-Intelligence hardware: tests inject a mock
/// that succeeds, throws, or reports itself unavailable, and assert the
/// analyzer's fallback behavior without invoking the real model.
public protocol CaptionLanguageModel: Sendable {
    /// Whether the model can run a captioning prompt right now (hardware
    /// capability, OS version, model download state).
    func isAvailable() async -> Bool

    /// Write a one-sentence caption from Vision scene/object labels.
    func caption(fromLabels labels: [String]) async throws -> String
}

/// The production model: Apple's on-device Foundation Models framework,
/// gated on `SystemLanguageModel` availability (`iOS 26.0+` and
/// Apple-Intelligence-capable hardware). Entirely on-device, no network.
///
/// Each call runs in a **fresh** `LanguageModelSession`. A session is
/// stateful — every prompt and response is appended to its transcript,
/// and the whole transcript counts against the on-device model's fixed
/// context window — so a session shared across many unrelated photos
/// eventually overflows (`exceededContextWindowSize`) and every caption
/// after that fails. Photos are independent inputs; nothing is gained by
/// carrying one photo's transcript into the next.
public struct SystemCaptionLanguageModel: CaptionLanguageModel {
    public init() {}

    public func isAvailable() async -> Bool {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability { return true }
        }
        #endif
        return false
    }

    public func caption(fromLabels labels: [String]) async throws -> String {
        #if canImport(FoundationModels)
        guard #available(iOS 26.0, macOS 26.0, *) else { throw CaptionModelError.unavailable }
        let instructions = "Write one short, plain-English sentence describing a photo, given a list "
            + "of detected scene/object labels. Do not mention the labels themselves as a list; "
            + "describe the scene naturally."
        let session = LanguageModelSession(instructions: instructions)
        let response = try await session.respond(
            to: "Detected labels: \(labels.joined(separator: ", "))"
        )
        return response.content
        #else
        throw CaptionModelError.unavailable
        #endif
    }
}

/// Thrown when captioning is invoked on a platform without the on-device
/// model (the `isAvailable()` gate normally prevents this).
public enum CaptionModelError: Error, Sendable {
    case unavailable
}

/// Synthesizes a one-sentence AI caption for a new photo — new-photos
/// tier only. Apple's on-device Foundation Models framework has no
/// direct image→text captioning API, so this composes one: run Vision
/// scene classification for labels, then prompt the on-device language
/// model to write a short natural-language caption from them. When the
/// model is unavailable or generation fails, the fragment is absent —
/// never a placeholder — and the photo keeps the other analyzers'
/// Vision-only signals.
///
/// Runs its own `VNClassifyImageRequest` rather than depending on
/// `SceneLabelAnalyzer`'s output, so each analyzer stays independently
/// testable per the `PhotoAnalyzer` contract (a photo's classification
/// runs twice on capable hardware for new photos — an acceptable cost
/// given it's Vision-fast and scoped to the new-photo tier only, not
/// the historical backfill).
public struct CaptionAnalyzer: PhotoAnalyzer {
    public let identifier = "caption"

    private let model: any CaptionLanguageModel

    static let log = AppLog.make(category: "photos.caption")

    public init(model: any CaptionLanguageModel = SystemCaptionLanguageModel()) {
        self.model = model
    }

    public func isAvailable() async -> Bool {
        await model.isAvailable()
    }

    public func analyze(_ input: PhotoAnalysisInput) async -> PhotoAnalysisFragment? {
        #if canImport(Vision)
        guard let image = input.image else { return nil }
        let labels = Self.classify(image)
        return await Self.captionFragment(labels: labels, model: model)
        #else
        return nil
        #endif
    }

    /// The model-facing half of `analyze`, split from Vision
    /// classification so tests can drive it with an injected model and
    /// no `PHAsset`. Returns `nil` when there are no labels to describe,
    /// the model is unavailable, or generation fails.
    static func captionFragment(
        labels: [String],
        model: any CaptionLanguageModel
    ) async
        -> PhotoAnalysisFragment? {
        guard !labels.isEmpty else { return nil }
        guard await model.isAvailable() else { return nil }
        do {
            let caption = try await model.caption(fromLabels: labels)
            // Prefixed so it reads distinctly from OCR's raw text lines once
            // merged into one content body — an on-device model's inference
            // (which can hedge or be wrong) shouldn't be indistinguishable
            // from text literally read off the photo. Mirrors the "Place: "
            // convention `PhotosDocumentBuilder.composeContent` already uses
            // for the reverse-geocoded place name, another non-OCR signal.
            return PhotoAnalysisFragment(textLines: ["LLM caption: \(caption)"])
        } catch {
            // Category token only — never the labels, prompt, or model
            // output — so caption loss is diagnosable from Console.app
            // without logging photo-derived content.
            log.warning("Caption generation failed: \(failureCategory(for: error), privacy: .public)")
            return nil
        }
    }

    /// A short, privacy-safe token naming why generation failed — safe
    /// to log publicly (a fixed vocabulary plus error type names; never
    /// photo-derived content).
    static func failureCategory(for error: Error) -> String {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *),
           let generationError = error as? LanguageModelSession.GenerationError {
            switch generationError {
            case .exceededContextWindowSize: return "context-window-exceeded"
            case .guardrailViolation: return "guardrail-violation"
            case .unsupportedLanguageOrLocale: return "unsupported-language"
            case .assetsUnavailable: return "assets-unavailable"
            case .decodingFailure: return "decoding-failure"
            default: return "generation-error"
            }
        }
        #endif
        if error is CaptionModelError { return "model-unavailable" }
        return String(describing: type(of: error))
    }

    #if canImport(Vision)
    private static func classify(_ image: CGImage) -> [String] {
        let request = VNClassifyImageRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        guard (try? handler.perform([request])) != nil else { return [] }
        return (request.results ?? [])
            .filter { $0.confidence >= 0.3 }
            .sorted { $0.confidence > $1.confidence }
            .prefix(5)
            .map(\.identifier)
    }
    #endif
}
