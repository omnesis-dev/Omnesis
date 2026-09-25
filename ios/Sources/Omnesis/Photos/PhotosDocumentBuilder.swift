// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Composes a `DocumentInput` from a photo asset's merged analyzer
/// fragment. The single place every acquired signal gets folded into
/// `content`/`title`/`tags` so it is actually served by search, the
/// agent, and Briefs — never left stranded in `metadata.extra` alone.
/// Operates on `PhotoAssetRef` (not `PHAsset` directly) so this logic is
/// unit-testable without PhotoKit.
public enum PhotosDocumentBuilder {
    /// `documentType` for a screenshot vs. a camera photo — the only
    /// queryable is-screenshot channel (`type:screenshot`).
    public static func documentType(for asset: PhotoAssetRef) -> String {
        asset.isScreenshot ? "screenshot" : "photo"
    }

    public static func build(
        asset: PhotoAssetRef,
        providerId: String,
        sourceId: String,
        fragment: PhotoAnalysisFragment
    )
        -> DocumentInput {
        let docType = documentType(for: asset)
        let title = composeTitle(documentType: docType, placeName: fragment.placeName, date: asset.creationDate)
        let content = composeContent(textLines: fragment.textLines, placeName: fragment.placeName, title: title)
        let tags = Array(Set(fragment.tags)).sorted()
        let extractedText = fragment.textLines.joined(separator: "\n")
        let extractedContentHash = extractedText.isEmpty
            ? nil
            : DocumentInput.computeContentHash(extractedText)
        // A casual photo with no extracted text, no caption, no labels,
        // and no place name — little for the agent to reason about on
        // its own, so it shouldn't wake the Cognition Steward (see the generic
        // `lowSignal` waker marker, packages/types/src/document.ts). A
        // place name alone (folded into title/content above) IS
        // substantive signal — a geotagged photo with no other analysis
        // is still worth waking on.
        let lowSignal = fragment.textLines.isEmpty && fragment.tags.isEmpty && fragment.placeName == nil

        let metadata = DocumentMetadata(
            documentType: docType,
            tags: tags.isEmpty ? nil : tags,
            lowSignal: lowSignal ? true : nil,
            extra: fragment.extra.isEmpty ? nil : fragment.extra
        )

        return DocumentInput(
            providerId: providerId,
            sourceId: sourceId,
            externalId: asset.externalId,
            title: title,
            content: content,
            contentHash: DocumentInput.computeContentHash(content),
            extractedContentHash: extractedContentHash,
            metadata: metadata,
            sourceCreatedAt: isoFormatter.string(from: asset.creationDate),
            sourceUpdatedAt: isoFormatter.string(from: asset.modificationDate)
        )
    }

    // MARK: - Internals

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM yyyy"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private static let isoFormatter = ISO8601DateFormatter()

    /// `"Photo · Paris · 3 Mar 2024"` (or `"Screenshot · …"`), place
    /// omitted when the photo has no geotag — never a bare filename or
    /// empty title, so even a text-less photo is retrievable by
    /// place/date.
    static func composeTitle(documentType: String, placeName: String?, date: Date) -> String {
        let noun = documentType == "screenshot" ? "Screenshot" : "Photo"
        let dateString = dateFormatter.string(from: date)
        if let placeName {
            return "\(noun) · \(placeName) · \(dateString)"
        }
        return "\(noun) · \(dateString)"
    }

    /// Folds OCR text / caption / barcode payloads (already merged into
    /// `textLines`) plus the place name into the searchable prose body.
    /// Never empty — a text-less, place-less photo still gets its title
    /// repeated as the body so `content` is never blank (a document
    /// that "chunks to nothing" is invisible to the indexer).
    static func composeContent(textLines: [String], placeName: String?, title: String) -> String {
        var lines = textLines
        if let placeName {
            lines.append("Place: \(placeName)")
        }
        return lines.isEmpty ? title : lines.joined(separator: "\n")
    }
}
