// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Client for the gateway's `/briefs/*` surface — the Omnesis Briefs
/// awareness feed (experimental). Same shape as the other admin clients:
/// same dispatch helper, same `GatewayClient.Error` translation.
///
/// Feed reads and user triage are available whenever experimental mode is
/// enabled. Agent-driven actions still require a runnable background model.
public final class BriefsClient: Sendable {
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

    /// `GET /briefs/feed` — the ranked feed, first entry on top. An
    /// empty array is the "no briefs to show" state (never padded).
    public func feed(limit: Int = 30, cursor: String? = nil) async throws -> BriefPage {
        var components = URLComponents()
        components.path = "/briefs/feed"
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "cursor", value: cursor),
        ].filter { $0.value != nil }
        let (data, _) = try await dispatch(
            method: "GET",
            path: components.string ?? "/briefs/feed",
            body: nil
        )
        return try decodeOrThrow(BriefPage.self, from: data)
    }

    /// `GET /briefs/count` — the number of showable UNREAD briefs, for
    /// the drawer's awaiting-attention badge. A cheap counterpart to
    /// `feed()`: it never returns the briefs themselves, so the badge
    /// renders without fetching the full feed. 404s (→ `.notFound`) when
    /// experimental mode is disabled, exactly like `feed()`.
    public func unreadCount() async throws -> Int {
        let (data, _) = try await dispatch(method: "GET", path: "/briefs/count", body: nil)
        struct Wrap: Decodable { let unread: Int }
        return try decodeOrThrow(Wrap.self, from: data).unread
    }

    /// `POST /briefs/:id/read` — mark a brief seen (`unread` → `read`).
    /// Sent once per brief the user actually views, so `read` briefs
    /// sort last on return visits. Idempotent on an already-read brief;
    /// a dismissed one answers 409 (surfaced as `serverError(status:
    /// 409, …)`).
    public func markRead(briefId: String) async throws {
        _ = try await dispatch(
            method: "POST",
            path: "/briefs/\(percentEncode(briefId))/read",
            body: nil
        )
    }

    /// `POST /briefs/:id/dismiss` — synchronously flip the brief into
    /// its `dismissed_*` state and enqueue the async feedback run the
    /// Cognition Steward reacts with. The gateway's body schema is strict:
    /// `feedback` and `snoozeUntil` are omitted (never null) when
    /// absent, and `snoozeUntil` is only valid with reason `.snoozed`
    /// (absent there = "the agent decides").
    public func dismiss(
        briefId: String,
        reason: BriefDismissReason,
        feedback: String? = nil,
        snoozeUntil: Date? = nil
    ) async throws {
        struct Body: Encodable {
            let reason: String
            let feedback: String?
            let snoozeUntil: String?
        }
        let body = try encoder.encode(
            Body(
                reason: reason.rawValue,
                feedback: feedback,
                snoozeUntil: snoozeUntil.map { BriefRecord.isoString(from: $0) }
            )
        )
        _ = try await dispatch(
            method: "POST",
            path: "/briefs/\(percentEncode(briefId))/dismiss",
            body: body
        )
    }

    /// The result of opening a brief's talk-back thread.
    public struct OpenThreadResult: Decodable, Equatable, Sendable {
        /// The conversation to resume via the agent session flow.
        public let conversationId: String
        /// False when the brief already had a thread and it was reused.
        public let created: Bool

        public init(conversationId: String, created: Bool) {
            self.conversationId = conversationId
            self.created = created
        }
    }

    /// `POST /briefs/:id/thread` — open (or return) the brief's talk-back
    /// thread: a conversation seeded with the transcript of the loop-agent
    /// run that created the brief. Idempotent — one thread per brief; the
    /// returned conversation id feeds the normal agent resume flow. 404
    /// (→ `.notFound`) for an unknown brief or when the feature is
    /// inactive; 409 (→ `serverError(status: 409, …)`) when the agent
    /// harness or background-agent model is unavailable.
    public func openThread(briefId: String) async throws -> OpenThreadResult {
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/briefs/\(percentEncode(briefId))/thread",
            body: nil
        )
        return try decodeOrThrow(OpenThreadResult.self, from: data)
    }

    // MARK: - Internals

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
        case 200 ... 299: return (data, http)
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        case 404: throw GatewayClient.Error.notFound
        default:
            let text = String(data: data, encoding: .utf8) ?? ""
            throw GatewayClient.Error.serverError(status: http.statusCode, body: text)
        }
    }

    private func decodeOrThrow<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try decoder.decode(type, from: data) } catch { throw GatewayClient.Error.decoding("\(error)") }
    }

    private func percentEncode(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? raw
    }
}

public struct BriefPage: Decodable, Sendable {
    public let briefs: [BriefRecord]
    public let pageInfo: PageInfo

    public init(briefs: [BriefRecord], pageInfo: PageInfo? = nil) {
        self.briefs = briefs
        self.pageInfo = pageInfo ?? .exhausted(limit: briefs.count)
    }

    private enum CodingKeys: String, CodingKey {
        case briefs, pageInfo
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        briefs = try container.decodeIfPresent([BriefRecord].self, forKey: .briefs) ?? []
        pageInfo = try container.decodeIfPresent(PageInfo.self, forKey: .pageInfo)
            ?? .exhausted(limit: briefs.count)
    }
}

// MARK: - Wire types

/// A brief's kind. `info` briefs surface context worth knowing and are
/// cleared by acknowledging them; `loop` briefs are attached to tracked
/// open loops, and clearing one reports it handled — which propagates
/// into resolving the underlying open loop. This semantic difference is
/// what `clearActionReason` encodes; clients render their own wording.
public enum BriefKind: String, Decodable, Sendable {
    case info
    case loop
}

extension BriefKind {
    /// The dismiss reason a "clear this brief" action reports for this
    /// kind — `alreadyHandled` for a loop brief, `acknowledged` for an
    /// info brief. The gateway enforces this pairing with a 400, so this
    /// is the single source of truth shared by every clear surface.
    var clearActionReason: BriefDismissReason {
        switch self {
        case .loop: .alreadyHandled
        case .info: .acknowledged
        }
    }
}

/// The two states the feed ever returns — dismissed briefs are never
/// shown (`read` briefs sort last, server-side).
public enum BriefReadState: String, Decodable, Sendable {
    case unread
    case read
}

/// The dismiss modal's reasons, as the gateway spells them.
/// `alreadyHandled` applies only to loop-kind briefs and `acknowledged`
/// only to info-kind (the gateway enforces the pairing with a 400);
/// `snoozed` is the one non-terminal exit and may carry a user-picked
/// re-surface time.
public enum BriefDismissReason: String, Sendable, CaseIterable {
    case notRelevant = "not_relevant"
    case wrong
    case alreadyHandled = "already_handled"
    case acknowledged
    case snoozed
}

/// One display-ready citation on a brief: `docId` opens the in-app
/// document view; `sourceId` drives the source icon.
public struct BriefCitation: Decodable, Equatable, Sendable, Identifiable {
    public let docId: String
    public let title: String
    public let providerId: String
    public let sourceId: String

    public var id: String {
        docId
    }

    public init(docId: String, title: String, providerId: String, sourceId: String) {
        self.docId = docId
        self.title = title
        self.providerId = providerId
        self.sourceId = sourceId
    }
}

/// One ranked feed entry from `GET /briefs/feed`. Timestamps arrive as
/// ISO-8601 strings (the gateway's `toISOString()`); use the `*Date`
/// accessors to parse for display.
public struct BriefRecord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let kind: BriefKind
    public let state: BriefReadState
    public let title: String
    /// Short, glanceable description (<30 words by contract).
    public let description: String
    /// Optional long-form context revealed on scroll-down; nil = none.
    public let body: String?
    public let confidence: Double
    public let urgency: Double
    public let createdAt: String
    /// When the real-world event the brief concerns happens, if any.
    public let eventAt: String?
    /// After this instant the brief stops being shown; nil = no bound.
    public let relevantUntil: String?
    public let citations: [BriefCitation]
    /// The brief's talk-back thread, once one has been opened; nil until
    /// then. `openThread(briefId:)` is idempotent either way — the app
    /// never needs to branch on this to offer the affordance.
    public let threadConversationId: String?

    public init(
        id: String,
        kind: BriefKind,
        state: BriefReadState,
        title: String,
        description: String,
        body: String?,
        confidence: Double,
        urgency: Double,
        createdAt: String,
        eventAt: String?,
        relevantUntil: String?,
        citations: [BriefCitation],
        threadConversationId: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.state = state
        self.title = title
        self.description = description
        self.body = body
        self.confidence = confidence
        self.urgency = urgency
        self.createdAt = createdAt
        self.eventAt = eventAt
        self.relevantUntil = relevantUntil
        self.citations = citations
        self.threadConversationId = threadConversationId
    }

    public var createdAtDate: Date? {
        Self.date(from: createdAt)
    }

    public var eventAtDate: Date? {
        eventAt.flatMap { Self.date(from: $0) }
    }

    /// Gateway timestamps are `Date.toISOString()` — fractional-seconds
    /// UTC. Tolerate a plain internet date-time too.
    public static func date(from iso: String) -> Date? {
        isoFractional.date(from: iso) ?? isoPlain.date(from: iso)
    }

    /// Serialize an instant the way the gateway expects (`snoozeUntil`).
    static func isoString(from date: Date) -> String {
        isoPlain.string(from: date)
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}

/// The part of the gateway's `BriefsFeatureStatus` — the `briefs` field on
/// `GET /status` — that the app acts on. The gateway also publishes a prose
/// `reason` and a `visible` permission for surfaces that show the feature
/// without being able to run it; the app reads neither, and unknown keys
/// decode past this struct.
public struct BriefsStatus: Decodable, Equatable, Sendable {
    /// The operator switched Omnesis Briefs on.
    public let enabled: Bool
    /// A background-agent model is assigned and its backend can actually run.
    public let modelAssigned: Bool
    /// The background engine runs: `enabled` AND a runnable model.
    public let active: Bool

    public init(enabled: Bool, modelAssigned: Bool, active: Bool) {
        self.enabled = enabled
        self.modelAssigned = modelAssigned
        self.active = active
    }

    private enum CodingKeys: String, CodingKey {
        case enabled
        case modelAssigned
        case active
    }

    /// `enabled` is decoded leniently: a gateway that predates the field
    /// cannot say whether a missing model is a fault, so the app treats the
    /// feature as switched off and shows no entry rather than a guess.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        modelAssigned = try c.decode(Bool.self, forKey: .modelAssigned)
        active = try c.decode(Bool.self, forKey: .active)
    }
}

/// What the navigation menu shows for Omnesis Briefs.
///
/// The menu names destinations and flags which ones need attention; it never
/// carries diagnostic prose. Telling the blocked states apart is this type's
/// job rather than the view's, because they are not the same product
/// situation: on an install that asked for Briefs, a background-agent model
/// that cannot run is the operator's to fix and keeps a marked entry, while an
/// install that only previews the feature has nothing to act on and shows no
/// entry at all.
///
/// What is wrong with the model, and the repair, live on Settings → Models
/// against the Background agent capability — the one surface that states every
/// capability's readiness and can change it.
public enum BriefsMenuEntry: Equatable {
    /// No entry: the feature is switched off, or shown only as a preview.
    case hidden
    /// A normal destination — the engine runs and the feed answers.
    case available
    /// A marked destination: the feed remains available, but its
    /// background-agent model is unassigned or its backend cannot run.
    case needsAttention

    /// Derive the entry from `GET /status`. A `nil` status is a gateway that
    /// predates the field, which reads as no feature rather than a fault.
    ///
    /// `enabled` is the feed-access contract. Model readiness only decides
    /// whether the destination carries its attention warning.
    public init(status: BriefsStatus?) {
        guard let status else {
            self = .hidden
            return
        }
        guard status.enabled else {
            self = .hidden
            return
        }
        self = status.modelAssigned ? .available : .needsAttention
    }

    /// Both visible states open the feed. Keeping this policy here prevents a
    /// warning from turning the destination itself into a settings shortcut.
    public var destination: BriefsMenuDestination? {
        switch self {
        case .hidden: nil
        case .available, .needsAttention: .feed
        }
    }
}

public enum BriefsMenuDestination: Equatable {
    case feed
}
