// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Abstract HTTP performer — the seam we inject a mock at in tests.
public protocol URLSessionLike: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: URLSessionLike {}

/// Thin wrapper around `URLSession` that speaks the Omnesis gateway's
/// existing HTTP contract used by the desktop collector.
///
/// Endpoints used:
///   - GET  `/health`                            health probe (no auth, no body)
///   - POST `/analytics/ingest`                  ingest structured records
///   - POST `/documents`                         ingest summary documents
///   - POST `/documents/delete`                  delete documents by natural key
///   - POST `/documents/reconcile`                whole-library snapshot deletion
///   - GET  `/sync-state/<sourceId>`             fetch a source's cursor
///   - POST `/sync-state/<sourceId>`             save a source's cursor
///   - POST `/sync-state/<sourceId>/lease`       claim replica deletion authority
public final class GatewayClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSessionLike
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        let enc = JSONEncoder()
        enc.outputFormatting = []
        self.encoder = enc
        self.decoder = JSONDecoder()
    }

    public enum Error: Swift.Error, Equatable {
        case unauthorized
        case forbidden
        /// Local guard only, never from the wire: the caller tried to mutate
        /// a gateway-internal source (no sync, no actions — a programming
        /// error, since those buttons are hidden). The gateway would refuse
        /// the round-trip with 409 `INTERNAL_SOURCE`.
        case internalSource
        case notFound
        case serverError(status: Int, body: String)
        case invalidResponse
        case invalidURL
        case decoding(String)

        /// The gateway's machine-readable error code (`LAST_MEMBER`,
        /// `DEVICE_STILL_HOSTS_SOURCES`, …) when this is a `serverError`
        /// whose body is the gateway's error envelope; nil for every other
        /// case and for a body that is not the envelope.
        public var gatewayCode: String? {
            guard case .serverError(_, let body) = self else { return nil }
            return GatewayErrorEnvelope.parse(body)?.code
        }

        /// The human-readable half of the gateway's error envelope, when
        /// this is a `serverError` carrying one.
        public var gatewayMessage: String? {
            guard case .serverError(_, let body) = self else { return nil }
            return GatewayErrorEnvelope.parse(body)?.error
        }
    }

    // MARK: - Public API

    /// Probe `/health`. Returns true on 200 OK with `{"ok": true, ...}`.
    /// Auth-exempt — succeeds as long as the gateway is reachable, regardless
    /// of whether this client's token is valid. Use `authedPing()` to verify
    /// the token is actually accepted.
    public func health() async throws -> Bool {
        struct HealthResponse: Decodable { let ok: Bool? }
        let (data, response) = try await performNoBody(
            method: "GET", path: "/health", authRequired: false
        )
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
        let parsed = (try? decoder.decode(HealthResponse.self, from: data))
        return parsed?.ok ?? true
    }

    /// Probe an authenticated endpoint to verify the client's token is
    /// recognised by the gateway. Throws `Error.unauthorized` on 401 — useful
    /// for surfacing orphaned / revoked pairings in the UI. Succeeds
    /// silently on 2xx.
    public func authedPing() async throws {
        _ = try await performNoBody(
            method: "GET", path: "/status", authRequired: true
        )
    }

    /// POST `/analytics/ingest`. Pass the schema alongside every batch so
    /// the gateway creates / evolves the DuckDB table without needing the
    /// desktop collector to know it in advance.
    @discardableResult
    public func ingestAnalyticsRecords(
        tableName: String,
        records: [[String: JSONValue]],
        schema: AnalyticsTableSchema?,
        sourceId: String,
        deletedIds: [String] = []
    ) async throws
        -> AnalyticsIngestResponse {
        let body = AnalyticsIngestRequest(
            tableName: tableName,
            records: records,
            schema: schema,
            sourceId: sourceId,
            deletedIds: deletedIds.isEmpty ? nil : deletedIds
        )
        let (data, _) = try await perform(
            method: "POST", path: "/analytics/ingest", authRequired: true, body: body
        )
        do {
            return try decoder.decode(AnalyticsIngestResponse.self, from: data)
        } catch {
            throw Error.decoding("\(error)")
        }
    }

    /// POST `/documents`. Upserts searchable summary documents bound 1:1
    /// to analytics rows. The plain (cursor-free) ingest endpoint —
    /// idempotent by `(providerId, sourceId, externalId)` upsert, and it
    /// neither advances a sync cursor nor reconcile-deletes, which matches
    /// the iOS buffered/out-of-order drain model (cursors are managed
    /// separately via `/sync-state`, same as the analytics path).
    @discardableResult
    public func ingestDocuments(_ documents: [DocumentInput]) async throws -> DocumentIngestResponse {
        let body = DocumentIngestRequest(documents: documents)
        let (data, _) = try await perform(
            method: "POST", path: "/documents", authRequired: true, body: body
        )
        do {
            return try decoder.decode(DocumentIngestResponse.self, from: data)
        } catch {
            throw Error.decoding("\(error)")
        }
    }

    /// POST `/documents/delete`. Deletes documents by natural key
    /// `(providerId, sourceId, externalId)` — no privacy tombstone (unlike
    /// `DELETE /documents/:id`), so a later re-sync of the same external id
    /// can legitimately recreate the row. This is the "removed from the
    /// source" channel (e.g. a photo deleted from the phone library), as
    /// opposed to a user-initiated privacy delete.
    ///
    /// A deletion-only batch has no other call site that would surface a
    /// removed/paused rejection (unlike `ingestDocuments`/
    /// `ingestAnalyticsRecords`, whose responses are the only place a
    /// rejection is normally observed) — the gateway gates this endpoint
    /// the same way, so `response.rejected` must be checked here too.
    @discardableResult
    public func deleteDocuments(
        providerId: String,
        sourceId: String,
        externalIds: [String]
    ) async throws
        -> DeleteDocumentsResponse {
        let body = DeleteDocumentsRequest(providerId: providerId, sourceId: sourceId, externalIds: externalIds)
        let (data, _) = try await perform(
            method: "POST", path: "/documents/delete", authRequired: true, body: body
        )
        do {
            return try decoder.decode(DeleteDocumentsResponse.self, from: data)
        } catch {
            throw Error.decoding("\(error)")
        }
    }

    /// POST `/documents/reconcile`. Whole-library snapshot reconciliation:
    /// tells the gateway every external id `(providerId, sourceId)` currently
    /// holds. A document the snapshot omits is not deleted — the omission is
    /// recorded with a deadline, and only several later snapshots that agree,
    /// spanning a minimum span of time, turn it into a deletion; a snapshot
    /// that names it again cancels the record. The backstop for deletions an
    /// incremental/observer-driven sync might miss — run this as its own
    /// periodic pass, never mixed into the regular paged sync cursor (a
    /// snapshot can't be expressed as one page of a resumable cursor).
    @discardableResult
    public func reconcileDocuments(
        providerId: String,
        sourceId: String,
        presentExternalIds: [String]
    ) async throws
        -> ReconcileDocumentsResponse {
        let body = ReconcileDocumentsRequest(
            providerId: providerId, sourceId: sourceId, presentExternalIds: presentExternalIds
        )
        let (data, _) = try await perform(
            method: "POST", path: "/documents/reconcile", authRequired: true, body: body
        )
        do {
            return try decoder.decode(ReconcileDocumentsResponse.self, from: data)
        } catch {
            throw Error.decoding("\(error)")
        }
    }

    /// GET `/sync-state/:sourceId`. Returns `nil` if no cursor persisted.
    public func getSyncState(sourceId: String) async throws -> SyncStateResponse? {
        let encoded = percentEncodePath(sourceId)
        let (data, response) = try await performNoBody(
            method: "GET", path: "/sync-state/\(encoded)", authRequired: true
        )
        if let http = response as? HTTPURLResponse, http.statusCode == 404 { return nil }
        do {
            return try decoder.decode(SyncStateResponse.self, from: data)
        } catch {
            throw Error.decoding("\(error)")
        }
    }

    /// POST `/sync-state/:sourceId`. Persists an opaque cursor for future
    /// resume. Additional optional fields (`label`, `icon`, `urlPatterns`)
    /// mirror what the desktop collector sends.
    public func setSyncState(
        sourceId: String,
        cursor: [String: JSONValue],
        label: String? = nil,
        icon: String? = nil,
        family: SourceFamilyDescriptor? = nil
    ) async throws {
        let encoded = percentEncodePath(sourceId)
        let body = SyncStateRequest(
            cursor: cursor, label: label, icon: icon, urlPatterns: nil, family: family
        )
        _ = try await perform(
            method: "POST", path: "/sync-state/\(encoded)", authRequired: true, body: body
        )
    }

    /// Claim or renew this device's lease for a replicated source. A device
    /// without the lease may still contribute upserts, but the gateway defers
    /// its deletes so an incomplete replica cannot erase healthy sibling data.
    public func claimSyncLease(sourceId: String) async throws -> SyncLeaseResponse? {
        let encoded = percentEncodePath(sourceId)
        let (data, response) = try await performNoBody(
            method: "POST", path: "/sync-state/\(encoded)/lease", authRequired: true
        )
        if (response as? HTTPURLResponse)?.statusCode == 404 { return nil }
        do {
            return try decoder.decode(SyncLeaseResponse.self, from: data)
        } catch {
            throw Error.decoding("\(error)")
        }
    }

    public func releaseSyncLease(sourceId: String) async throws {
        let encoded = percentEncodePath(sourceId)
        _ = try await performNoBody(
            method: "DELETE", path: "/sync-state/\(encoded)/lease", authRequired: true
        )
    }

    // MARK: - Core request machinery

    private func performNoBody(
        method: String,
        path: String,
        authRequired: Bool
    ) async throws
        -> (Data, URLResponse) {
        try await dispatch(method: method, path: path, authRequired: authRequired, bodyData: nil)
    }

    private func perform(
        method: String,
        path: String,
        authRequired: Bool,
        body: some Encodable
    ) async throws
        -> (Data, URLResponse) {
        let bodyData = try encoder.encode(body)
        return try await dispatch(method: method, path: path, authRequired: authRequired, bodyData: bodyData)
    }

    private func dispatch(
        method: String,
        path: String,
        authRequired: Bool,
        bodyData: Data?
    ) async throws
        -> (Data, URLResponse) {
        guard let requestURL = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw Error.invalidURL
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authRequired {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
        }

        let (data, response) = try await session.data(for: request)

        guard let http = response as? HTTPURLResponse else {
            throw Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299, 404:
            return (data, response)
        case 401:
            throw Error.unauthorized
        case 403:
            throw Error.forbidden
        default:
            // The body is carried verbatim, as every other client in this
            // module does. `gatewayCode` / `gatewayMessage` read the envelope
            // off it, so a caller can branch on the refusal code; unwrapping
            // here would leave those accessors structurally nil and make the
            // machine-readable half unreachable. Rendering unwraps instead —
            // see `errorMessage(from:)`.
            throw Error.serverError(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
    }

    /// The human-readable half of a gateway error response.
    ///
    /// Every 4xx/5xx from the Omnesis gateway is the envelope
    /// `{ "error": <message>, "code": <CODE>, "detail"?: <unknown> }`. A
    /// surface that puts the failure on screen wants the message, not the
    /// JSON, so it unwraps through here — one place that knows the wire
    /// format, rather than each view parsing it. A body that is not the
    /// envelope (a proxy's HTML, a truncated response) is returned as-is: it
    /// is not useful, but it is not made worse.
    static func errorMessage(from data: Data) -> String {
        guard let envelope = GatewayErrorEnvelope.parse(data), !envelope.error.isEmpty else {
            return String(data: data, encoding: .utf8) ?? ""
        }
        return envelope.error
    }

    /// `errorMessage(from:)` for a body already decoded to a string — the
    /// shape a thrown `serverError` carries.
    static func errorMessage(from body: String) -> String {
        errorMessage(from: Data(body.utf8))
    }

    private func percentEncodePath(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
    }
}

public struct SyncLeaseResponse: Decodable, Equatable, Sendable {
    public let granted: Bool
    public let holder: String?
    public let expiresAt: Double?
    public let reason: String?
}

// MARK: - Wire types

/// The envelope every 4xx/5xx from the gateway carries:
/// `{ "error": <message>, "code": <CODE>, "detail"?: <unknown> }`. `code`
/// is the branch key for callers that react to a specific refusal; `error`
/// is what goes on screen.
public struct GatewayErrorEnvelope: Decodable, Equatable, Sendable {
    public let error: String
    public let code: String?

    public init(error: String, code: String? = nil) {
        self.error = error
        self.code = code
    }

    /// Nil when `data` is not the envelope (a proxy's HTML, a truncated body).
    public static func parse(_ data: Data) -> GatewayErrorEnvelope? {
        try? JSONDecoder().decode(GatewayErrorEnvelope.self, from: data)
    }

    public static func parse(_ body: String) -> GatewayErrorEnvelope? {
        parse(Data(body.utf8))
    }
}

public struct AnalyticsIngestRequest: Encodable, Sendable {
    public let tableName: String
    public let records: [[String: JSONValue]]
    public let schema: AnalyticsTableSchema?
    public let sourceId: String
    public let deletedIds: [String]?
}

/// One per-source rejection in a push response. The gateway accepts the request
/// (HTTP 200) but declines to write a source that was **removed** or **paused**
/// in Omnesis, reporting it here so the client can stop pushing and react. The
/// field is absent on the success path; both ingest responses default it to `[]`.
public struct PushRejection: Decodable, Equatable, Sendable {
    public let sourceId: String
    /// The raw reason enum: `"removed"` or `"paused"`.
    public let reason: String

    public init(sourceId: String, reason: String) {
        self.sourceId = sourceId
        self.reason = reason
    }
}

public struct AnalyticsIngestResponse: Decodable, Equatable, Sendable {
    public let ingested: Int
    public let rejected: [PushRejection]
    public let deletionDeferred: Bool

    public init(ingested: Int, rejected: [PushRejection] = [], deletionDeferred: Bool = false) {
        self.ingested = ingested
        self.rejected = rejected
        self.deletionDeferred = deletionDeferred
    }

    enum CodingKeys: String, CodingKey { case ingested, rejected, deletionDeferred }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ingested = try c.decodeIfPresent(Int.self, forKey: .ingested) ?? 0
        rejected = try c.decodeIfPresent([PushRejection].self, forKey: .rejected) ?? []
        deletionDeferred = try c.decodeIfPresent(Bool.self, forKey: .deletionDeferred) ?? false
    }
}

public struct DocumentIngestRequest: Codable, Equatable, Sendable {
    public let documents: [DocumentInput]
}

public struct DocumentIngestResponse: Decodable, Equatable, Sendable {
    public let ingested: Int
    public let rejected: [PushRejection]

    public init(ingested: Int, rejected: [PushRejection] = []) {
        self.ingested = ingested
        self.rejected = rejected
    }

    enum CodingKeys: String, CodingKey { case ingested, rejected }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ingested = try c.decodeIfPresent(Int.self, forKey: .ingested) ?? 0
        rejected = try c.decodeIfPresent([PushRejection].self, forKey: .rejected) ?? []
    }
}

public struct DeleteDocumentsRequest: Codable, Equatable, Sendable {
    public let providerId: String
    public let sourceId: String
    public let externalIds: [String]
}

public struct DeleteDocumentsResponse: Decodable, Equatable, Sendable {
    public let deleted: Int
    public let rejected: [PushRejection]

    public init(deleted: Int, rejected: [PushRejection] = []) {
        self.deleted = deleted
        self.rejected = rejected
    }

    enum CodingKeys: String, CodingKey { case deleted, rejected }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deleted = try c.decodeIfPresent(Int.self, forKey: .deleted) ?? 0
        rejected = try c.decodeIfPresent([PushRejection].self, forKey: .rejected) ?? []
    }
}

public struct ReconcileDocumentsRequest: Codable, Equatable, Sendable {
    public let providerId: String
    public let sourceId: String
    public let presentExternalIds: [String]
}

public struct ReconcileDocumentsResponse: Decodable, Equatable, Sendable {
    public let deleted: Int
    public let deletedIds: [String]

    public init(deleted: Int, deletedIds: [String] = []) {
        self.deleted = deleted
        self.deletedIds = deletedIds
    }

    enum CodingKeys: String, CodingKey { case deleted, deletedIds }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        deleted = try c.decodeIfPresent(Int.self, forKey: .deleted) ?? 0
        deletedIds = try c.decodeIfPresent([String].self, forKey: .deletedIds) ?? []
    }
}

public struct SyncStateResponse: Decodable, Equatable, Sendable {
    public let cursor: [String: JSONValue]?
    public let lastSyncedAt: String?
    public let hasMeta: Bool?
}

public struct SyncStateRequest: Encodable, Sendable {
    public let cursor: [String: JSONValue]
    public let label: String?
    public let icon: String?
    public let urlPatterns: [URLPatternDescriptor]?
    /// The identity of the source's family, as opposed to this account's own.
    ///
    /// A client that groups a corpus by source type reads this one, and it
    /// cannot be recovered from any single account: two accounts of a type may
    /// legitimately differ, so a family assembled from either is named after
    /// one of its members. Every phone-hosted source has one account per type,
    /// so its family is that account's identity — declared rather than
    /// inferred by whoever reads the table.
    public let family: SourceFamilyDescriptor?
}

public struct SourceFamilyDescriptor: Encodable, Sendable {
    public let icon: String?
    public let label: String?

    public init(icon: String? = nil, label: String? = nil) {
        self.icon = icon
        self.label = label
    }
}

public struct URLPatternDescriptor: Codable, Equatable, Sendable {
    public let regex: String
    public let idGroup: Int?
}

/// Lightweight JSON value type for the cursor + record maps. Keeps us from
/// needing `[String: Any]` across a `Sendable` boundary.
public enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case int(Int64)
    case double(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null
            return
        }
        if let b = try? container.decode(Bool.self) { self = .bool(b)
            return
        }
        if let i = try? container.decode(Int64.self) { self = .int(i)
            return
        }
        if let d = try? container.decode(Double.self) { self = .double(d)
            return
        }
        if let s = try? container.decode(String.self) { self = .string(s)
            return
        }
        if let a = try? container.decode([JSONValue].self) { self = .array(a)
            return
        }
        if let o = try? container.decode([String: JSONValue].self) { self = .object(o)
            return
        }
        throw DecodingError.typeMismatch(
            JSONValue.self,
            DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unknown JSON value")
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .int(let i): try container.encode(i)
        case .double(let d): try container.encode(d)
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }
}
