// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// MARK: - Agent traces

/// One message of a stored local-generation attempt. `parts` stays loose
/// (`JSONValue`) so one malformed part cannot take the attempt with it —
/// the presentation layer skips what it cannot read.
public struct PrivacyAgentTraceMessage: Decodable, Equatable, Sendable {
    public let role: String
    public let parts: [JSONValue]
    public let type: String?

    public init(role: String, parts: [JSONValue], type: String? = nil) {
        self.role = role
        self.parts = parts
        self.type = type
    }

    /// Failable so a junk entry degrades to a skipped message, never to a
    /// lost attempt. A message without a parts array carries no tool parts;
    /// anything else still decodes with empty parts rather than failing.
    public init?(json: JSONValue) {
        guard case .object(let fields) = json else { return nil }
        role = fields["role"]?.stringValue ?? ""
        parts = fields["parts"]?.arrayValue ?? []
        if case .string(let raw) = fields["type"] {
            type = raw
        } else {
            type = nil
        }
    }

    private enum CodingKeys: String, CodingKey {
        case role, parts, type
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = (try? container.decodeIfPresent(String.self, forKey: .role)) ?? ""
        parts = (try? container.decodeIfPresent([JSONValue].self, forKey: .parts)) ?? []
        type = try? container.decodeIfPresent(String.self, forKey: .type)
    }
}

/// One bounded local-generation attempt behind an exchange, oldest first.
/// Mirrors the gateway's `PrivacyAnswerAgentTrace`: the ordinal counts
/// stored attempts including ones omitted from this view.
public struct PrivacyAgentTrace: Decodable, Equatable, Sendable {
    public let attempt: Int
    public let provider: String
    public let model: String
    public let sessionId: String
    public let messages: [PrivacyAgentTraceMessage]
    public let terminalStopReason: String?
    public let createdAt: Int64
    public let truncated: Bool
    public let omittedParts: Int?

    public init(
        attempt: Int,
        provider: String,
        model: String,
        sessionId: String,
        messages: [PrivacyAgentTraceMessage],
        terminalStopReason: String? = nil,
        createdAt: Int64,
        truncated: Bool = false,
        omittedParts: Int? = nil
    ) {
        self.attempt = attempt
        self.provider = provider
        self.model = model
        self.sessionId = sessionId
        self.messages = messages
        self.terminalStopReason = terminalStopReason
        self.createdAt = createdAt
        self.truncated = truncated
        self.omittedParts = omittedParts
    }

    /// Failable, mirroring the gateway's `parseAgentTrace`: an entry without
    /// the identifying fields or the message list is skipped rather than
    /// rendered as an anonymous attempt. One malformed message degrades to
    /// a skipped message, never to a skipped trace.
    public init?(json: JSONValue) {
        guard case .object(let fields) = json,
              case .string(let provider) = fields["provider"],
              case .string(let model) = fields["model"],
              case .string(let sessionId) = fields["sessionId"],
              let rawMessages = fields["messages"]?.arrayValue
        else { return nil }
        attempt = fields["attempt"]?.intValue ?? 0
        self.provider = provider
        self.model = model
        self.sessionId = sessionId
        messages = rawMessages.compactMap(PrivacyAgentTraceMessage.init(json:))
        if case .string(let reason) = fields["terminalStopReason"] {
            terminalStopReason = reason
        } else {
            terminalStopReason = nil
        }
        createdAt = fields["createdAt"]?.int64Value ?? 0
        truncated = fields["truncated"]?.boolValue ?? false
        omittedParts = fields["omittedParts"]?.intValue
    }

    private enum CodingKeys: String, CodingKey {
        case attempt, provider, model, sessionId, messages
        case terminalStopReason, createdAt, truncated, omittedParts
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        attempt = (try? container.decodeIfPresent(Int.self, forKey: .attempt)) ?? 0
        provider = (try? container.decodeIfPresent(String.self, forKey: .provider)) ?? ""
        model = (try? container.decodeIfPresent(String.self, forKey: .model)) ?? ""
        sessionId = (try? container.decodeIfPresent(String.self, forKey: .sessionId)) ?? ""
        messages = (try? container.decodeIfPresent(
            [PrivacyAgentTraceMessage].self,
            forKey: .messages
        )) ?? []
        terminalStopReason = try? container.decodeIfPresent(String.self, forKey: .terminalStopReason)
        createdAt = (try? container.decodeIfPresent(Int64.self, forKey: .createdAt)) ?? 0
        truncated = (try? container.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        omittedParts = try? container.decodeIfPresent(Int.self, forKey: .omittedParts)
    }
}

/// The closed set of audit statuses a ledger row may render. The gateway maps
/// every raw producer token — a reviewer decision, or a model's terminal stop
/// reason drawn from an open string — onto `{code,label}` and drops the rest,
/// so anything outside these four codes never reaches a screen styled as if it
/// meant something. A code this client does not know is treated the same way.
public struct PrivacyAuditStatusDisplay: Decodable, Equatable, Sendable {
    public enum Code: String, Decodable, Equatable, Sendable {
        case allowed
        case reduced
        case held
        case blocked
    }

    public let code: Code
    /// Human label; the gateway owns the wording so all three clients agree.
    public let label: String

    public init(code: Code, label: String) {
        self.code = code
        self.label = label
    }
}

public struct PrivacyAuditEventDisplay: Decodable, Equatable, Sendable {
    public let title: String
    public let text: String?
    public let detail: String?
    /// Nil when absent, when the code is outside the closed set, or when the
    /// gateway supplied a blank label — all of which render nothing at all.
    public let status: PrivacyAuditStatusDisplay?
    public let provider: String?
    public let model: String?
    public let confidence: Double?
    public let approvalId: String?
    public let releaseId: String?
    public let reductions: [String]

    public init(
        title: String,
        text: String? = nil,
        detail: String? = nil,
        status: PrivacyAuditStatusDisplay? = nil,
        provider: String? = nil,
        model: String? = nil,
        confidence: Double? = nil,
        approvalId: String? = nil,
        releaseId: String? = nil,
        reductions: [String] = []
    ) {
        self.title = title
        self.text = text
        self.detail = detail
        self.status = status
        self.provider = provider
        self.model = model
        self.confidence = confidence
        self.approvalId = approvalId
        self.releaseId = releaseId
        self.reductions = reductions
    }

    private enum CodingKeys: String, CodingKey {
        case title, text, detail, status, provider, model, confidence
        case approvalId, releaseId, reductions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decode(String.self, forKey: .title)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        // A status whose code this client does not know, or whose label is
        // blank, is dropped rather than surfaced as a meaningless chip.
        let decodedStatus = try? container.decodeIfPresent(
            PrivacyAuditStatusDisplay.self,
            forKey: .status
        )
        status = decodedStatus.flatMap { candidate in
            candidate.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : candidate
        }
        provider = try container.decodeIfPresent(String.self, forKey: .provider)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        confidence = try container.decodeIfPresent(Double.self, forKey: .confidence)
        approvalId = try container.decodeIfPresent(String.self, forKey: .approvalId)
        releaseId = try container.decodeIfPresent(String.self, forKey: .releaseId)
        reductions = try container.decodeIfPresent([String].self, forKey: .reductions) ?? []
    }
}

public enum PrivacyAnswerDiffOp: String, Decodable, Equatable, Sendable {
    case equal
    case removed
    case added
}

/// A run of characters inside one diffed line. `removed` text belongs to the
/// candidate only, `added` text to the released answer only, `equal` text to
/// both. A line's spans concatenate back into its `text`.
public struct PrivacyAnswerDiffSpan: Decodable, Equatable, Sendable {
    public let op: PrivacyAnswerDiffOp
    public let text: String

    public init(op: PrivacyAnswerDiffOp, text: String) {
        self.op = op
        self.text = text
    }
}

/// One line of the comparison, in reading order: `removed` lines come from the
/// candidate, `added` lines from the released answer, `equal` lines are in both.
///
/// `spans` is non-nil only when the line was matched to a counterpart on the
/// other side and the two are close enough that a word-level breakdown
/// describes an edit. A nil `spans` means the line has no counterpart — never
/// that the line is unchanged.
public struct PrivacyAnswerDiffLine: Decodable, Equatable, Sendable {
    public let op: PrivacyAnswerDiffOp
    public let text: String
    public let spans: [PrivacyAnswerDiffSpan]?

    public init(op: PrivacyAnswerDiffOp, text: String, spans: [PrivacyAnswerDiffSpan]? = nil) {
        self.op = op
        self.text = text
        self.spans = spans
    }

    private enum CodingKeys: String, CodingKey {
        case op, text, spans
    }

    /// A span this client cannot read costs the line its breakdown, not its
    /// text: the spans re-join into `text`, so the line rendered whole says the
    /// same thing with less detail. Spans that do not re-join describe some
    /// other line, and highlighting words from them would assert an edit that
    /// this line never underwent — they are dropped for the same reason.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let line = try container.decode(String.self, forKey: .text)
        op = try container.decode(PrivacyAnswerDiffOp.self, forKey: .op)
        text = line
        let decoded = try? container.decodeIfPresent([PrivacyAnswerDiffSpan].self, forKey: .spans)
        spans = decoded.flatMap { $0.map(\.text).joined() == line ? $0 : nil }
    }
}

/// Why the gateway produced no line-by-line comparison. Both cases describe
/// what the comparison did, not what the answer contains.
public enum PrivacyAnswerNoDiffReason: Equatable, Sendable {
    /// Too little of the candidate lines up with the released answer for a
    /// line-by-line reading to describe an edit.
    case dissimilar
    /// The pair exceeded the work a read is allowed to spend.
    case tooLarge
    /// A reason this client does not know.
    case unspecified

    init(wire: String?) {
        switch wire {
        case "dissimilar": self = .dissimilar
        case "too_large": self = .tooLarge
        default: self = .unspecified
        }
    }
}

/// How a released answer relates to the candidate Omnesis generated for it.
///
/// - `identical` — the released bytes are the candidate's. The release step
///   carries no body text of its own, because it would repeat the candidate.
/// - `diff` — the released answer is an edit of the candidate, line by line.
/// - `noDiff` — the two differ and no edit-shaped comparison was produced, so
///   the released text stands on its own.
///
/// Nothing here attributes a change to a reduction the reviewer named: the
/// lines describe two strings, not the reviewer's reasoning. `noDiff` is not a
/// finding that the answer was rewritten, only that Omnesis declined to present
/// the change as an edit.
public enum PrivacyAnswerComparison: Decodable, Equatable, Sendable {
    case identical
    case diff(lines: [PrivacyAnswerDiffLine])
    case noDiff(reason: PrivacyAnswerNoDiffReason)

    private enum CodingKeys: String, CodingKey {
        case kind, lines, reason
    }

    /// Throws on a kind this client does not know, so the caller's tolerant
    /// decode drops the comparison entirely. A comparison rendered from a shape
    /// only half understood would be a claim about an edit nothing checked.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "identical":
            self = .identical
        case "diff":
            let lines = try container.decode([PrivacyAnswerDiffLine].self, forKey: .lines)
            // A diff with no lines describes nothing. Rendering its heading over
            // an empty block would claim a comparison was drawn when none was.
            guard !lines.isEmpty else {
                throw DecodingError.dataCorruptedError(
                    forKey: .lines,
                    in: container,
                    debugDescription: "a diff comparison carried no lines"
                )
            }
            self = .diff(lines: lines)
        case "no_diff":
            let reason = try? container.decodeIfPresent(String.self, forKey: .reason)
            self = .noDiff(reason: PrivacyAnswerNoDiffReason(wire: reason))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "unknown answer comparison kind '\(kind)'"
            )
        }
    }
}

/// One recorded step of an exchange. The stored audit payload, its digest and
/// its byte counts are deliberately absent: the ledger tells an operator what
/// happened, when, and which model was involved — a raw payload dump on a
/// privacy screen only reprints the private content the boundary held back.
public struct PrivacyAuditEventSummary: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    public let taskId: String
    public let kind: PrivacyAuditEventKind
    public let createdAt: Int64
    public let display: PrivacyAuditEventDisplay
    /// Set on a `released` step whose task also recorded the candidate it was
    /// released from, and nil on every other step. Nil means "no comparison was
    /// computed", never "nothing changed".
    public let answerComparison: PrivacyAnswerComparison?

    public init(
        id: String,
        taskId: String,
        kind: PrivacyAuditEventKind,
        createdAt: Int64,
        display: PrivacyAuditEventDisplay,
        answerComparison: PrivacyAnswerComparison? = nil
    ) {
        self.id = id
        self.taskId = taskId
        self.kind = kind
        self.createdAt = createdAt
        self.display = display
        self.answerComparison = answerComparison
    }

    private enum CodingKeys: String, CodingKey {
        case id, taskId, kind, createdAt, display, answerComparison
    }

    /// The step's identity and its display stay required — a step that cannot
    /// say what happened has nothing to render. The comparison is the one
    /// tolerant field: absent, malformed or shaped in a way this client does not
    /// know, it degrades to none and the step renders its own text as before.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        taskId = try container.decode(String.self, forKey: .taskId)
        kind = try container.decode(PrivacyAuditEventKind.self, forKey: .kind)
        createdAt = try container.decode(Int64.self, forKey: .createdAt)
        display = try container.decode(PrivacyAuditEventDisplay.self, forKey: .display)
        answerComparison = try? container.decodeIfPresent(
            PrivacyAnswerComparison.self,
            forKey: .answerComparison
        )
    }
}

public struct PrivacyAuditEventPage: Decodable, Equatable, Sendable {
    public let events: [PrivacyAuditEventSummary]
    public let previousCursor: String?
}

/// The Privacy landing feed page. Distinct from `PrivacyExchangePage`, which is
/// scoped to one conversation and ordered oldest-first so a detail view reads
/// top-down.
public struct PrivacyExchangeFeedPage: Decodable, Equatable, Sendable {
    public let exchanges: [PrivacyExchangePresentation]
    public let nextCursor: String?

    public init(exchanges: [PrivacyExchangePresentation], nextCursor: String? = nil) {
        self.exchanges = exchanges
        self.nextCursor = nextCursor
    }

    private enum CodingKeys: String, CodingKey {
        case exchanges, nextCursor
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        exchanges = try container.decodeIfPresent(
            [PrivacyExchangePresentation].self,
            forKey: .exchanges
        ) ?? []
        nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
    }
}
