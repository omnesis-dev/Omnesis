// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Photos)
import Photos

/// Input to a `PhotoAnalyzer`. `image` is `nil` for analyzers that only
/// need asset metadata (e.g. `PlaceAnalyzer`, which reads `asset.location`)
/// — decoding pixels is the caller's responsibility so a metadata-only
/// analyzer never pays that cost.
public struct PhotoAnalysisInput: Sendable {
    public let asset: PHAsset
    public let image: CGImage?

    public init(asset: PHAsset, image: CGImage? = nil) {
        self.asset = asset
        self.image = image
    }
}

/// One analyzer's contribution to a photo's document. Every field is
/// additive — `PhotoAnalysisFragment.merge` folds every analyzer's
/// fragment into one before `PhotosDocumentBuilder` composes the final
/// `DocumentInput`.
public struct PhotoAnalysisFragment: Sendable, Equatable {
    /// OCR'd text, or an AI-generated caption sentence — anything meant
    /// to read as prose in the document body.
    public var textLines: [String] = []
    /// Scene/object/barcode labels — folded into `content` AND promoted
    /// to `metadata.tags` (the only enumerable/filterable metadata
    /// channel), per the serving rule.
    public var tags: [String] = []
    /// Reverse-geocoded place name (locality / POI / admin area). Folded
    /// into `title` for text-less photos, appended to `content`
    /// otherwise — never left in `extra` alone (a bare coordinate is a
    /// value no user will type).
    public var placeName: String?
    /// Rendering-only structured data (raw lat/long, label confidences,
    /// raw barcode payload) — never the serving path; folded into
    /// `metadata.extra` as-is.
    public var extra: [String: JSONValue] = [:]

    public init(
        textLines: [String] = [],
        tags: [String] = [],
        placeName: String? = nil,
        extra: [String: JSONValue] = [:]
    ) {
        self.textLines = textLines
        self.tags = tags
        self.placeName = placeName
        self.extra = extra
    }

    /// Fold a list of per-analyzer fragments into one. Later fragments'
    /// `placeName` wins on conflict (in practice only `PlaceAnalyzer`
    /// ever sets it); everything else concatenates.
    public static func merge(_ fragments: [PhotoAnalysisFragment]) -> PhotoAnalysisFragment {
        var result = PhotoAnalysisFragment()
        for fragment in fragments {
            result.textLines.append(contentsOf: fragment.textLines)
            result.tags.append(contentsOf: fragment.tags)
            if let placeName = fragment.placeName {
                result.placeName = placeName
            }
            for (key, value) in fragment.extra {
                result.extra[key] = value
            }
        }
        return result
    }
}

/// One independently-gated on-device analysis signal. Each analyzer
/// declares its own availability (device capability, OS version) and
/// produces a typed fragment merged into the document — so OCR, place
/// resolution, labeling, captioning, and barcode detection are each
/// unit-testable and independently absent-when-unavailable, per the
/// issue's "every rich signal is best-effort and independently gated"
/// constraint (#169).
public protocol PhotoAnalyzer: Sendable {
    var identifier: String { get }

    /// Whether this analyzer can run right now (device capability, OS
    /// version, model download state). Checked once per sync page — an
    /// analyzer that becomes unavailable mid-run should still return
    /// gracefully from `analyze`, not crash.
    func isAvailable() async -> Bool

    /// Produce this analyzer's fragment for one photo, or `nil` if it
    /// found nothing (a plain photo with no barcode, no text, etc.).
    func analyze(_ input: PhotoAnalysisInput) async -> PhotoAnalysisFragment?
}
#endif
