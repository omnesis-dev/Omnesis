// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Swift mirror of `@omnesis/core`'s `AnalyticsTableSchema` (TypeScript).
///
/// The iOS collector passes a schema with each `/analytics/ingest` call
/// so the gateway can create / evolve DuckDB tables without knowing the
/// HealthKit domain. Matches the shape documented in the Apple Health
/// integration doc §7.3 and the gateway's `analytics-db.ts`.
public struct AnalyticsTableSchema: Codable, Equatable, Sendable {
    public let tableName: String
    public let displayName: String
    public let description: String
    public let columns: [ColumnDefinition]
    public let primaryKey: [String]
    public let exampleQueries: [String]?

    /// The real-world, semantic-time column for a row in this table — the
    /// single instant a record citation is placed at on a timeline.
    /// Set it to the name of a DATE/TIMESTAMP/TIMESTAMPTZ column on this
    /// table (every Apple Health table has `start_time`), or to `nil` for a
    /// genuinely timeless table. Serializes to the camelCase
    /// `semanticTimeColumn` key the gateway reads.
    public let semanticTimeColumn: String?

    /// How to title a single row and which columns to surface as its key
    /// fields when it is cited as a record. A current build always
    /// declares this so health rows are citation-eligible; the gateway
    /// tolerates its absence only for older clients.
    public let record: RecordDisplaySpec?

    /// Declares that each row of this table co-describes a searchable
    /// document whose `externalId` is built from `externalIdColumns`.
    /// The gateway persists this in its analytics catalog and synthesizes
    /// the `same-entity` doc↔row edge at walk time.
    ///
    /// `nil` for tables with no bound document (the tall sample tables).
    /// When set it serializes to the camelCase `boundDocument` key the
    /// gateway's catalog codec reads — matching the TS
    /// `AnalyticsTableSchema.boundDocument` exactly.
    public let boundDocument: BoundDocumentSpec?

    /// Explicit deterministic projection into the shared temporal substrate.
    /// A semantic-time citation anchor alone never opts a table in.
    public let temporalProjection: AnalyticsTemporalProjectionSpec?

    public init(
        tableName: String,
        displayName: String,
        description: String,
        columns: [ColumnDefinition],
        primaryKey: [String],
        exampleQueries: [String]? = nil,
        semanticTimeColumn: String? = nil,
        record: RecordDisplaySpec? = nil,
        boundDocument: BoundDocumentSpec? = nil,
        temporalProjection: AnalyticsTemporalProjectionSpec? = nil
    ) {
        self.tableName = tableName
        self.displayName = displayName
        self.description = description
        self.columns = columns
        self.primaryKey = primaryKey
        self.exampleQueries = exampleQueries
        self.semanticTimeColumn = semanticTimeColumn
        self.record = record
        self.boundDocument = boundDocument
        self.temporalProjection = temporalProjection
    }
}

/// What a temporal fact *is*. A kind describes the nature of a fact, never its
/// origin — no value here names a source, a table, or a producer.
public enum TemporalProjectionKind: String, Codable, Sendable {
    case visit
    case appointment
    case event
    case deadline
    case reminder
    case expiry
    case episode
}

public enum TemporalProjectionModality: String, Codable, Sendable {
    case scheduled
    case observed
    case asserted
    case inferred
}

public enum TemporalProjectionStatus: String, Codable, Sendable {
    case active
    case completed
    case cancelled
}

/// A projection field that is either the same for every row, or read from a
/// column and mapped onto the vocabulary.
///
/// On the wire the constant form is a bare vocabulary string and the mapped
/// form is `{ from, map, default }`. Provider data rarely lines up with a
/// closed vocabulary one-to-one, and `map` misses (and null column values)
/// fall back to `default`, so a column growing a new value never silently
/// drops the row's fact.
public enum MappedProjectionField<Value>: Equatable, Sendable
    where Value: RawRepresentable & Codable & Equatable & Sendable, Value.RawValue == String {
    /// The same vocabulary value for every row of the table.
    case constant(Value)
    /// Read column `from`, translate through `map`, fall back to `default`.
    case mapped(from: String, map: [String: Value], default: Value)
}

extension MappedProjectionField: Codable {
    private enum CodingKeys: String, CodingKey {
        case from
        case map
        case `default`
    }

    public init(from decoder: Decoder) throws {
        let single = try decoder.singleValueContainer()
        if let raw = try? single.decode(String.self) {
            guard let value = Value(rawValue: raw) else {
                throw DecodingError.dataCorruptedError(
                    in: single,
                    debugDescription: "'\(raw)' is not a \(Value.self)"
                )
            }
            self = .constant(value)
            return
        }
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self = try .mapped(
            from: container.decode(String.self, forKey: .from),
            map: container.decode([String: Value].self, forKey: .map),
            default: container.decode(Value.self, forKey: .default)
        )
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .constant(let value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case .mapped(let from, let map, let fallback):
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(from, forKey: .from)
            try container.encode(map, forKey: .map)
            try container.encode(fallback, forKey: .default)
        }
    }
}

/// Swift wire mirror of `AnalyticsTemporalProjectionSpec` in
/// `packages/source-sdk/src/structured-source.ts` — the deterministic temporal
/// fact one analytics row projects into the shared temporal substrate. Every
/// reference is a column name on the projecting table.
public struct AnalyticsTemporalProjectionSpec: Codable, Equatable, Sendable {
    /// Stable fact slot within one row.
    public let slot: String
    /// Where the fact begins. Always the `$semanticTime` sentinel, which
    /// resolves to the table's declared `semanticTimeColumn` — that is what
    /// stops a table declaring two competing answers to when a row begins.
    public let start: String
    /// Optional end column; the gateway normalizes it to an exclusive bound.
    public let end: String?
    /// Column carrying the fact's human label.
    public let label: String?
    public let kind: MappedProjectionField<TemporalProjectionKind>
    public let modality: MappedProjectionField<TemporalProjectionModality>
    /// Defaults gateway-side to `active` when the row asserts no lifecycle state.
    public let status: MappedProjectionField<TemporalProjectionStatus>?
    /// Boolean column distinguishing all-day/floating dates from instants.
    public let allDay: String?
    /// Optional boolean gate: rows whose value is not exactly true project nothing.
    public let eligibility: String?
    /// Optional IANA/floating-time basis carried by the row.
    public let timeZone: String?
    /// Optional source revision clock.
    public let sourceUpdatedAt: String?
    /// Stable source correlation keys such as an RFC 5545 iCalUID.
    public let correlationKeys: [String]?

    public init(
        slot: String,
        start: String = "$semanticTime",
        end: String? = nil,
        label: String? = nil,
        kind: MappedProjectionField<TemporalProjectionKind>,
        modality: MappedProjectionField<TemporalProjectionModality>,
        status: MappedProjectionField<TemporalProjectionStatus>? = nil,
        allDay: String? = nil,
        eligibility: String? = nil,
        timeZone: String? = nil,
        sourceUpdatedAt: String? = nil,
        correlationKeys: [String]? = nil
    ) {
        self.slot = slot
        self.start = start
        self.end = end
        self.label = label
        self.kind = kind
        self.modality = modality
        self.status = status
        self.allDay = allDay
        self.eligibility = eligibility
        self.timeZone = timeZone
        self.sourceUpdatedAt = sourceUpdatedAt
        self.correlationKeys = correlationKeys
    }
}

/// Swift mirror of `RecordDisplaySpec` in
/// `packages/source-sdk/src/structured-source.ts`. Tells the gateway
/// how to render one row of this table when it is cited as a record: which
/// columns compose the title (optionally via a `{column}` template) and which
/// to surface as key fields. Both column lists must be non-empty and name
/// columns declared on the table; every `{column}` in `titleTemplate` must
/// appear in `titleColumns`.
public struct RecordDisplaySpec: Codable, Equatable, Sendable {
    public let titleColumns: [String]
    public let titleTemplate: String?
    public let keyColumns: [String]

    public init(titleColumns: [String], titleTemplate: String? = nil, keyColumns: [String]) {
        self.titleColumns = titleColumns
        self.titleTemplate = titleTemplate
        self.keyColumns = keyColumns
    }
}

/// Swift mirror of `BoundDocumentSpec` in
/// `packages/source-sdk/src/structured-source.ts`. Only `externalIdColumns`
/// is required; the rest are optional and default gateway-side
/// (`externalIdSeparator` defaults to `":"`).
public struct BoundDocumentSpec: Codable, Equatable, Sendable {
    /// PK columns whose values compose the bound document's `externalId`.
    public let externalIdColumns: [String]
    /// Stripped from `externalId` before matching, if set.
    public let externalIdPrefix: String?
    /// Joiner when `externalIdColumns` has more than one column.
    public let externalIdSeparator: String?
    /// PK columns filled from the document's source identity, if any.
    public let sourceKeyColumns: [String]?

    public init(
        externalIdColumns: [String],
        externalIdPrefix: String? = nil,
        externalIdSeparator: String? = nil,
        sourceKeyColumns: [String]? = nil
    ) {
        self.externalIdColumns = externalIdColumns
        self.externalIdPrefix = externalIdPrefix
        self.externalIdSeparator = externalIdSeparator
        self.sourceKeyColumns = sourceKeyColumns
    }
}

public struct ColumnDefinition: Codable, Equatable, Sendable {
    public let name: String
    public let type: ColumnType
    public let description: String
    public let nullable: Bool?
    /// Exhaustive provider-owned values for a closed VARCHAR domain.
    /// Never populate this from rows in the user's corpus.
    public let allowedValues: [String]?
    /// Known exact values for an open or extensible VARCHAR vocabulary.
    /// Non-exhaustive and never populated from rows in the user's corpus.
    public let canonicalValues: [String]?
    /// Source-owned human phrases keyed by exact categorical wire value.
    public let valueAliases: [String: [String]]?
    /// `series` marks the logical series selector in a tall table.
    public let categoricalRole: String?

    public init(
        name: String,
        type: ColumnType,
        description: String,
        nullable: Bool? = nil,
        allowedValues: [String]? = nil,
        canonicalValues: [String]? = nil,
        valueAliases: [String: [String]]? = nil,
        categoricalRole: String? = nil
    ) {
        self.name = name
        self.type = type
        self.description = description
        self.nullable = nullable
        self.allowedValues = allowedValues
        self.canonicalValues = canonicalValues
        self.valueAliases = valueAliases
        self.categoricalRole = categoricalRole
    }
}

/// DuckDB column types supported by the analytics-db. Mirrors `ColumnType`
/// in `packages/core/src/structured-source.ts`.
public enum ColumnType: String, Codable, Sendable {
    case varchar = "VARCHAR"
    case integer = "INTEGER"
    case bigint = "BIGINT"
    case double = "DOUBLE"
    case float = "FLOAT"
    case boolean = "BOOLEAN"
    case date = "DATE"
    case timestamp = "TIMESTAMP"
    case timestamptz = "TIMESTAMPTZ"
    case interval = "INTERVAL"
    case json = "JSON"
    case varcharArray = "VARCHAR[]"
}
