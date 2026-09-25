// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// HTTP client for the gateway's read-side endpoints used by the iOS
/// browse/search UI: hybrid search, recent items per source, and
/// document detail (body + people + attachments).
///
/// Mirrors `AdminClient` in shape — separate file so test mocks stay
/// focused. The gateway's canonical grant for a paired phone carries `read`
/// scope, so all of these endpoints accept the device token.
public final class SearchClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSessionLike
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    // MARK: - Search

    /// POST `/search` — hybrid BM25 + vector search across the corpus.
    /// `verbose` requests the gateway's debug block (model readiness,
    /// query length). iOS always sends `true` because the
    /// search view renders a per-search pipeline footer below results.
    public func search(
        text: String,
        limit: Int? = nil,
        verbose: Bool = true
    ) async throws
        -> SearchResponse {
        struct Body: Encodable {
            let text: String
            let limit: Int?
            let verbose: Bool?
        }
        let body = try encoder.encode(Body(text: text, limit: limit, verbose: verbose))
        let (data, _) = try await dispatch(method: "POST", path: "/search", body: body)
        return try decodeOrThrow(SearchResponse.self, from: data)
    }

    // MARK: - Per-source recent items

    /// GET `/sources/:sourceId/recent` — unified recent-items view.
    /// Returns documents when present; falls back to an analytics table
    /// for structured-data sources; empty otherwise.
    public func recentItems(
        sourceId: String,
        limit: Int = 25,
        cursor: String? = nil
    ) async throws
        -> RecentItemsPage {
        let path = queryPath(
            "/sources/\(percentEncode(sourceId))/recent",
            items: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "cursor", value: cursor),
            ]
        )
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(RecentItemsPage.self, from: data)
    }

    // MARK: - Document detail

    /// GET `/documents/:id` — single document row including body + metadata.
    public func getDocument(id: String) async throws -> DocumentDetail {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/documents/\(percentEncode(id))",
            body: nil
        )
        return try decodeOrThrow(DocumentDetail.self, from: data)
    }

    /// GET `/documents/:id/people` — extracted people mentions for a doc.
    public func getDocumentPeople(id: String) async throws -> [PersonMention] {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/documents/\(percentEncode(id))/people",
            body: nil
        )
        struct Wrap: Decodable { let people: [PersonMention] }
        return try decodeOrThrow(Wrap.self, from: data).people
    }

    /// GET `/documents/:id/annotations` — the agent's durable LLM
    /// observations grounded on this document (the portal's "Enriched by
    /// Omnesis" panel). Experimental-gated server-side: the route 404s when
    /// the gateway isn't in experimental mode, so callers gate the fetch on
    /// `experimentalEnabled` and degrade to an empty list via `try?`.
    public func getDocumentAnnotations(
        id: String,
        limit: Int = 20,
        cursor: String? = nil
    ) async throws
        -> AnnotationPage {
        let path = queryPath(
            "/documents/\(percentEncode(id))/annotations",
            items: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "cursor", value: cursor),
                URLQueryItem(name: "includeDependents", value: "0"),
            ]
        )
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(AnnotationPage.self, from: data)
    }

    /// GET `/documents/:id/refs` — outbound + inbound link graph for
    /// the document. Drives the iOS doc-detail "References" panel.
    public func getDocumentRefs(id: String, limit: Int = 25) async throws -> DocumentRefs {
        do {
            async let outbound = getDocumentOutboundRefs(id: id, limit: limit)
            async let inbound = getDocumentInboundRefs(id: id, limit: limit)
            let pages = try await (outbound, inbound)
            return DocumentRefs(
                outbound: pages.0.items,
                inbound: pages.1.items,
                outboundPageInfo: pages.0.pageInfo,
                inboundPageInfo: pages.1.pageInfo
            )
        } catch GatewayClient.Error.notFound {
            // Compatibility with gateways predating the direction-specific
            // canonical pages. Their legacy endpoint is finite from the
            // client's perspective, so no load-more affordance is shown.
            let (data, _) = try await dispatch(
                method: "GET",
                path: "/documents/\(percentEncode(id))/refs",
                body: nil
            )
            return try decodeOrThrow(DocumentRefs.self, from: data)
        }
    }

    public func getDocumentInboundRefs(
        id: String,
        limit: Int = 25,
        cursor: String? = nil
    ) async throws
        -> Page<InboundRef> {
        let path = queryPath(
            "/documents/\(percentEncode(id))/refs/inbound",
            items: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "cursor", value: cursor),
            ]
        )
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(Page<InboundRef>.self, from: data)
    }

    public func getDocumentOutboundRefs(
        id: String,
        limit: Int = 25,
        cursor: String? = nil
    ) async throws
        -> Page<OutboundRef> {
        let path = queryPath(
            "/documents/\(percentEncode(id))/refs/outbound",
            items: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "cursor", value: cursor),
            ]
        )
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(Page<OutboundRef>.self, from: data)
    }

    /// GET `/documents/:id/near-dupes` — near-duplicate edges for the
    /// "Similar" section of the document inspector.
    public func getDocumentNearDupes(
        id: String,
        limit: Int = 20,
        cursor: String? = nil
    ) async throws
        -> DocumentNearDupes {
        let path = queryPath(
            "/documents/\(percentEncode(id))/near-dupes",
            items: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "after", value: cursor),
            ]
        )
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(DocumentNearDupes.self, from: data)
    }

    /// GET `/documents/:id/graph?depth=1` — the graph walker's
    /// neighbourhood for this document. iOS uses it only to surface the
    /// cross-store `same-entity` doc↔row edge: the bound
    /// DuckDB analytics row is a direct neighbour, so one shallow hop is
    /// enough. The matching portal call lives in `graph-card.js`'s
    /// `useBoundRows`. Callers filter `vertices` to `kind == "analytics-row"`.
    public func getDocumentGraph(id: String, depth: Int = 1) async throws -> DocumentGraph {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/documents/\(percentEncode(id))/graph?depth=\(depth)",
            body: nil
        )
        return try decodeOrThrow(DocumentGraph.self, from: data)
    }

    /// GET `/documents/:id/attachments` — child attachment docs.
    public func getDocumentAttachments(id: String) async throws -> [DocumentAttachment] {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/documents/\(percentEncode(id))/attachments",
            body: nil
        )
        struct Wrap: Decodable { let attachments: [DocumentAttachment] }
        return try decodeOrThrow(Wrap.self, from: data).attachments
    }

    /// GET `/documents/:id/trail` — the event trail seeded from this
    /// document: the same `EventTrail` shape the agent's `trace_connections`
    /// tool result carries, so the inspector's Timeline tab can feed the
    /// decoded events straight into `TrailTimelineView`.
    public func documentTrail(_ id: String) async throws -> DocumentEventTrail {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/documents/\(percentEncode(id))/trail",
            body: nil
        )
        return try decodeOrThrow(DocumentEventTrail.self, from: data)
    }

    // MARK: - Gateway-wide stats (Sources tab summary card)

    /// GET `/status` — high-frequency status snapshot. Powers the
    /// Sources summary card (doc counts, db size, latest-activity map)
    /// and the per-source last-activity row.
    public func getStatus() async throws -> StatusSnapshot {
        let (data, _) = try await dispatch(method: "GET", path: "/status", body: nil)
        return try decodeOrThrow(StatusSnapshot.self, from: data)
    }

    /// GET `/index/stats` — embedding indexer progress per source.
    /// `bySource[sourceId].percentIndexed` drives the per-row indexing
    /// pill; `totalIndexed` / `totalChunks` / `model.name` drive the
    /// header strip.
    public func getIndexStats() async throws -> IndexStats {
        let (data, _) = try await dispatch(method: "GET", path: "/index/stats", body: nil)
        return try decodeOrThrow(IndexStats.self, from: data)
    }

    // MARK: - People

    /// GET `/people?q=&limit=` — list canonical persons, ordered by
    /// recent interaction score (self pinned first). Mirrors the
    /// portal's People sub-tab.
    public func listPeoplePage(
        query: String? = nil,
        limit: Int = 50,
        cursor: String? = nil
    ) async throws
        -> Page<PersonSummary> {
        let path = queryPath(
            "/people",
            items: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "q", value: query.flatMap { $0.isEmpty ? nil : $0 }),
                URLQueryItem(name: "cursor", value: cursor),
            ]
        )
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(Page<PersonSummary>.self, from: data)
    }

    public func listPeople(query: String? = nil, limit: Int = 50) async throws -> [PersonSummary] {
        try await listPeoplePage(query: query, limit: limit).items
    }

    /// GET `/people/stats` — summary counts for the People list view,
    /// including the pending merge-candidate and active merge-rule totals
    /// that label the two merge-shortcut buttons.
    public func peopleStats() async throws -> PeopleStats {
        let (data, _) = try await dispatch(method: "GET", path: "/people/stats", body: nil)
        return try decodeOrThrow(PeopleStats.self, from: data)
    }

    /// GET `/people/:id` — full person record (aliases, interaction
    /// stats). Skips the merged-into block on iOS — that surface stays
    /// portal-only.
    public func getPerson(id: String) async throws -> PersonDetail {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/people/\(percentEncode(id))",
            body: nil
        )
        return try decodeOrThrow(PersonDetail.self, from: data)
    }

    /// GET `/people/:id/documents` — documents linked to this person.
    /// Returns IDs + roles per doc; the iOS view fetches each doc's
    /// preview separately on tap.
    public func getPersonDocumentsPage(
        id: String,
        limit: Int = 30,
        cursor: String? = nil
    ) async throws
        -> Page<PersonDocumentEntry> {
        var path = "/people/\(percentEncode(id))/documents?limit=\(limit)"
        if let cursor, !cursor.isEmpty {
            path += "&cursor=\(percentEncode(cursor))"
        }
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(Page<PersonDocumentEntry>.self, from: data)
    }

    /// Compatibility convenience for consumers that only need one page's
    /// items. New paginated views should use `getPersonDocumentsPage` and pass
    /// the gateway's opaque `nextCursor` back unchanged.
    public func getPersonDocuments(
        id: String,
        limit: Int = 30,
        offset: Int = 0
    ) async throws
        -> [PersonDocumentEntry] {
        try await getPersonDocumentsPage(
            id: id,
            limit: limit,
            cursor: offset > 0 ? String(offset) : nil
        ).items
    }

    /// GET `/people/:id/annotations` — the agent's durable LLM observations
    /// about this person. On the self person these are the user's own
    /// "Profile". Experimental-gated server-side: the route 404s when the
    /// gateway isn't in experimental mode, so callers gate the fetch on
    /// `experimentalEnabled` and degrade to an empty list via `try?`.
    public func getPersonAnnotations(
        id: String,
        limit: Int = 20,
        cursor: String? = nil
    ) async throws
        -> AnnotationPage {
        let path = queryPath(
            "/people/\(percentEncode(id))/annotations",
            items: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "cursor", value: cursor),
                URLQueryItem(name: "includeDependents", value: "0"),
            ]
        )
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(AnnotationPage.self, from: data)
    }

    /// GET `/people/merge-rules` — operator-visible merge rules, each a
    /// directional "loser → winner" identity merge. Mirrors the portal's
    /// merge-rules page: `resolve`+`details`+`preMerge` request the
    /// pre-merge identities each side originally carried, with their
    /// aliases and source-icon strips. Read-only on iOS — the page shows
    /// the rules but does not delete or undo them.
    public func listMergeRules() async throws -> [MergeRule] {
        let (data, _) = try await dispatch(
            method: "GET",
            path: "/people/merge-rules?active=1&resolve=1&details=1&preMerge=1",
            body: nil
        )
        struct Wrap: Decodable { let rules: [MergeRule] }
        return try decodeOrThrow(Wrap.self, from: data).rules
    }

    /// Whole-card cursor pagination for the merge audit. Unlike the legacy
    /// flat rule endpoint, a page never cuts a merged identity in half.
    public func listMergeRuleGroups(
        limit: Int = 25,
        cursor: String? = nil,
        query: String? = nil,
        kind: String? = nil
    ) async throws
        -> MergeRuleGroupsPage {
        let path = queryPath(
            "/people/merge-rule-groups",
            items: [
                URLQueryItem(name: "limit", value: String(limit)),
                URLQueryItem(name: "cursor", value: cursor),
                URLQueryItem(name: "q", value: query.flatMap { $0.isEmpty ? nil : $0 }),
                URLQueryItem(name: "kind", value: kind),
            ]
        )
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(MergeRuleGroupsPage.self, from: data)
    }

    // MARK: - People merge candidates

    /// GET `/people/merge-candidates` — probable-duplicate identities the
    /// fuzzy detector surfaced for review. Mirrors the portal's
    /// merge-candidates page: the gateway returns candidates already
    /// cluster-contiguous and cluster-ranked, each carrying the resolved
    /// people on both sides (with aliases + source strips) so the cluster
    /// card can be built client-side. `status` defaults to `pending`; pages
    /// are bounded by whole clusters so a card is never truncated.
    public func listMergeCandidates(
        status: String = "pending",
        clusterLimit: Int = 25,
        cursor: String? = nil,
        query: String? = nil
    ) async throws
        -> MergeCandidatesPage {
        let path = queryPath(
            "/people/merge-candidates",
            items: [
                URLQueryItem(name: "status", value: status),
                URLQueryItem(name: "clusterLimit", value: String(clusterLimit)),
                URLQueryItem(name: "cursor", value: cursor),
                URLQueryItem(name: "q", value: query.flatMap { $0.isEmpty ? nil : $0 }),
            ]
        )
        let (data, _) = try await dispatch(method: "GET", path: path, body: nil)
        return try decodeOrThrow(MergeCandidatesPage.self, from: data)
    }

    /// POST `/people/merge-candidates/merge-cluster` — unify N people into
    /// one identity in a single action (the portal's primary merge action;
    /// the gateway creates the N-1 user merge rules and re-picks the
    /// canonical). Requires `admin` scope, which paired apps hold.
    @discardableResult
    public func mergeCluster(personIds: [String], reason: String? = nil) async throws -> MergeClusterResult {
        struct Body: Encodable {
            let personIds: [String]
            let reason: String?
        }
        let body = try encoder.encode(Body(personIds: personIds, reason: reason))
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/people/merge-candidates/merge-cluster",
            body: body
        )
        return try decodeOrThrow(MergeClusterResult.self, from: data)
    }

    /// POST `/people/merge-candidates/:id/deny` — dismiss a candidate so the
    /// detector won't re-propose it. Idempotent. Requires `admin` scope.
    public func denyMergeCandidate(id: String) async throws {
        _ = try await dispatch(
            method: "POST",
            path: "/people/merge-candidates/\(percentEncode(id))/deny",
            body: nil
        )
    }

    /// DELETE `/documents/:id` — remove a single document from the corpus
    /// for privacy. The gateway also deletes its extracted-attachment
    /// children. By default it writes a durable tombstone so a re-sync /
    /// re-capture can't bring the page back; with `keepCopy` only this copy
    /// goes and the source may bring it back. Returns the number of rows
    /// removed (the parent plus any attachment children). Requires a write
    /// scope for the document's source.
    @discardableResult
    public func deleteDocument(id: String, keepCopy: Bool = false) async throws -> Int {
        let (data, _) = try await dispatch(
            method: "DELETE",
            path: "/documents/\(percentEncode(id))\(keepCopy ? "?tombstone=0" : "")",
            body: nil
        )
        struct Wrap: Decodable { let deleted: Int }
        return (try? decodeOrThrow(Wrap.self, from: data).deleted) ?? 0
    }

    /// File a developer annotation (`OMNESIS_DEV_MODE`) — the operator →
    /// engineer data-quality feedback channel. The `/dev/annotations` route
    /// 404s when the gateway isn't in developer mode; the shake-to-annotate
    /// affordance is only offered when `GET /status` reports `developer`, so
    /// this is reached only in developer mode. The context snapshot carries
    /// the filing platform and, when known, the app version/build, so an
    /// engineer triaging with `omnesis dev-annotations` can tell which binary
    /// produced the note.
    public func createDevAnnotation(
        targetType: String,
        targetId: String?,
        note: String,
        contextLabel: String?,
        appVersion: String? = nil,
        appBuild: String? = nil
    ) async throws {
        struct Body: Encodable {
            let targetType: String
            let targetId: String?
            let note: String
            let context: [String: String]?
            let client: String
        }
        var context = ["platform": "ios"]
        if let contextLabel { context["label"] = contextLabel }
        if let appVersion, !appVersion.isEmpty { context["appVersion"] = appVersion }
        if let appBuild, !appBuild.isEmpty { context["appBuild"] = appBuild }
        let body = Body(
            targetType: targetType,
            targetId: targetId,
            note: note,
            context: context,
            client: "ios"
        )
        _ = try await dispatch(
            method: "POST",
            path: "/dev/annotations",
            body: encoder.encode(body)
        )
    }

    // MARK: - Core request machinery

    private func dispatch(
        method: String,
        path: String,
        body: Data?
    ) async throws
        -> (Data, HTTPURLResponse) {
        guard let requestURL = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299:
            return (data, http)
        case 401:
            throw GatewayClient.Error.unauthorized
        case 403:
            throw GatewayClient.Error.forbidden
        case 404:
            throw GatewayClient.Error.notFound
        default:
            let text = String(data: data, encoding: .utf8) ?? ""
            throw GatewayClient.Error.serverError(status: http.statusCode, body: text)
        }
    }

    private func decodeOrThrow<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw GatewayClient.Error.decoding("\(error)")
        }
    }

    private func percentEncode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    private func queryPath(_ path: String, items: [URLQueryItem]) -> String {
        var components = URLComponents()
        components.percentEncodedPath = path
        let present = items.filter { $0.value != nil }
        components.queryItems = present.isEmpty ? nil : present
        return components.string ?? path
    }
}

// MARK: - Wire types — search

/// One result row from `POST /search`. Mirrors `SearchResultItem` in
/// `packages/gateway/src/search/types.ts:50`.
public struct SearchResultItem: Decodable, Identifiable, Hashable, Sendable {
    public var id: String {
        documentId
    }

    public let documentId: String
    public let sourceId: String
    public let documentType: String
    public let title: String
    public let sourceUrl: String?
    public let appUrl: String?
    public let sourceCreatedAt: String
    public let author: String?
    public let chunkText: String
    public let score: Double
    public let refCount: Int?
    public let scoreBreakdown: SearchScoreBreakdown?
}

/// Per-result score components emitted when `verbose: true` is set on
/// the search request. Mirrors `ScoreBreakdown` in
/// `packages/gateway/src/search/types.ts:65`.
public struct SearchScoreBreakdown: Decodable, Hashable, Sendable {
    public let bm25Rank: Int?
    public let vectorRank: Int?
    public let rrfScore: Double?
    public let rankBonus: Double?
    public let typeBoost: Double?
    public let relevanceBoost: Double?
    public let sourcePrior: Double?
    public let finalScore: Double?
}

/// Response wrapper from `POST /search`. Carries everything the portal's
/// verbose view shows: stage-by-stage timing, model identifiers, parsed
/// filters, and the debug block (model readiness + query length).
public struct SearchResponse: Decodable, Sendable {
    public let results: [SearchResultItem]
    public let model: String?
    public let models: SearchModels?
    public let query: SearchQueryReport?
    public let timing: SearchTiming?
    public let stages: SearchStages?
    public let debug: SearchDebugInfo?

    public struct SearchModels: Decodable, Sendable {
        public let embedding: String?
    }

    public struct SearchQueryReport: Decodable, Sendable {
        public let original: String?
        public let effectiveText: String?
    }

    public struct SearchTiming: Decodable, Sendable {
        public let totalMs: Double?
        public let bm25Ms: Double?
        public let vectorMs: Double?
        public let bm25Candidates: Int?
        public let vectorCandidates: Int?
    }

    /// Per-stage execution report. Mirrors `SearchStageReport` in
    /// `packages/gateway/src/search/types.ts:98`.
    public struct StageReport: Decodable, Sendable {
        public let status: String?
        public let reason: String?
        public let durationMs: Double?
        public let candidates: Int?
        public let method: String?
        public let rrfK: Int?
        public let bm25Weight: Double?
        public let vectorWeight: Double?
        public let resultCount: Int?
        public let quantization: String?
        public let rescore: Bool?
        public let effectiveK: Int?
        public let embedMs: Double?
        public let sqlMs: Double?
    }

    public struct SearchStages: Decodable, Sendable {
        public let bm25: StageReport?
        public let vector: StageReport?
        public let fusion: StageReport?
        public let boost: StageReport?
        public let refCount: StageReport?
    }

    public struct SearchDebugInfo: Decodable, Sendable {
        public let modelState: ModelState?
        public let query: QueryLengths?

        public struct ModelState: Decodable, Sendable {
            public let vector: String?
        }

        public struct QueryLengths: Decodable, Sendable {
            public let inputLength: Int?
        }
    }
}

// MARK: - Wire types — per-source recent

/// Tagged-union response from `GET /sources/:sourceId/recent`. Three
/// shapes share the `kind` discriminator:
///   - `.documents`: a list of recent doc summaries (most sources).
///   - `.analytics`: an analytics-table fallback for pure-structured
///     sources, including the recent row values rendered by native clients.
///   - `.empty`: nothing to show yet.
public enum RecentItemsResponse: Decodable, Sendable {
    case documents([RecentDocument])
    case analytics(table: String, displayName: String, columns: [String], rows: [[JSONValue]])
    case empty

    private enum CodingKeys: String, CodingKey {
        case kind
        case documents
        case table
        case displayName
        case columns
        case rows
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "documents":
            let docs = try container.decode([RecentDocument].self, forKey: .documents)
            self = .documents(docs)
        case "analytics":
            let table = try container.decode(String.self, forKey: .table)
            let displayName = try container.decode(String.self, forKey: .displayName)
            let columns = try container.decode([String].self, forKey: .columns)
            let rows = try container.decodeIfPresent([[JSONValue]].self, forKey: .rows) ?? []
            self = .analytics(
                table: table,
                displayName: displayName,
                columns: columns,
                rows: rows
            )
        case "empty":
            self = .empty
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unknown recent-items kind: \(kind)"
            )
        }
    }
}

/// One cursor page of the tagged recent-items response. `pageInfo` is
/// additive; an older gateway omits it and therefore behaves as one exhausted
/// page rather than receiving a cursor it does not understand. `isInternal`
/// is the envelope's gateway-internal flag (absent on older gateways →
/// false); screens prefer it over the separately-fetched sources list so a
/// stale list never shows the wrong delete prompt.
public struct RecentItemsPage: Decodable, Sendable {
    public let content: RecentItemsResponse
    public let pageInfo: PageInfo
    public let isInternal: Bool

    public init(content: RecentItemsResponse, pageInfo: PageInfo, isInternal: Bool = false) {
        self.content = content
        self.pageInfo = pageInfo
        self.isInternal = isInternal
    }

    private enum CodingKeys: String, CodingKey {
        case pageInfo
        case isInternal = "internal"
    }

    public init(from decoder: Decoder) throws {
        content = try RecentItemsResponse(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pageInfo = try container.decodeIfPresent(PageInfo.self, forKey: .pageInfo)
            ?? .exhausted(limit: content.itemCount)
        isInternal = try container.decodeIfPresent(Bool.self, forKey: .isInternal) ?? false
    }
}

extension RecentItemsResponse {
    fileprivate var itemCount: Int {
        switch self {
        case .documents(let documents):
            documents.count
        case .analytics(_, _, _, let rows):
            rows.count
        case .empty:
            0
        }
    }
}

/// One row of the `documents` arm of `RecentItemsResponse`.
public struct RecentDocument: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let sourceId: String
    public let externalId: String
    public let title: String
    public let contentPreview: String?
    public let documentType: String?
    public let relevanceScore: Double?
    public let sourceCreatedAt: String
    public let sourceUpdatedAt: String?
}

// MARK: - Wire types — document detail

/// Full document row from `GET /documents/:id`. Wire format uses snake_case
/// because the gateway returns the raw SQL row — we map to camelCase via
/// CodingKeys. Metadata is a JSON blob (we expose the raw JSONValue and
/// pull out a few common fields for convenience).
public struct DocumentDetail: Decodable, Identifiable, Sendable {
    public let id: String
    public let providerId: String
    public let sourceId: String
    public let externalId: String
    public let title: String
    public let content: String
    public let contentHash: String
    public let metadata: JSONValue
    public let sourceCreatedAt: String
    public let sourceUpdatedAt: String?
    public let ingestedAt: String?
    public let updatedAt: String?
    /// True when the document belongs to a gateway-internal source
    /// (a dataset the gateway hosts itself). Absent on older gateways → false.
    public let isInternal: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case providerId = "provider_id"
        case sourceId = "source_id"
        case externalId = "external_id"
        case title
        case content
        case contentHash = "content_hash"
        case metadata
        case sourceCreatedAt = "source_created_at"
        case sourceUpdatedAt = "source_updated_at"
        case ingestedAt = "ingested_at"
        case updatedAt = "updated_at"
        case isInternal = "internal"
    }

    /// Metadata is a serialized JSON blob OR a parsed object depending on
    /// where the gateway returns it from. Decode lazily so the rest of
    /// the row still parses if metadata is malformed.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.providerId = try container.decode(String.self, forKey: .providerId)
        self.sourceId = try container.decode(String.self, forKey: .sourceId)
        self.externalId = try container.decode(String.self, forKey: .externalId)
        self.title = try container.decode(String.self, forKey: .title)
        self.content = try container.decode(String.self, forKey: .content)
        self.contentHash = try container.decode(String.self, forKey: .contentHash)

        // The /documents/:id endpoint returns the raw SQL row, where
        // `metadata` is a TEXT column holding stringified JSON. Decode it
        // either as a string-then-parse OR as an already-parsed object.
        if let raw = try? container.decode(String.self, forKey: .metadata),
           let parsed = JSONValue.parse(raw) {
            self.metadata = parsed
        } else if let parsedObject = try? container.decode(JSONValue.self, forKey: .metadata) {
            self.metadata = parsedObject
        } else {
            self.metadata = .null
        }

        self.sourceCreatedAt = try container.decode(String.self, forKey: .sourceCreatedAt)
        self.sourceUpdatedAt = try container.decodeIfPresent(String.self, forKey: .sourceUpdatedAt)
        self.ingestedAt = try container.decodeIfPresent(String.self, forKey: .ingestedAt)
        self.updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        // Strict on purpose: a type break here must surface as a decode
        // error, never as a silent `false` that shows the wrong
        // (two-button) delete prompt on an internal document.
        self.isInternal = try container.decodeIfPresent(Bool.self, forKey: .isInternal) ?? false
    }

    /// Convenience: pull a string field out of metadata, or nil if absent.
    public func metadataString(_ key: String) -> String? {
        guard case .object(let obj) = metadata, case .string(let s)? = obj[key] else {
            return nil
        }
        return s
    }

    /// Convenience: documentType from metadata.
    public var documentType: String? {
        metadataString("documentType")
    }

    /// Convenience: sourceUrl from metadata (when the source carries one).
    public var sourceUrl: String? {
        metadataString("sourceUrl")
    }

    /// Native-app deep link preferred on mobile clients.
    public var appUrl: String? {
        metadataString("appUrl")
    }
}

extension JSONValue {
    /// Parse a JSON string into a JSONValue. Returns nil on parse error.
    static func parse(_ raw: String) -> JSONValue? {
        guard let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Compact human-readable rendering for DuckDB-backed table cells.
    /// Doubles that are whole numbers print without a trailing `.0`;
    /// arrays / objects collapse to a count placeholder, and long scalar
    /// values use the same 200-character preview bound as the portal.
    var displayString: String {
        let rendered = switch self {
        case .null: "—"
        case .bool(let boolVal): boolVal ? "true" : "false"
        case .int(let intVal): String(intVal)
        case .double(let dbl):
            if dbl.rounded() == dbl, abs(dbl) < 1e15 {
                String(Int64(dbl))
            } else {
                String(dbl)
            }
        case .string(let str): str
        case .array(let arr): "[\(arr.count) items]"
        case .object(let obj): "{\(obj.count) fields}"
        }
        guard rendered.count > 200 else { return rendered }
        return String(rendered.prefix(200)) + "…"
    }
}

/// One person link on a document. Mirrors `DocumentPersonLink` in
/// `packages/gateway/src/people.ts:135` — the actual wire shape from
/// `GET /documents/:id/people`. The canonical-name string can be empty
/// for unmatched contacts (e.g. WhatsApp participants known only by
/// phone), so the UI falls back to the first alias.
public struct PersonMention: Decodable, Hashable, Sendable {
    public let personId: String
    public let canonicalName: String
    public let role: String
    public let isSelf: Bool
    public let aliases: [PersonAlias]

    /// Best-effort display label: canonicalName when non-empty, else
    /// first alias (typically a phone or email), else "(unknown)".
    public var displayName: String {
        if !canonicalName.isEmpty { return canonicalName }
        if let first = aliases.first, !first.alias.isEmpty { return first.alias }
        return "(unknown)"
    }
}

/// One alias attached to a `PersonMention` — phone, email, handle, etc.
/// Mirrors `PersonAlias` in `packages/gateway/src/people.ts:91`.
public struct PersonAlias: Decodable, Hashable, Sendable {
    public let id: String
    public let aliasType: String
    public let alias: String
    public let sourceId: String?
}

/// One durable LLM annotation — the agent's grounded observation about a
/// document (`GET /documents/:id/annotations`) or a person
/// (`GET /people/:id/annotations`). Both endpoints return the identical
/// shape, so one struct serves both; the same wire shape backs the portal's
/// `AnnotationList`. `confidence` is surfaced verbatim: these are defeasible
/// observations, not hard facts. `evidenceDocId` / `evidenceQuote` are
/// optional for render-time defensiveness — an annotation may carry no
/// grounding quote. Experimental-gated server-side: the routes 404 when the
/// gateway isn't in experimental mode, so callers gate the fetch on
/// `experimentalEnabled` and degrade to an empty list.
public struct Annotation: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let claimType: String
    public let claimText: String
    public let evidenceDocId: String?
    public let evidenceQuote: String?
    public let confidence: Double
    public let createdAt: String
    /// How far the claim reasons from its evidence ("quoted" | "inferred" |
    /// "synthesized"). Optional for wire compat with older gateways.
    public let claimBasis: String?
    /// Entailment-check stamp ("verified" | "unverified" | "failed"); nil =
    /// written with no verifier configured (or an older gateway).
    public let verificationState: String?
    /// ISO timestamp of the last entailment check; nil = never checked.
    public let lastVerifiedAt: String?

    public init(
        id: String,
        claimType: String,
        claimText: String,
        evidenceDocId: String?,
        evidenceQuote: String?,
        confidence: Double,
        createdAt: String,
        claimBasis: String? = nil,
        verificationState: String? = nil,
        lastVerifiedAt: String? = nil
    ) {
        self.id = id
        self.claimType = claimType
        self.claimText = claimText
        self.evidenceDocId = evidenceDocId
        self.evidenceQuote = evidenceQuote
        self.confidence = confidence
        self.createdAt = createdAt
        self.claimBasis = claimBasis
        self.verificationState = verificationState
        self.lastVerifiedAt = lastVerifiedAt
    }
}

public struct AnnotationPage: Decodable, Sendable {
    public let annotations: [Annotation]
    public let pageInfo: PageInfo

    public init(annotations: [Annotation], pageInfo: PageInfo) {
        self.annotations = annotations
        self.pageInfo = pageInfo
    }

    private enum CodingKeys: String, CodingKey {
        case annotations, pageInfo
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        annotations = try container.decodeIfPresent([Annotation].self, forKey: .annotations) ?? []
        pageInfo = try container.decodeIfPresent(PageInfo.self, forKey: .pageInfo)
            ?? .exhausted(limit: annotations.count)
    }
}

/// Reference graph for a document — the `GET /documents/:id/refs`
/// payload. Mirrors `DocumentRefs` in
/// `packages/gateway/src/links.ts:40`.
public struct DocumentRefs: Decodable, Sendable {
    public let outbound: [OutboundRef]
    public let inbound: [InboundRef]
    public let outboundPageInfo: PageInfo
    public let inboundPageInfo: PageInfo

    public init(
        outbound: [OutboundRef] = [],
        inbound: [InboundRef] = [],
        outboundPageInfo: PageInfo? = nil,
        inboundPageInfo: PageInfo? = nil
    ) {
        self.outbound = outbound
        self.inbound = inbound
        self.outboundPageInfo = outboundPageInfo ?? .exhausted(limit: outbound.count)
        self.inboundPageInfo = inboundPageInfo ?? .exhausted(limit: inbound.count)
    }

    private enum CodingKeys: String, CodingKey {
        case outbound, inbound, outboundPageInfo, inboundPageInfo
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        outbound = try container.decodeIfPresent([OutboundRef].self, forKey: .outbound) ?? []
        inbound = try container.decodeIfPresent([InboundRef].self, forKey: .inbound) ?? []
        outboundPageInfo = try container.decodeIfPresent(PageInfo.self, forKey: .outboundPageInfo)
            ?? .exhausted(limit: outbound.count)
        inboundPageInfo = try container.decodeIfPresent(PageInfo.self, forKey: .inboundPageInfo)
            ?? .exhausted(limit: inbound.count)
    }
}

/// Outbound link — this doc → some target. `targetDocId` is non-nil
/// when the URL resolved to an indexed doc; otherwise the iOS UI
/// renders it as an external link or "(not indexed)" muted row.
public struct OutboundRef: Decodable, Hashable, Sendable, Identifiable {
    public var id: String {
        "\(linkType):\(normalizedTarget)"
    }

    public let linkType: String
    public let rawTarget: String
    public let normalizedTarget: String
    public let targetDocId: String?
    public let targetTitle: String?
    public let targetSourceId: String?
    /// `source_url` from the target doc — the URL clients should
    /// prefer when opening this link (Gmail web view, Drive file, …).
    public let targetSourceUrl: String?
    /// Native-app deep link for the target doc, preferred on mobile.
    public let targetAppUrl: String?
}

/// Inbound link — some doc → this doc. Always resolved (we know the
/// source doc exists because the join in the SQL guarantees it).
public struct InboundRef: Decodable, Hashable, Sendable, Identifiable {
    public var id: String {
        sourceDocId
    }

    public let sourceDocId: String
    public let sourceTitle: String
    public let sourceSourceId: String
    public let linkType: String
    /// `source_url` from the inbound doc — preferred over the in-app
    /// viewer when the provider published one.
    public let sourceSourceUrl: String?
    /// Native-app deep link for the inbound doc, preferred on mobile.
    public let sourceAppUrl: String?
}

/// Near-duplicate graph for one document — the `GET
/// /documents/:id/near-dupes` payload. Mirrors `NearDupEdgesResponse`
/// in `packages/gateway/src/near-dupes/types.ts`.
public struct DocumentNearDupes: Decodable, Sendable {
    public let edges: [NearDupEdge]
    public let nextCursor: String?

    public init(edges: [NearDupEdge] = [], nextCursor: String? = nil) {
        self.edges = edges
        self.nextCursor = nextCursor
    }
}

/// One near-duplicate edge — links this doc to a similar one. Carries
/// the verified Jaccard plus the two pair-exclusivity counters and
/// containment so the UI can surface "why" hovers without an extra
/// round-trip.
public struct NearDupEdge: Decodable, Hashable, Sendable, Identifiable {
    public var id: String {
        otherDocId
    }

    public let otherDocId: String
    public let otherTitle: String
    public let otherSourceId: String
    public let otherDocType: String
    /// `source_url` from the other doc — preferred over the in-app
    /// viewer when the provider published one.
    public let otherSourceUrl: String?
    /// Native-app deep link for the other doc, preferred on mobile.
    public let otherAppUrl: String?
    public let jaccard: Double
    public let pairUniqueDf2: Int
    public let pairUniqueDf5: Int
    public let containmentMin: Double
    public let gateFamily: String
}

/// Graph-walker neighbourhood for one document — the `GET
/// /documents/:id/graph` payload. The portal consumes the full vertex /
/// edge graph; iOS only needs the `analytics-row` vertices to surface
/// the cross-store `same-entity` doc↔row edge, so we decode the
/// vertex list and ignore `edges` / `stats`.
public struct DocumentGraph: Decodable, Sendable {
    public let vertices: [GraphVertex]

    public init(vertices: [GraphVertex] = []) {
        self.vertices = vertices
    }

    enum CodingKeys: String, CodingKey { case vertices }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        vertices = try container.decodeIfPresent([GraphVertex].self, forKey: .vertices) ?? []
    }

    /// The bound DuckDB analytics rows attached to this document — the
    /// `same-entity` neighbours. Mirrors `useBoundRows`'s filter in the
    /// portal's `graph-card.js`.
    public var boundRows: [GraphVertex] {
        vertices.filter { $0.kind == "analytics-row" }
    }
}

/// One vertex of the document graph. We decode only the fields the
/// "Same entity" row needs — the analytics row's table name, primary
/// key, and the freeform row payload (DuckDB column → value). All other
/// vertex kinds (document, person) decode too but carry only `kind`.
public struct GraphVertex: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let tableName: String?
    public let tableDisplayName: String?
    public let rowPrimaryKey: String?
    /// Raw DuckDB row — column name → value. Numbers, strings, nulls
    /// arrive untyped, so we keep them as `JSONValue` and stringify at
    /// render time.
    public let row: [String: JSONValue]?

    public init(
        id: String,
        kind: String,
        tableName: String? = nil,
        tableDisplayName: String? = nil,
        rowPrimaryKey: String? = nil,
        row: [String: JSONValue]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.tableName = tableName
        self.tableDisplayName = tableDisplayName
        self.rowPrimaryKey = rowPrimaryKey
        self.row = row
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, tableName, tableDisplayName, rowPrimaryKey, row
    }

    /// Best-effort display label for the bound row: the table's display
    /// name, then its raw name, then a generic fallback. Mirrors the
    /// portal's `tableDisplayName || tableName || "analytics row"`.
    public var tableLabel: String {
        if let display = tableDisplayName, !display.isEmpty { return display }
        if let name = tableName, !name.isEmpty { return name }
        return "analytics row"
    }

    /// Up to `limit` headline `column: value` pairs from the row, with
    /// the `id` join-key column skipped (it's the join key, not info).
    /// Order is not guaranteed across decodes, so we sort by column name
    /// for a stable render. Mirrors `BoundRowRow`'s field selection.
    public func headlineFields(limit: Int = 4) -> [(key: String, value: String)] {
        guard let row else { return [] }
        return row
            .filter { $0.key != "id" }
            .sorted { $0.key < $1.key }
            .prefix(limit)
            .map { (key: $0.key, value: $0.value.displayString) }
    }
}

/// Attachment child doc surfaced on `GET /documents/:id/attachments`.
public struct DocumentAttachment: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let externalId: String
    public let title: String
    public let attachmentId: String
    public let mimeType: String?
    public let sizeBytes: Int64?
    public let pages: Int?
    public let truncated: Bool?
    /// `source_url` from the attachment's stored row — preferred over
    /// the in-app viewer when the provider published one.
    public let sourceUrl: String?
    /// Native-app deep link preferred on mobile clients.
    public let appUrl: String?
}

/// Wire shape of `GET /documents/:id/trail` — the `EventTrail` the
/// gateway builds by walking the link graph out from one seed document.
/// Identical to the agent's `trace_connections` tool result, so the typed
/// `AgentTrailEvent` rows feed straight into `TrailTimelineView`. The
/// `stats` payload stays untyped (nothing in the UI consumes it).
public struct DocumentEventTrail: Decodable, Sendable, Equatable {
    public let seeds: [String]
    public let events: [AgentTrailEvent]
    public let truncated: Bool

    enum CodingKeys: String, CodingKey {
        case seeds, events, truncated
    }

    public init(seeds: [String] = [], events: [AgentTrailEvent] = [], truncated: Bool = false) {
        self.seeds = seeds
        self.events = events
        self.truncated = truncated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seeds = try container.decodeIfPresent([String].self, forKey: .seeds) ?? []
        events = try container.decodeIfPresent([AgentTrailEvent].self, forKey: .events) ?? []
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

// MARK: - /status snapshot

/// Subset of `GET /status` we render on iOS — the rest of the
/// response (analytics catalog summaries, model statuses, etc.) is
/// decoded but not exposed.
public struct StatusSnapshot: Decodable, Sendable {
    public let documents: Documents
    /// The main database file alone. Kept for gateways that predate `diskUsage`.
    public let dbSizeBytes: Int64?
    /// Everything the gateway keeps on disk. `nil` from a gateway that predates
    /// the field, or before its first measurement finishes.
    public let diskUsage: DiskUsage?
    public let latestActivityBySource: [String: LatestActivity]?
    /// Whether the gateway runs in experimental mode (`OMNESIS_EXPERIMENTAL`
    /// or synthetic mode). Gates not-yet-battle-tested UI such as the Watches
    /// menu entry. Decoded leniently: an older
    /// gateway that omits the field reads as `false`, so the experimental UI
    /// stays hidden rather than crashing the decode.
    public let experimental: Bool
    /// Whether the gateway runs in developer mode (`OMNESIS_DEV_MODE`). Separate
    /// from experimental; gates the developer-annotation capture affordance
    /// (shake-to-annotate). Decoded leniently — an older gateway that omits the
    /// field reads as `false`, so the affordance stays hidden.
    public let developer: Bool
    /// The Omnesis Briefs feature gate (experimental). `nil` from a
    /// gateway that predates the feature — reads as inactive, so the
    /// Briefs entry stays hidden.
    public let briefs: BriefsStatus?

    public init(
        documents: Documents,
        dbSizeBytes: Int64?,
        diskUsage: DiskUsage? = nil,
        latestActivityBySource: [String: LatestActivity]?,
        experimental: Bool = false,
        developer: Bool = false,
        briefs: BriefsStatus? = nil
    ) {
        self.documents = documents
        self.dbSizeBytes = dbSizeBytes
        self.diskUsage = diskUsage
        self.latestActivityBySource = latestActivityBySource
        self.experimental = experimental
        self.developer = developer
        self.briefs = briefs
    }

    private enum CodingKeys: String, CodingKey {
        case documents
        case dbSizeBytes
        case diskUsage
        case latestActivityBySource
        case experimental
        case developer
        case briefs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        documents = try c.decode(Documents.self, forKey: .documents)
        dbSizeBytes = try c.decodeIfPresent(Int64.self, forKey: .dbSizeBytes)
        diskUsage = try c.decodeIfPresent(DiskUsage.self, forKey: .diskUsage)
        latestActivityBySource = try c.decodeIfPresent(
            [String: LatestActivity].self, forKey: .latestActivityBySource
        )
        experimental = try c.decodeIfPresent(Bool.self, forKey: .experimental) ?? false
        developer = try c.decodeIfPresent(Bool.self, forKey: .developer) ?? false
        briefs = try c.decodeIfPresent(BriefsStatus.self, forKey: .briefs)
    }

    /// What the "on disk" stat shows: the gateway's whole footprint, or the
    /// main database alone from a gateway that does not report one.
    public var onDiskBytes: Int64? {
        diskUsage?.totalBytes ?? dbSizeBytes
    }

    /// The total of `GET /status`'s `diskUsage`; the per-store breakdown is
    /// not rendered here.
    public struct DiskUsage: Decodable, Sendable {
        public let totalBytes: Int64

        public init(totalBytes: Int64) {
            self.totalBytes = totalBytes
        }

        private enum CodingKeys: String, CodingKey {
            case totalBytes
        }
    }

    public struct Documents: Decodable, Sendable {
        public let total: Int
        public let bySource: [String: Int]
        public let unitCountBySource: [String: Int?]?
    }

    /// One entry of `latestActivityBySource`. Mirrors
    /// `LatestActivity` in `packages/gateway/src/data/types.ts:132`.
    public struct LatestActivity: Decodable, Sendable {
        public let kind: String // "document" | "analytics"
        public let docId: String?
        public let title: String?
        public let latestActivityAt: String
        public let sourceCreatedAt: String?
        public let ingestedAt: String?
        public let isNew: Bool?
        public let tableName: String?
        public let tableDisplayName: String?
    }
}

// MARK: - /index/stats

/// Subset of `GET /index/stats` we surface on iOS. The portal renders
/// model details and watermark; we do the same.
public struct IndexStats: Decodable, Sendable {
    public let enabled: Bool
    public let state: String? // "running" | "disabled" | "model-missing"
    public let totalIndexed: Int?
    /// Documents the indexer terminally errored (un-embeddable/unreachable).
    /// Folded into completion so a fully-attempted corpus reads 100%.
    public let totalIndexErrors: Int?
    public let totalChunks: Int?
    public let watermark: String?
    public let model: Model?
    public let bySource: [String: BySource]?

    public struct Model: Decodable, Sendable {
        public let name: String?
        public let path: String?
        public let present: Bool?
    }

    public struct BySource: Decodable, Sendable {
        public let indexedDocs: Int?
        public let gatewayDocs: Int?
        public let chunks: Int?
        public let percentIndexed: Double?
        public let indexErrors: Int?
        public let earliestIndexedDate: String?
        public let latestIndexedDate: String?
    }
}

// MARK: - People

/// One row of `GET /people`. Mirrors `PersonSummary` in
/// `packages/gateway/src/people.ts:98`.
public struct PersonSummary: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let canonicalName: String
    public let source: String
    public let isSelf: Bool
    public let aliasCount: Int
    public let documentCount: Int
    public let firstSeen: String?
    public let lastSeen: String?
    public let inboundCount: Int?
    public let outboundCount: Int?
    public let interactionScoreRecent: Double?
    public let sourceIds: [String]?
}

/// `GET /people/stats` — the People list view's summary counts. Mirrors
/// `PeopleStats` in `packages/gateway/src/people.ts`. The People screen
/// reads `pendingMergeCandidates` / `mergeRules` to label its two
/// merge-shortcut buttons.
public struct PeopleStats: Decodable, Hashable, Sendable {
    public let totalPeople: Int
    public let totalAliases: Int
    public let totalLinks: Int
    public let selfDetected: Bool
    public let pendingMergeCandidates: Int
    public let mergeRules: Int
}

/// Full record from `GET /people/:id`. Mirrors `PersonDetail` in
/// `packages/gateway/src/data/repositories/PersonRepository.ts`.
public struct PersonDetail: Decodable, Sendable {
    public let id: String
    public let canonicalName: String
    public let source: String
    public let isSelf: Bool
    public let firstSeen: String?
    public let lastSeen: String?
    public let aliases: [PersonAlias]
    public let aliasesOwn: [PersonAlias]?
    public let inboundCount: Int?
    public let outboundCount: Int?
    public let interactionScore: Double?
    public let interactionScoreRecent: Double?
    public let inboundScoreRecent: Double?
    public let outboundScoreRecent: Double?
    /// Non-nil only on a logical-merge loser row — points at the
    /// canonical that absorbed this identity.
    public let mergedInto: String?
    public let mergedIntoCanonicalName: String?
    /// People logically merged INTO this canonical. Empty on losers
    /// (the gateway doesn't recurse to grandchildren).
    public let mergedFrom: [MergedFromPerson]?

    public init(
        id: String,
        canonicalName: String,
        source: String,
        isSelf: Bool,
        firstSeen: String?,
        lastSeen: String?,
        aliases: [PersonAlias],
        aliasesOwn: [PersonAlias]?,
        inboundCount: Int?,
        outboundCount: Int?,
        interactionScore: Double?,
        interactionScoreRecent: Double?,
        inboundScoreRecent: Double?,
        outboundScoreRecent: Double?,
        mergedInto: String? = nil,
        mergedIntoCanonicalName: String? = nil,
        mergedFrom: [MergedFromPerson]? = nil
    ) {
        self.id = id
        self.canonicalName = canonicalName
        self.source = source
        self.isSelf = isSelf
        self.firstSeen = firstSeen
        self.lastSeen = lastSeen
        self.aliases = aliases
        self.aliasesOwn = aliasesOwn
        self.inboundCount = inboundCount
        self.outboundCount = outboundCount
        self.interactionScore = interactionScore
        self.interactionScoreRecent = interactionScoreRecent
        self.inboundScoreRecent = inboundScoreRecent
        self.outboundScoreRecent = outboundScoreRecent
        self.mergedInto = mergedInto
        self.mergedIntoCanonicalName = mergedIntoCanonicalName
        self.mergedFrom = mergedFrom
    }
}

/// One row of `mergedFrom` — a person that was logically merged into
/// the canonical. Mirrors `MergedFromPerson` in the gateway's
/// `PersonRepository.ts`.
public struct MergedFromPerson: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let canonicalName: String
    public let aliases: [PersonAlias]
    public let inboundCount: Int
    public let outboundCount: Int
    /// ISO timestamp the merge took effect.
    public let appliedAt: String
    /// Distinct source-ids that contributed an alias or document to
    /// this loser specifically (pre-merge state) — drives the row's
    /// source-icon strip.
    public let sourceIds: [String]

    public init(
        id: String,
        canonicalName: String,
        aliases: [PersonAlias],
        inboundCount: Int,
        outboundCount: Int,
        appliedAt: String,
        sourceIds: [String]
    ) {
        self.id = id
        self.canonicalName = canonicalName
        self.aliases = aliases
        self.inboundCount = inboundCount
        self.outboundCount = outboundCount
        self.appliedAt = appliedAt
        self.sourceIds = sourceIds
    }
}

/// One row of `GET /people/:id/documents`. The doc preview is fetched
/// separately via `getDocument(id:)` when the user taps through.
public struct PersonDocumentEntry: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let roles: [String]
}

/// One operator-visible merge rule. Mirrors `MergeRuleWithResolved` in
/// `packages/gateway/src/domain/merge/types.ts`. A rule records that one
/// pre-merge identity (`sideA`) and another (`sideB`) name the same
/// person; `winnerSide` is the survivor and the other is the loser. With
/// `resolve`+`details`+`preMerge` the gateway fills `resolvedSideA` /
/// `resolvedSideB` with the pre-merge people each side carried.
public struct MergeRule: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    /// `system` (auto-detected) or `user` (operator-issued).
    public let kind: String
    public let sideA: MergeRuleSide
    public let sideB: MergeRuleSide
    /// `a` or `b` — which side survives the merge.
    public let winnerSide: String
    public let reason: String?
    public let createdAt: String?
    /// Correlation id shared by all rules from one cluster-merge action;
    /// null for single-pair and auto-detected rules.
    public let groupId: String?
    public let resolvedSideA: [MergeRulePerson]?
    public let resolvedSideB: [MergeRulePerson]?

    public init(
        id: String,
        kind: String,
        sideA: MergeRuleSide,
        sideB: MergeRuleSide,
        winnerSide: String,
        reason: String? = nil,
        createdAt: String? = nil,
        groupId: String? = nil,
        resolvedSideA: [MergeRulePerson]? = nil,
        resolvedSideB: [MergeRulePerson]? = nil
    ) {
        self.id = id
        self.kind = kind
        self.sideA = sideA
        self.sideB = sideB
        self.winnerSide = winnerSide
        self.reason = reason
        self.createdAt = createdAt
        self.groupId = groupId
        self.resolvedSideA = resolvedSideA
        self.resolvedSideB = resolvedSideB
    }
}

/// One alias side of a merge rule — the (aliasType, alias) tuple the
/// rule was keyed on. Mirrors `MergeRuleSide` in the gateway.
public struct MergeRuleSide: Decodable, Hashable, Sendable {
    public let aliasType: String
    public let alias: String

    public init(aliasType: String, alias: String) {
        self.aliasType = aliasType
        self.alias = alias
    }
}

/// A person one side of a merge rule currently resolves to (pre-merge
/// view). Mirrors `ResolvedSidePerson` in the gateway. The optional
/// fields are filled only when the rule list is fetched with `details`.
public struct MergeRulePerson: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let canonicalName: String
    public let aliases: [MergeRuleSide]?
    public let sourceIds: [String]?
    /// When this row is the merged loser, the canonical's display name.
    public let mergedIntoCanonicalName: String?

    public init(
        id: String,
        canonicalName: String,
        aliases: [MergeRuleSide]? = nil,
        sourceIds: [String]? = nil,
        mergedIntoCanonicalName: String? = nil
    ) {
        self.id = id
        self.canonicalName = canonicalName
        self.aliases = aliases
        self.sourceIds = sourceIds
        self.mergedIntoCanonicalName = mergedIntoCanonicalName
    }
}

public struct MergeRuleGroupsPage: Decodable, Sendable {
    public let items: [MergeRuleGroup]
    public let pageInfo: PageInfo
}

public struct MergeRuleGroup: Decodable, Identifiable, Sendable {
    public var id: String {
        key
    }

    public let key: String
    public let person: MergeRulePerson?
    public let name: String
    public let canonicalEmail: String?
    public let sourceIds: [String]
    public let kinds: [String]
    public let ruleIds: [String]
    public let groupIds: [String]
    public let latest: String?
    public let sources: [MergeRuleGroupSource]
}

public struct MergeRuleGroupSource: Decodable, Identifiable, Sendable {
    public var id: String {
        ruleId
    }

    public let ruleId: String
    public let groupId: String?
    public let alias: String
    public let aliasType: String
    public let name: String?
    public let personId: String?
    public let sourceIds: [String]
    public let when: String?
    public let reason: String?
}

// MARK: - People merge candidates

/// `GET /people/merge-candidates` response — the canonical `Page<T>`
/// envelope plus an endpoint-specific `counts` block. Mirrors the portal's
/// payload (`{ items, pageInfo, counts }`).
public struct MergeCandidatesPage: Decodable, Sendable {
    public let items: [MergeCandidate]
    public let counts: MergeCandidateCounts
    public let pageInfo: PageInfo

    public init(
        items: [MergeCandidate],
        counts: MergeCandidateCounts,
        pageInfo: PageInfo? = nil
    ) {
        self.items = items
        self.counts = counts
        self.pageInfo = pageInfo ?? .exhausted(limit: items.count)
    }

    private enum CodingKeys: String, CodingKey {
        case items, counts, pageInfo
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        items = try container.decodeIfPresent([MergeCandidate].self, forKey: .items) ?? []
        counts = try container.decode(MergeCandidateCounts.self, forKey: .counts)
        pageInfo = try container.decodeIfPresent(PageInfo.self, forKey: .pageInfo)
            ?? .exhausted(limit: items.count)
    }
}

/// pending / accepted / denied totals for the review queue's stats bar.
public struct MergeCandidateCounts: Decodable, Hashable, Sendable {
    public let pending: Int
    public let accepted: Int
    public let denied: Int

    public init(pending: Int, accepted: Int, denied: Int) {
        self.pending = pending
        self.accepted = accepted
        self.denied = denied
    }
}

/// One enriched merge candidate — a probable-duplicate pair the detector
/// surfaced. Mirrors the gateway's enriched candidate row: `clusterId`
/// groups pairs into one connected-component decision, and `resolvedSideA` /
/// `resolvedSideB` carry the people each side resolves to (the cluster card
/// is built by unioning these across a cluster's candidates). Only the
/// fields the review UI consumes are decoded.
public struct MergeCandidate: Decodable, Identifiable, Hashable, Sendable {
    public let id: String
    public let clusterId: String?
    public let resolvedSideA: [MergeRulePerson]
    public let resolvedSideB: [MergeRulePerson]

    public init(
        id: String,
        clusterId: String? = nil,
        resolvedSideA: [MergeRulePerson] = [],
        resolvedSideB: [MergeRulePerson] = []
    ) {
        self.id = id
        self.clusterId = clusterId
        self.resolvedSideA = resolvedSideA
        self.resolvedSideB = resolvedSideB
    }

    enum CodingKeys: String, CodingKey {
        case id, clusterId, resolvedSideA, resolvedSideB
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        clusterId = try container.decodeIfPresent(String.self, forKey: .clusterId)
        resolvedSideA = try container.decodeIfPresent([MergeRulePerson].self, forKey: .resolvedSideA) ?? []
        resolvedSideB = try container.decodeIfPresent([MergeRulePerson].self, forKey: .resolvedSideB) ?? []
    }
}

/// Result of `POST /people/merge-candidates/merge-cluster`. Mirrors
/// `MergeClusterResult` in `packages/gateway/src/merge-candidates.ts`.
public struct MergeClusterResult: Decodable, Sendable {
    /// Number of `kind='user'` rules created to unify the people.
    public let rulesCreated: Int
    /// The surviving canonical the others were bridged to (null when nothing merged).
    public let anchorId: String?
    /// Correlation id stamped on every rule the call created (null when none).
    public let groupId: String?

    public init(rulesCreated: Int, anchorId: String? = nil, groupId: String? = nil) {
        self.rulesCreated = rulesCreated
        self.anchorId = anchorId
        self.groupId = groupId
    }
}
