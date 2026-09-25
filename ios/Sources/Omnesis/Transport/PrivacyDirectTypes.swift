// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// The wire contract of the Direct MCP audit boundary: the shapes
// `PrivacyClient` decodes for transcript sessions and their tool-call events.
//
// Mirrors the Answer boundary's split: list responses carry bounded display
// metadata only, and one event's full args/result payload is fetched on its
// own route once the owner expands that row.

// MARK: - Sessions

public struct DirectAuditSessionSummary: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let ownerId: String
    public let principalId: String
    /// Operator-approved display name, nil when the principal row is gone.
    /// A row with no name reads as "External agent".
    public let principalName: String?
    public let credentialId: String
    public let grantId: String
    /// Caller grouping key (`"conversation:<id>"` or `"workflow:<id>"`), or
    /// nil when the gateway grouped the session heuristically by activity.
    public let explicitKey: String?
    public let heuristicKey: String
    public let createdAt: Int64
    public let lastEventAt: Int64
    public let eventCount: Int

    public init(
        id: String,
        ownerId: String,
        principalId: String,
        principalName: String? = nil,
        credentialId: String,
        grantId: String,
        explicitKey: String?,
        heuristicKey: String,
        createdAt: Int64,
        lastEventAt: Int64,
        eventCount: Int
    ) {
        self.id = id
        self.ownerId = ownerId
        self.principalId = principalId
        self.principalName = principalName
        self.credentialId = credentialId
        self.grantId = grantId
        self.explicitKey = explicitKey
        self.heuristicKey = heuristicKey
        self.createdAt = createdAt
        self.lastEventAt = lastEventAt
        self.eventCount = eventCount
    }
}

public struct DirectAuditSessionList: Decodable, Equatable, Sendable {
    public let sessions: [DirectAuditSessionSummary]

    public init(sessions: [DirectAuditSessionSummary]) {
        self.sessions = sessions
    }
}

// MARK: - Events

public enum DirectAuditOutcome: String, Decodable, Equatable, Sendable {
    case ok
    case refused
    case cancelled
    case timedOut = "timed_out"
    case failed
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = DirectAuditOutcome(rawValue: raw) ?? .unknown
    }
}

public struct DirectAuditEventDisplay: Decodable, Equatable, Sendable {
    public let title: String
    public let text: String?

    public init(title: String, text: String? = nil) {
        self.title = title
        self.text = text
    }

    private enum CodingKeys: String, CodingKey {
        case title, text
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = (try? container.decodeIfPresent(String.self, forKey: .title)) ?? ""
        text = try? container.decodeIfPresent(String.self, forKey: .text)
    }
}

public struct DirectAuditEventSummary: Decodable, Equatable, Sendable, Identifiable {
    public let sequence: Int
    public let id: String
    public let sessionId: String
    public let tool: String
    public let outcome: DirectAuditOutcome
    public let requestId: String
    public let display: DirectAuditEventDisplay
    public let payloadTruncated: Bool
    public let payloadBytes: Int
    public let originalPayloadBytes: Int
    public let createdAt: Int64

    public init(
        sequence: Int,
        id: String,
        sessionId: String,
        tool: String,
        outcome: DirectAuditOutcome,
        requestId: String,
        display: DirectAuditEventDisplay,
        payloadTruncated: Bool,
        payloadBytes: Int,
        originalPayloadBytes: Int,
        createdAt: Int64
    ) {
        self.sequence = sequence
        self.id = id
        self.sessionId = sessionId
        self.tool = tool
        self.outcome = outcome
        self.requestId = requestId
        self.display = display
        self.payloadTruncated = payloadTruncated
        self.payloadBytes = payloadBytes
        self.originalPayloadBytes = originalPayloadBytes
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case sequence, id, sessionId, tool, outcome, requestId, display
        case payloadTruncated, payloadBytes, originalPayloadBytes, createdAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sequence = try container.decode(Int.self, forKey: .sequence)
        id = try container.decode(String.self, forKey: .id)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        tool = (try? container.decodeIfPresent(String.self, forKey: .tool)) ?? ""
        outcome = (try? container.decodeIfPresent(DirectAuditOutcome.self, forKey: .outcome))
            ?? .unknown
        requestId = (try? container.decodeIfPresent(String.self, forKey: .requestId)) ?? ""
        display = (try? container.decodeIfPresent(DirectAuditEventDisplay.self, forKey: .display))
            ?? DirectAuditEventDisplay(title: "")
        payloadTruncated =
            (try? container.decodeIfPresent(Bool.self, forKey: .payloadTruncated)) ?? false
        payloadBytes = (try? container.decodeIfPresent(Int.self, forKey: .payloadBytes)) ?? 0
        originalPayloadBytes =
            (try? container.decodeIfPresent(Int.self, forKey: .originalPayloadBytes)) ?? 0
        createdAt = (try? container.decodeIfPresent(Int64.self, forKey: .createdAt)) ?? 0
    }
}

public struct DirectAuditEventList: Decodable, Equatable, Sendable {
    public let events: [DirectAuditEventSummary]

    public init(events: [DirectAuditEventSummary]) {
        self.events = events
    }
}

// MARK: - Event detail

/// One tool call with its bounded args/result payload. The payload is either
/// the `{tool,args,result,outcome}` record or a
/// `{truncated,reason,originalBytes,sha256}` sentinel when a value exceeded
/// the stored size cap — both decode as `JSONValue`, and the view tells the
/// two apart by the sentinel's `truncated` flag.
public struct DirectAuditEventDetail: Decodable, Equatable, Sendable {
    public let sequence: Int
    public let id: String
    public let sessionId: String
    public let tool: String
    public let outcome: DirectAuditOutcome
    public let requestId: String
    public let display: DirectAuditEventDisplay
    public let payloadTruncated: Bool
    public let payloadBytes: Int
    public let originalPayloadBytes: Int
    public let createdAt: Int64
    public let payload: JSONValue

    public init(
        sequence: Int,
        id: String,
        sessionId: String,
        tool: String,
        outcome: DirectAuditOutcome,
        requestId: String,
        display: DirectAuditEventDisplay,
        payloadTruncated: Bool,
        payloadBytes: Int,
        originalPayloadBytes: Int,
        createdAt: Int64,
        payload: JSONValue
    ) {
        self.sequence = sequence
        self.id = id
        self.sessionId = sessionId
        self.tool = tool
        self.outcome = outcome
        self.requestId = requestId
        self.display = display
        self.payloadTruncated = payloadTruncated
        self.payloadBytes = payloadBytes
        self.originalPayloadBytes = originalPayloadBytes
        self.createdAt = createdAt
        self.payload = payload
    }
}
