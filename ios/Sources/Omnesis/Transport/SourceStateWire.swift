// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// The parts of the source contract this app has to read the same way the
// collector does.
//
// The phone hosts sources of its own, so it meets the same persisted state,
// the same failures and the same coverage claims. Re-deriving what those mean
// here is how three implementations of one vocabulary drift — a value the
// gateway started sending that this decoder silently reads as absent is
// invisible until a device stops reporting something.
//
// `wire-fixtures/` at the repository root holds the canonical bytes, written
// from the TypeScript definitions. `SourceStateWireTests` decodes those exact
// files, so a change on either side this decoder cannot read fails there
// rather than in someone's pocket.

/// A source's persisted state, as the gateway stores it.
///
/// Terse on purpose — it is written on every committed page — and everything
/// but the state itself is optional on the wire.
public struct StateEnvelope: Codable, Equatable, Sendable {
    /// Envelope format version. Only `1` exists; anything else is unreadable here.
    public let envelope: Int
    /// The source's own state version, which its migration chain is keyed on.
    public let version: Int
    /// Minor version within `version`; absent means zero.
    public let minorVersion: Int?
    /// The source this envelope was written for.
    public let sourceId: String?
    /// The state itself, opaque to everything but the source that wrote it.
    public let state: [String: JSONValue]

    private enum CodingKeys: String, CodingKey {
        case envelope = "e"
        case version = "v"
        case minorVersion = "m"
        case sourceId = "s"
        case state
    }
}

/// How much a failure took with it. Ordered narrow to wide.
///
/// Decoded leniently on purpose: a scope this build does not know is wider
/// than anything it does know, because the safe reading of an unfamiliar
/// failure is that more stopped working rather than less.
public enum FailureScope: String, Codable, Sendable {
    case item
    case partition
    case source
    case connection

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = FailureScope(rawValue: raw) ?? .connection
    }
}

/// What an upstream counts a rate limit against.
public enum QuotaKind: String, Codable, Sendable {
    /// Per authenticated account; other accounts are unaffected.
    case account
    /// Per registered application; every account shares one budget.
    case app
}

/// The budget a limit was counted against, when the source named one.
public struct QuotaBucket: Codable, Equatable, Sendable {
    public let kind: QuotaKind
    /// Usually absent: the host derives the bucket from the source that failed.
    public let id: String?
}

/// How much of its upstream history a source holds.
///
/// `unknown` is a real answer and not a synonym for `complete`: a source that
/// has not established whether it is missing history has not said it is whole,
/// and collapsing the two shows a corpus as complete on the strength of nobody
/// having checked. The field being absent is different again — the question
/// does not apply to that source, and it earns no line at all.
public enum HistoryCoverage: String, Codable, Sendable {
    case complete
    case partial
    case unknown
}
