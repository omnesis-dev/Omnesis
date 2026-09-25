// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation

/// Swift mirror of `@omnesis/types`' `DocumentInput` (TypeScript) — the
/// wire DTO a source pushes to the gateway's `POST /documents/with-cursor`
/// so a row of structured analytics can be paired with a searchable prose
/// document (see #450 / #640).
///
/// Field names match the TS interface verbatim so they serialize to the
/// exact camelCase keys the gateway's `documentInputShape` validator
/// expects. `id` / `ingestedAt` / `updatedAt` are gateway-assigned and
/// intentionally absent here.
public struct DocumentInput: Codable, Equatable, Sendable {
    /// Full provider id, e.g. `apple-health:local`.
    public let providerId: String

    /// Full source id, e.g. `apple-health:local`. Same form as the
    /// analytics `sourceId` so the gateway's `same-entity` edge can join
    /// the document to its bound row.
    public let sourceId: String

    /// Stable upstream identifier. For a workout/mindful summary this is
    /// the HealthKit sample UUID — the SAME id used as the bound row's
    /// primary key so `boundDocument { externalIdColumns: ["id"] }`
    /// resolves the 1:1 doc↔row edge.
    public let externalId: String

    /// Short human title ("Morning Run").
    public let title: String

    /// Rendered prose body the BM25 / vector index searches over.
    public let content: String

    /// Lowercase-hex SHA-256 of `content` (see `computeContentHash`).
    /// The gateway dedups + decides re-index on this.
    public let contentHash: String

    /// Optional SHA-256 of the underlying extracted-from-bytes payload
    /// (e.g. OCR'd photo text), independent of any rendering wrapper
    /// around `content`. Used only for idempotent re-ingest of the same
    /// source item, never for cross-source dedup — see
    /// `Document.extractedContentHash` (`packages/types/src/document.ts`).
    public let extractedContentHash: String?

    public let metadata: DocumentMetadata

    /// ISO-8601 source-side creation timestamp (the workout start).
    public let sourceCreatedAt: String

    /// ISO-8601 source-side last-updated timestamp.
    public let sourceUpdatedAt: String

    public init(
        providerId: String,
        sourceId: String,
        externalId: String,
        title: String,
        content: String,
        contentHash: String,
        extractedContentHash: String? = nil,
        metadata: DocumentMetadata,
        sourceCreatedAt: String,
        sourceUpdatedAt: String
    ) {
        self.providerId = providerId
        self.sourceId = sourceId
        self.externalId = externalId
        self.title = title
        self.content = content
        self.contentHash = contentHash
        self.extractedContentHash = extractedContentHash
        self.metadata = metadata
        self.sourceCreatedAt = sourceCreatedAt
        self.sourceUpdatedAt = sourceUpdatedAt
    }

    /// SHA-256 of the content string's UTF-8 bytes, lowercase hex, no
    /// prefix — replicates `computeContentHash` in
    /// `packages/core/src/utils.ts` so the gateway sees the same hash the
    /// TS collector would produce for identical content.
    public static func computeContentHash(_ content: String) -> String {
        let digest = SHA256.hash(data: Data(content.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

/// Mirror of the subset of `@omnesis/types`' `DocumentMetadata` that
/// Apple Health summary documents populate. Every field optional;
/// `nil` fields are omitted from the JSON (matches the TS `undefined`
/// behaviour), and the gateway's `metadata: z.record(...)` validator
/// tolerates the partial shape.
///
/// `people` is intentionally absent — Apple Health workouts have no
/// person mentions, and the existing `PersonMention` (in `SearchClient`)
/// is a read-side decode type with a different shape. If a future Health
/// document needs people, add an Encodable mention type then.
public struct DocumentMetadata: Codable, Equatable, Sendable {
    public let documentType: String?
    public let tags: [String]?
    public let sourceUrl: String?
    public let appUrl: String?
    /// The item is a casual, low-information one (no extracted text, no
    /// caption, no labels) — shared consumers (the background agent's
    /// wake heuristics) skip waking on it generically. See
    /// `DocumentMetadata.lowSignal` in `packages/types/src/document.ts`.
    public let lowSignal: Bool?
    /// Free-form extra fields. Stored as a JSON object.
    public let extra: [String: JSONValue]?

    /// Marks a document as a synthesized rolling summary over other raw
    /// data — e.g. a nightly sleep-stage rollup — rather than a single
    /// discrete event. `nil`/omitted for ordinary documents.
    public let rollingAggregate: Bool?

    public init(
        documentType: String? = nil,
        tags: [String]? = nil,
        sourceUrl: String? = nil,
        appUrl: String? = nil,
        lowSignal: Bool? = nil,
        extra: [String: JSONValue]? = nil,
        rollingAggregate: Bool? = nil
    ) {
        self.documentType = documentType
        self.tags = tags
        self.sourceUrl = sourceUrl
        self.lowSignal = lowSignal
        self.appUrl = appUrl
        self.extra = extra
        self.rollingAggregate = rollingAggregate
    }
}
