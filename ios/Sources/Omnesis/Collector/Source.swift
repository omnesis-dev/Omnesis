// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The source family before the first colon, mirroring the gateway's resolver.
/// A malformed leading colon keeps its full identity instead of becoming an empty family.
public func sourceTypeOf(_ sourceId: String) -> String {
    guard let separator = sourceId.range(of: ":", options: .literal),
          separator.lowerBound > sourceId.startIndex else { return sourceId }
    return String(sourceId[..<separator.lowerBound])
}

/// The opaque account after the first colon; subsequent colons belong to the account.
/// A bare family or malformed leading colon names no account.
public func sourceAccountOf(_ sourceId: String) -> String {
    guard let separator = sourceId.range(of: ":", options: .literal),
          separator.lowerBound > sourceId.startIndex else { return "" }
    return String(sourceId[separator.upperBound...])
}

/// Opaque cursor passed to / returned by each `Source.sync(cursor:)`.
/// Mirrors the gateway's `/sync-state/:sourceId` JSON shape.
public typealias SyncCursor = [String: JSONValue]

/// Gateway storage/cursor contract implemented by one native source.
public enum SourceMultiDeviceMode: String, Codable, Sendable {
    case exclusive
    case replicated
    case partitioned
}

/// Source-owned declaration aggregated by the native composition root.
public struct HostedSourceContract: Equatable, Sendable {
    public let sourceType: String
    public let multiDeviceMode: SourceMultiDeviceMode
    public let replicaVersionPolicy: String?

    public init(
        sourceType: String,
        multiDeviceMode: SourceMultiDeviceMode = .exclusive,
        replicaVersionPolicy: String? = nil
    ) {
        self.sourceType = sourceType
        self.multiDeviceMode = multiDeviceMode
        self.replicaVersionPolicy = replicaVersionPolicy
    }
}

/// The app's product version, as the bundle declares it.
///
/// The gateway's version ledger reads this to tell a phone running the
/// current release from one still on an older build — a normal state for an
/// app, whose store release trails the tag it was cut from. The About
/// section of Settings shows the same reading, so the number a device
/// reports and the number its owner can quote are one value.
public func omnesisAppVersion(bundle: Bundle = .main) -> String {
    AppBuild.productVersion(infoDictionary: bundle.infoDictionary)
}

/// Device capability payload shared by pairing and every WebSocket hello.
public struct PairingCapabilities: Codable, Equatable, Sendable {
    public let platform: String
    public let hostname: String?
    /// Product version of this app build. Optional on the wire: a gateway
    /// never rejects a hello for omitting it, and a build that predates the
    /// version ledger simply reports nothing.
    public let version: String?
    public let suggestedName: String?
    public let installId: String?
    /// App identity used for push-plan selection. Optional so older and
    /// non-phone collectors remain wire-compatible.
    public let pushAppId: String?
    public var previousDeviceId: String?
    public let hostableSourceTypes: [String]
    public let pushBasedSourceTypes: [String]
    public let multiDeviceModes: [String: String]
    public let replicaVersionPolicies: [String: String]
    public let syncLease: Bool

    public static func ios(
        hostname: String? = nil,
        suggestedName: String? = nil,
        installId: String? = nil,
        previousDeviceId: String? = nil,
        pushAppId: String? = Bundle.main.bundleIdentifier,
        version: String = omnesisAppVersion()
    )
        -> PairingCapabilities {
        let contracts = NativeHostedSourceRegistry.ios
        return PairingCapabilities(
            platform: "ios",
            hostname: hostname,
            version: version,
            suggestedName: suggestedName,
            installId: installId,
            pushAppId: pushAppId,
            previousDeviceId: previousDeviceId,
            hostableSourceTypes: contracts.map(\.sourceType),
            pushBasedSourceTypes: contracts.map(\.sourceType),
            multiDeviceModes: Dictionary(uniqueKeysWithValues: contracts.compactMap { contract in
                contract.multiDeviceMode == .exclusive
                    ? nil
                    : (contract.sourceType, contract.multiDeviceMode.rawValue)
            }),
            replicaVersionPolicies: Dictionary(uniqueKeysWithValues: contracts.compactMap { contract in
                contract.replicaVersionPolicy.map { (contract.sourceType, $0) }
            }),
            syncLease: contracts.contains { $0.multiDeviceMode == .replicated }
        )
    }

    public var jsonObject: [String: JSONValue] {
        var result: [String: JSONValue] = [
            "platform": .string(platform),
            "hostableSourceTypes": .array(hostableSourceTypes.map(JSONValue.string)),
            "pushBasedSourceTypes": .array(pushBasedSourceTypes.map(JSONValue.string)),
            "multiDeviceModes": .object(multiDeviceModes.mapValues(JSONValue.string)),
            "replicaVersionPolicies": .object(replicaVersionPolicies.mapValues(JSONValue.string)),
            "syncLease": .bool(syncLease),
        ]
        if let hostname { result["hostname"] = .string(hostname) }
        if let version { result["version"] = .string(version) }
        if let suggestedName { result["suggestedName"] = .string(suggestedName) }
        if let installId { result["installId"] = .string(installId) }
        if let pushAppId { result["pushAppId"] = .string(pushAppId) }
        if let previousDeviceId { result["previousDeviceId"] = .string(previousDeviceId) }
        return result
    }
}

/// The only central list: each entry's behavior is declared beside its source.
public enum NativeHostedSourceRegistry {
    public static let ios: [HostedSourceContract] = [
        appleHealthHostedSourceContract,
        activitySegmentsHostedSourceContract,
        photosHostedSourceContract,
        coreLocationVisitsHostedSourceContract,
    ]
}

/// A single page produced by a call to `Source.sync(cursor:)`.
public struct SyncResult: Equatable, Sendable {
    /// Rows to ingest into `tableName`. Typically one row per HealthKit
    /// sample, keyed by the sample UUID in a `id` column.
    public let records: [[String: JSONValue]]

    /// DuckDB table name the records live in. Same source can produce
    /// multiple tables across pages. `nil` for a documents-only source
    /// (one that never publishes analytics rows, e.g. Photos, #169) —
    /// there is no analytics table to name. When `nil`, `deletedIds` is
    /// interpreted as document external ids (see below) instead of
    /// analytics row keys.
    public let tableName: String?

    /// Dynamic schema for the table. Send on every page — the gateway's
    /// `analytics-db` creates the table on first sight and evolves it
    /// (ALTER TABLE ADD COLUMN) when new columns appear on later pages.
    public let schema: AnalyticsTableSchema?

    /// Cursor to persist after this page has been buffered. On resume,
    /// the next `sync(cursor:)` call receives this exact value.
    public let cursor: SyncCursor

    /// True if the source has more pages ready. Collector keeps calling
    /// `sync(cursor:)` until this is false.
    public let hasMore: Bool

    /// Primary-key values of records that were deleted upstream.
    ///
    /// When `tableName != nil`, these are analytics row keys the gateway
    /// removes on ingest. When `tableName == nil` (a documents-only
    /// source), these are instead document `externalId`s to delete via
    /// `POST /documents/delete` — see `Uploader.drain()`.
    public let deletedIds: [String]

    /// Searchable summary documents minted alongside `records` for the
    /// episodic, nameable tables (workouts / mindful). Each is bound 1:1
    /// to its analytics row via `externalId == row.id` + the table's
    /// `boundDocument` spec (#640). Empty for the tall sample tables.
    /// For a documents-only source (`tableName == nil`), these are the
    /// entirety of what the page produces.
    public let documents: [DocumentInput]
    /// Local-only identity for a source's pending page acknowledgment. Never
    /// serialized into an upload batch or sent to the gateway.
    public let acknowledgmentId: UUID?

    public init(
        records: [[String: JSONValue]],
        tableName: String?,
        schema: AnalyticsTableSchema? = nil,
        cursor: SyncCursor,
        hasMore: Bool,
        deletedIds: [String] = [],
        documents: [DocumentInput] = [],
        acknowledgmentId: UUID? = nil
    ) {
        self.records = records
        self.tableName = tableName
        self.schema = schema
        self.cursor = cursor
        self.hasMore = hasMore
        self.deletedIds = deletedIds
        self.documents = documents
        self.acknowledgmentId = acknowledgmentId
    }
}

/// A source the collector can drive.
///
/// Phase 2 has no real sources yet (see Phase 3 for AppleHealthSource).
/// The protocol exists so the collector core is testable in isolation:
/// a mock source emits canned `SyncResult` pages, the collector buffers
/// + uploads them, tests assert what landed in the gateway.
///
/// Sources must be `Sendable` because the collector calls `sync(cursor:)`
/// from its actor and may move the source across actor isolation domains.
public protocol OmnesisSource: Sendable {
    /// Full source id, e.g. `apple-health:ios-abc123`. Used as:
    ///   - suffix of the gateway `sourceId` column,
    ///   - key into `/sync-state/<id>` when persisting cursors,
    ///   - de-dup key to ensure only one sync is in flight per source.
    var id: String { get }

    /// Human name for status / logging ("Apple Health").
    var displayName: String { get }

    /// How multiple physical devices contribute to this logical source.
    /// Replicated sources claim the gateway's reconciliation lease before a
    /// drain; partitioned sources receive gateway-owned per-device streams.
    var multiDeviceMode: SourceMultiDeviceMode { get }

    /// Schemas this source will publish. Used for one-time introspection;
    /// the actual `schema` field on `SyncResult` is what the gateway
    /// accepts at ingest time.
    var analyticsSchemas: [AnalyticsTableSchema] { get }

    /// Fetch one page. Implementations should return `hasMore == false`
    /// as soon as they have no more data for the current cycle.
    func sync(cursor: SyncCursor?) async throws -> SyncResult

    /// Called only after a page's upload payload is durably buffered, before
    /// its cursor advances. Source-local delivery marks must not advance in
    /// `sync` itself: a buffer failure must leave that page replayable.
    func didBuffer(_ result: SyncResult) async throws
}

extension OmnesisSource {
    public func didBuffer(_: SyncResult) async throws {}

    public var multiDeviceMode: SourceMultiDeviceMode {
        .exclusive
    }
}

/// A single unit of work queued on the offline buffer and uploaded to
/// the gateway in one POST. Produced from a `SyncResult`.
public struct Batch: Codable, Equatable, Sendable {
    /// Monotonic-by-creation id used for filenames and FIFO order.
    /// Format: `YYYYMMDDHHMMSSmmm-<8-hex>`.
    public let id: String

    public let sourceId: String
    public let multiDeviceMode: SourceMultiDeviceMode
    /// `nil` for a documents-only source — see `SyncResult.tableName`.
    public let tableName: String?
    public let records: [[String: JSONValue]]
    public let schema: AnalyticsTableSchema?
    /// See `SyncResult.deletedIds` — analytics row keys when `tableName`
    /// is set, document external ids to delete when it's `nil`.
    public let deletedIds: [String]
    /// Summary documents carried alongside `records` so they survive
    /// offline buffering + retry. The uploader pushes them to
    /// `POST /documents` after the analytics records land (#640).
    public let documents: [DocumentInput]
    public let createdAt: Date

    public init(
        id: String,
        sourceId: String,
        multiDeviceMode: SourceMultiDeviceMode = .exclusive,
        tableName: String?,
        records: [[String: JSONValue]],
        schema: AnalyticsTableSchema?,
        deletedIds: [String],
        documents: [DocumentInput] = [],
        createdAt: Date
    ) {
        self.id = id
        self.sourceId = sourceId
        self.multiDeviceMode = multiDeviceMode
        self.tableName = tableName
        self.records = records
        self.schema = schema
        self.deletedIds = deletedIds
        self.documents = documents
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, sourceId, multiDeviceMode, tableName, records, schema, deletedIds, documents, createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sourceId = try c.decode(String.self, forKey: .sourceId)
        multiDeviceMode = try c.decodeIfPresent(SourceMultiDeviceMode.self, forKey: .multiDeviceMode) ?? .exclusive
        tableName = try c.decodeIfPresent(String.self, forKey: .tableName)
        records = try c.decode([[String: JSONValue]].self, forKey: .records)
        schema = try c.decodeIfPresent(AnalyticsTableSchema.self, forKey: .schema)
        deletedIds = try c.decode([String].self, forKey: .deletedIds)
        // Back-compat: batches written before #640 have no `documents` key.
        documents = try c.decodeIfPresent([DocumentInput].self, forKey: .documents) ?? []
        createdAt = try c.decode(Date.self, forKey: .createdAt)
    }

    /// Derive an id like `20260418T145023123-a1b2c3d4` that sorts
    /// lexicographically in the order batches were produced.
    public static func makeId(now: Date = Date()) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let components = calendar.dateComponents(
            [.year, .month, .day, .hour, .minute, .second, .nanosecond],
            from: now
        )
        let millis = (components.nanosecond ?? 0) / 1_000_000
        let stamp = String(
            format: "%04d%02d%02dT%02d%02d%02d%03d",
            components.year ?? 0, components.month ?? 0, components.day ?? 0,
            components.hour ?? 0, components.minute ?? 0, components.second ?? 0,
            millis
        )
        let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8).lowercased()
        return "\(stamp)-\(suffix)"
    }
}
