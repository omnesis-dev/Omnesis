// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Read-only client for the gateway's `/admin/watch/*` surface.
///
/// Read-only on purpose, and not a temporary shape. A watch is authored as a
/// DSL document and installed by the operator at a terminal; the phone is where
/// you find out what a watch has been doing, which is a different job from
/// writing one. Editing a watch from a phone would mean rendering a graph
/// editor for a language whose whole point is that it is exact.
///
/// Same dispatch helper and error translation as the other admin clients, kept
/// separate because the two object graphs have nothing to do with each other.
public final class WatchesClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSessionLike
    private let decoder: JSONDecoder

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.decoder = JSONDecoder()
    }

    /// `GET /admin/watch/watches` — every watch the runtime knows.
    public func listWatches() async throws -> [WatchRecord] {
        let (data, _) = try await dispatch(method: "GET", path: "/admin/watch/watches")
        struct Wrap: Decodable { let watches: [WatchRecord] }
        return try decodeOrThrow(Wrap.self, from: data).watches
    }

    /// `GET /admin/watch/watches/:id` — one watch in full, definition included.
    ///
    /// Separate from `listWatches` because the listing deliberately omits the
    /// definition: it is by far the largest field a watch has and that list is
    /// polled. This is the read for someone who has asked to see it.
    public func fetchDefinition(watchId: String) async throws -> String {
        let path = "/admin/watch/watches/\(percentEncode(watchId))"
        let (data, _) = try await dispatch(method: "GET", path: path)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let watch = root["watch"] as? [String: Any],
              let dsl = watch["dsl"]
        else {
            throw GatewayClient.Error.decoding("the watch came back without its definition")
        }
        // Re-encoded here rather than passed through: the bytes on the wire are
        // compact, and what a person opens this to read is the shape.
        let pretty = try JSONSerialization.data(
            withJSONObject: dsl,
            options: [.prettyPrinted, .sortedKeys]
        )
        guard let text = String(data: pretty, encoding: .utf8) else {
            throw GatewayClient.Error.decoding("the definition could not be rendered as text")
        }
        return text
    }

    /// `GET /admin/watch/watches/:id` — what this watch is allowed to say, and
    /// to whom.
    ///
    /// Its own read because the listing carries only the summary: who asked for
    /// the watch and who it wakes, which is all a row needs. The record behind
    /// it — what the operator approved, whether that approval still stands, when
    /// it expires — is the watch's own page, and this is where that page gets
    /// it. Nil for a watch that wakes nobody, which is most of them and a
    /// complete answer rather than a missing one.
    public func fetchDisclosure(watchId: String) async throws -> WatchDisclosure? {
        let path = "/admin/watch/watches/\(percentEncode(watchId))"
        let (data, _) = try await dispatch(method: "GET", path: path)
        struct Disclosed: Decodable { let disclosure: WatchDisclosure? }
        struct Wrap: Decodable { let watch: Disclosed }
        return try decodeOrThrow(Wrap.self, from: data).watch.disclosure
    }

    /// `GET /admin/watch/watches/:id/firings` — what one watch has said.
    public func listFirings(watchId: String, limit: Int = 50) async throws -> [WatchFiringRecord] {
        let path = "/admin/watch/watches/\(percentEncode(watchId))/firings?limit=\(limit)"
        let (data, _) = try await dispatch(method: "GET", path: path)
        struct Wrap: Decodable { let firings: [WatchFiringRecord] }
        return try decodeOrThrow(Wrap.self, from: data).firings
    }

    // MARK: - Internals

    private func dispatch(method: String, path: String) async throws -> (Data, HTTPURLResponse) {
        guard let requestURL = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299: return (data, http)
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        // The whole surface 404s when the gateway is not in experimental mode,
        // which is indistinguishable from a watch that does not exist — and
        // deliberately so on the gateway side. The screen reads both as "no
        // watches", which is true either way.
        case 404: throw GatewayClient.Error.notFound
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
}

// MARK: - Wire types

/// One watch, as the listing reports it.
///
/// Every field is what an operator needs to answer "is this thing working" —
/// deliberately not the DSL. A watch's definition is exact and long, and a
/// phone is where you check on a watch rather than read one.
public struct WatchRecord: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    /// `active`, `paused` or `retired`. Carried as a raw string so a state a
    /// newer gateway knows about passes through instead of failing the decode.
    public let status: String
    public let firings: Int
    /// Why it is paused or retired, when there is a why.
    public let note: String?
    /// What the watch is for, in the words of whoever wrote it. Absent on a
    /// watch whose DSL carries no `nl_query`.
    public let request: String?
    /// Where a firing goes: `omnesis-notify`, `agent-wake`, or nil for a watch
    /// that delivers nowhere — which is a real setting rather than a missing
    /// value. Carried as a raw string so a kind a newer gateway knows about
    /// renders instead of failing the decode.
    public let delivery: String?
    /// What this watch discloses and to whom. Nil for a watch that wakes
    /// nobody, and nil on a gateway that predates the field.
    public let disclosure: WatchDisclosure?
    /// Whether the watch is any good, and the numbers that say so. Nil on a
    /// gateway that predates the field — a row without one renders as a row.
    public let verdict: WatchVerdict?

    public init(
        id: String,
        name: String,
        status: String,
        firings: Int,
        note: String?,
        request: String?,
        delivery: String? = nil,
        disclosure: WatchDisclosure? = nil,
        verdict: WatchVerdict? = nil
    ) {
        self.id = id
        self.name = name
        self.status = status
        self.firings = firings
        self.note = note
        self.request = request
        self.delivery = delivery
        self.disclosure = disclosure
        self.verdict = verdict
    }
}

/// What a watch's behaviour amounts to, decided by the gateway.
///
/// `name` is carried as a raw string so a verdict a newer gateway knows about
/// passes through rather than failing the decode; `because` always carries the
/// numbers it was decided from, so no surface has to recompose them.
public struct WatchVerdict: Decodable, Equatable, Sendable {
    public let name: String
    public let because: String
    /// The word for it, decided by the gateway. Nil on one that predates the
    /// field, where the raw name is still a word an operator can act on.
    public let label: String?
    /// Whether there is anything to do about it — the gateway's judgement, not
    /// a list this build was compiled with. A phone that has not been updated
    /// in a year still marks a verdict a newer gateway learned to raise, which
    /// is the whole point of asking rather than deciding. Nil reads as "no",
    /// which is what an older gateway's `healthy` and `resting` were.
    public let actionable: Bool?

    /// The word to mark a row with, or nil when the row should carry no mark.
    ///
    /// Both halves are the gateway's. A table of names on the phone would be a
    /// table of the verdicts *this build* was written against — so a phone a
    /// year behind would render no mark at all for a verdict a newer gateway
    /// learned to raise, which is silence on the one surface whose whole job is
    /// to raise it. An older gateway sends neither field, and nil reads as
    /// nothing to do, which is what its `healthy` and `resting` meant.
    public var mark: String? {
        guard actionable == true else { return nil }
        if let label, !label.isEmpty { return label }
        return name
    }

    public init(name: String, because: String, label: String? = nil, actionable: Bool? = nil) {
        self.name = name
        self.because = because
        self.label = label
        self.actionable = actionable
    }
}

/// The record that authorises a watch to wake an agent.
///
/// One type for both reads of a watch. The listing carries the four fields a
/// row needs — who asked, which record, where it stands, whom it wakes — and the
/// watch's own page carries all of it, so everything below those four is
/// optional and a caller never has to know which read produced the value.
///
/// A watch that wakes nobody has no disclosure at all. There was no egress, so
/// there is nothing to disclose and no record to read.
public struct WatchDisclosure: Codable, Equatable, Sendable {
    /// `operator` or `integration`. A raw string, so an author a newer gateway
    /// knows about does not fail the decode of the whole listing.
    public let authoredBy: String
    /// The subscription record — the egress ledger is addressed by it.
    public let subscriptionId: String
    /// Where the record stands: active, pending an approval, revoked, expired.
    public let status: String
    /// The integration woken, named as the operator named its device.
    public let integrationName: String?
    public let revision: Int?
    /// What the operator approved, in the compiler's reading of the request.
    public let interpretation: String?
    /// The condition as the record states it.
    public let condition: String?
    /// What the woken agent is asked to do.
    public let instruction: String?
    /// How much of a firing the agent may be handed: `documents` or
    /// `condition-only`.
    public let evidence: String?
    /// The approval itself, when one was asked for. Nil for an operator's own
    /// watch, where there was nothing to approve.
    public let approval: WatchDisclosureApproval?
    /// Epoch milliseconds, as the subscription store keeps its instants.
    public let expiresAt: Int64?
    public let revokedAt: Int64?
    public let policyRevision: String?
    /// How many times it has actually reached out, and when it last did.
    public let firingCount: Int?
    public let lastFiredAt: Int64?

    public init(
        authoredBy: String,
        subscriptionId: String,
        status: String,
        integrationName: String? = nil,
        revision: Int? = nil,
        interpretation: String? = nil,
        condition: String? = nil,
        instruction: String? = nil,
        evidence: String? = nil,
        approval: WatchDisclosureApproval? = nil,
        expiresAt: Int64? = nil,
        revokedAt: Int64? = nil,
        policyRevision: String? = nil,
        firingCount: Int? = nil,
        lastFiredAt: Int64? = nil
    ) {
        self.authoredBy = authoredBy
        self.subscriptionId = subscriptionId
        self.status = status
        self.integrationName = integrationName
        self.revision = revision
        self.interpretation = interpretation
        self.condition = condition
        self.instruction = instruction
        self.evidence = evidence
        self.approval = approval
        self.expiresAt = expiresAt
        self.revokedAt = revokedAt
        self.policyRevision = policyRevision
        self.firingCount = firingCount
        self.lastFiredAt = lastFiredAt
    }
}

/// The operator's decision on a watch an integration asked for.
///
/// Only where it stands is read here. The request itself — what would be
/// disclosed, by whom, under which policy — is reviewed in Privacy, which is
/// where it is decided; this page reports the outcome of that decision.
public struct WatchDisclosureApproval: Codable, Equatable, Sendable {
    /// `pending`, `approved`, `denied` or `expired`.
    public let status: String

    public init(status: String) {
        self.status = status
    }
}

/// One firing: when it happened, and what the watch carried forward.
/// What happened when a firing was delivered.
///
/// The failing case is the one worth carrying: a notification that never
/// arrived looks exactly like a watch that never fired, and this is the only
/// place that difference is written down.
public struct WatchFiringDelivery: Decodable, Equatable, Sendable {
    /// `omnesis-notify` or `agent-wake` — a free string, so an unknown kind
    /// from a newer gateway renders rather than failing to decode.
    public let kind: String
    /// How many destinations accepted it. Zero is an ordinary answer.
    public let delivered: Int
    public let attempted: Int?
    /// Why nothing arrived, when the channel could say.
    public let error: String?

    public init(kind: String, delivered: Int, attempted: Int? = nil, error: String? = nil) {
        self.kind = kind
        self.delivered = delivered
        self.attempted = attempted
        self.error = error
    }
}

/// A document the runtime read to decide a firing.
///
/// Named by the gateway rather than looked up here: a phone that had to fetch
/// each one would show a firing's evidence as a list of opaque ids until it
/// had, and would show nothing at all offline.
public struct WatchFiringDocument: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    /// The account-qualified source, e.g. `gmail:someone@example.com`.
    public let sourceId: String

    public init(id: String, title: String, sourceId: String) {
        self.id = id
        self.title = title
        self.sourceId = sourceId
    }
}

public struct WatchFiringRecord: Decodable, Equatable, Sendable, Identifiable {
    /// The journal sequence, which is what makes a firing unique within a watch.
    public let seq: Int
    /// When the thing it is about happened.
    public let firedAt: String
    /// When the runtime recorded it. Absent on a firing older than the column.
    public let noticedAt: String?
    /// What delivering it did. Absent for a watch that delivers nowhere, which
    /// is most of them — a firing with no delivery block was never sent.
    public let delivery: WatchFiringDelivery?
    /// What it read to decide. Empty for a firing with nothing behind it — a
    /// clock, a row, a deadline — and for one recorded before these were kept.
    public let documents: [WatchFiringDocument]

    public var id: Int {
        seq
    }

    public init(
        seq: Int,
        firedAt: String,
        noticedAt: String?,
        delivery: WatchFiringDelivery? = nil,
        documents: [WatchFiringDocument] = []
    ) {
        self.seq = seq
        self.firedAt = firedAt
        self.noticedAt = noticedAt
        self.delivery = delivery
        self.documents = documents
    }

    /// A firing recorded before the gateway carried documents omits the key
    /// entirely, and an older gateway never sends it. Decoding that as a
    /// failure would empty the whole screen over an absent list.
    private enum CodingKeys: String, CodingKey {
        case seq, firedAt, noticedAt, delivery, documents
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        seq = try container.decode(Int.self, forKey: .seq)
        firedAt = try container.decode(String.self, forKey: .firedAt)
        noticedAt = try container.decodeIfPresent(String.self, forKey: .noticedAt)
        delivery = try container.decodeIfPresent(WatchFiringDelivery.self, forKey: .delivery)
        documents = try container.decodeIfPresent([WatchFiringDocument].self, forKey: .documents) ?? []
    }
}
