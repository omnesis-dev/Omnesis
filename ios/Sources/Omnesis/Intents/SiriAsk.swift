// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The outcome of a Siri ask, independent of where it ran. The iPhone
/// produces every case directly (via `SiriAskRunner`); the Apple Watch
/// relays the question to the iPhone and receives one of these back over
/// WatchConnectivity, plus the watch-only relay outcomes the phone
/// can never produce (`phoneUnreachable`, `watchLinkInactive`,
/// `relayFailed`, `answerOnPhone`, `queuedForPhone`).
///
/// Pure and platform-free so the sim-less logic lane covers the spoken
/// copy and the relay wire shape, and so the file compiles into both the
/// iPhone app and the watch app targets.
public enum SiriAskOutcome: Equatable, Sendable {
    /// The turn settled with this spoken reply (non-empty).
    case answered(text: String)
    /// The turn settled but produced no spoken text.
    case emptyAnswer
    /// The turn died — a gateway error, or an unrecoverable stream failure.
    /// `reason` is the gateway's own humanized sentence naming the condition
    /// when it sent one, so the spoken failure can say what actually broke
    /// instead of a generic apology. Nil when nothing named the condition, and
    /// on a relay from a counterpart that predates the field.
    case failed(reason: String?)
    /// Budget elapsed with the turn still running; the armed
    /// `notifyAfterMs` push delivers the finished answer to the phone.
    case stillWorking
    /// The resumed conversation's previous turn is still in flight; its
    /// own armed push delivers that answer.
    case previousTurnRunning
    /// No gateway is paired yet.
    case notPaired
    /// A legacy gateway rejected the voice profile.
    case experimentalOff
    /// The gateway rejected the token — re-pair needed.
    case unauthorized
    /// The gateway couldn't be reached to create the session.
    case unreachable
    /// The question reached a session but the send itself failed.
    case sendFailed
    /// Watch-only: the paired iPhone couldn't be reached to relay the ask.
    case phoneUnreachable
    /// Watch-only: the watch's own connectivity session never activated, so
    /// the ask never left the watch. Distinct from `phoneUnreachable` (where
    /// the session is live but the phone isn't in range) so the spoken
    /// sentence points at the right problem.
    case watchLinkInactive
    /// Watch-only: the relay to the iPhone failed for another reason.
    case relayFailed
    /// Watch-only: the turn finished but its answer never reached the watch.
    /// The iPhone holds it. Distinct from every other case because nothing is
    /// wrong with the answer — only its delivery — and a turn that settled
    /// inside the budget arms no push, so there is no second chance to wait
    /// for.
    case answerOnPhone
    /// Watch-only: the iPhone app never picked the question up live, so the
    /// watch queued it on WatchConnectivity's guaranteed-delivery channel.
    /// The phone asks it when it next runs and the answer arrives as a
    /// notification.
    case queuedForPhone

    /// Stable string tag for the parameterless cases, used as the
    /// WatchConnectivity reply discriminator. `answered` is handled
    /// separately by `SiriAskWire` because it carries text.
    var tag: String {
        switch self {
        case .answered: "answered"
        case .emptyAnswer: "emptyAnswer"
        case .failed: "failed"
        case .stillWorking: "stillWorking"
        case .previousTurnRunning: "previousTurnRunning"
        case .notPaired: "notPaired"
        case .experimentalOff: "experimentalOff"
        case .unauthorized: "unauthorized"
        case .unreachable: "unreachable"
        case .sendFailed: "sendFailed"
        case .phoneUnreachable: "phoneUnreachable"
        case .watchLinkInactive: "watchLinkInactive"
        case .relayFailed: "relayFailed"
        case .answerOnPhone: "answerOnPhone"
        case .queuedForPhone: "queuedForPhone"
        }
    }

    /// Reconstruct a parameterless case from its `tag`. Returns nil for
    /// `answered` (which needs text — `SiriAskWire` builds it) and for any
    /// tag an older/newer counterpart doesn't recognise.
    init?(tag: String) {
        switch tag {
        case "emptyAnswer": self = .emptyAnswer
        case "failed": self = .failed(reason: nil)
        case "stillWorking": self = .stillWorking
        case "previousTurnRunning": self = .previousTurnRunning
        case "notPaired": self = .notPaired
        case "experimentalOff": self = .experimentalOff
        case "unauthorized": self = .unauthorized
        case "unreachable": self = .unreachable
        case "sendFailed": self = .sendFailed
        case "phoneUnreachable": self = .phoneUnreachable
        case "watchLinkInactive": self = .watchLinkInactive
        case "relayFailed": self = .relayFailed
        case "answerOnPhone": self = .answerOnPhone
        case "queuedForPhone": self = .queuedForPhone
        default: return nil
        }
    }
}

extension SiriAskOutcome {
    /// How a surface with a screen should present this outcome. An answer is
    /// the thing the user asked for; a status is neither success nor failure
    /// (the work continues elsewhere); a failure is something that went wrong
    /// and reads badly if it is dressed up as an answer.
    public enum Kind: Equatable, Sendable {
        case answer
        case status
        case failure
    }

    public var kind: Kind {
        switch self {
        case .answered:
            .answer
        case .stillWorking, .previousTurnRunning:
            .status
        case .answerOnPhone:
            // The answer exists and is fine; only its delivery failed.
            .status
        case .queuedForPhone:
            // Nothing is lost — the question is on its way to the phone.
            .status
        case .emptyAnswer, .failed, .notPaired, .experimentalOff, .unauthorized,
             .unreachable, .sendFailed, .phoneUnreachable, .watchLinkInactive, .relayFailed:
            .failure
        }
    }
}

/// Human-readable labels for what the agent is doing mid-turn, keyed by the
/// tool it just started. A relayed ask is otherwise a blank wait of up to
/// three quarters of a minute; naming the current step is what separates
/// "working" from "hung" on a screen with nothing else to show.
///
/// Deliberately coarse — the tool name only, never its arguments. The label is
/// glanceable on a watch and carries none of the question's content.
public enum SiriAskActivity {
    /// Shown before the first tool starts, and for any tool this build does
    /// not recognise. One string for both so an unrecognised first step does
    /// not read as a flicker between two different neutral words.
    public static let fallbackLabel = "Working…"

    /// Shown on the watch while it keeps retrying an iPhone app that has not
    /// picked up the question yet — typically one iOS is still launching.
    public static let wakingPhoneLabel = "Waking your iPhone…"

    public static func label(forTool tool: String) -> String {
        switch tool {
        // The batch tools are what the agent actually calls at the top
        // level — the singular ones appear only as their child steps, which
        // don't open a call. Without them every retrieval would read as the
        // bare fallback, so a wrist watching a real turn would never learn
        // that it is searching.
        case "search_documents", "search_loops", "list_loops", "search_many":
            "Searching…"
        case "fetch_document", "fetch_loop", "lookup_document_by_url", "fetch_many":
            "Reading…"
        case "lookup_people":
            "Looking up people…"
        case "run_sql":
            "Checking records…"
        case "trace_connections":
            "Tracing links…"
        case "temporal_query", "time_index_query":
            "Checking dates…"
        case "entity_context":
            "Gathering context…"
        case "annotate", "cite_record", "annotate_many":
            "Noting sources…"
        case "spawn_subagent", "join_subagents":
            "Looking deeper…"
        case "plan":
            "Planning…"
        case let name where name.hasPrefix("watch"):
            "Setting up a watch…"
        default:
            // An unrecognised tool (a newer gateway than this build) still
            // reads as progress rather than a blank or a raw identifier.
            fallbackLabel
        }
    }
}

/// A privacy-safe view of one voice ask's live work, sized for the single
/// line the watch gives it. The phone projects gateway events into this
/// shape before it crosses to the watch: it intentionally carries no query
/// text, document title or identity, source identity, or result content.
public struct SiriAskActivitySnapshot: Equatable, Sendable {
    /// The current step — one short phrase, e.g. "Searching…".
    public var label: String
    /// What the last completed retrieval yielded, e.g. "12 found" or
    /// "3 read". Nil until something completes, so the hand-off states read
    /// as a bare label rather than a zero.
    public var detail: String?

    public init(label: String, detail: String? = nil) {
        self.label = label
        self.detail = detail
    }

    /// The whole status line. At most two clauses: what the agent is doing,
    /// and what it has retrieved. Composed here rather than on the watch so
    /// the one-line rule is covered by the sim-less logic lane.
    public var line: String {
        guard let detail, !detail.isEmpty else { return label }
        return "\(label) · \(detail)"
    }
}

/// Events the phone can expose without leaking the agent's prompt, tool
/// arguments, or corpus content. Keeping the reducer here gives both targets
/// one stable wire vocabulary while the iPhone remains the only side that
/// knows the gateway's full event payload.
public enum SiriAskActivityEvent: Equatable, Sendable {
    case relayReceived
    case connecting
    case requestSent
    case agentStarted
    case toolStarted(id: String, tool: String)
    case toolFinished(id: String, outcome: SiriAskActivityToolOutcome)
}

public enum SiriAskActivityToolOutcome: Equatable, Sendable {
    case none
    case search(found: Int)
    case documentOpened
    case batch(found: Int, opened: Int)
}

/// Reduces live agent milestones into a snapshot suitable for a glanceable
/// watch UI. Tool ids make SSE replay harmless: reconnecting to the gateway
/// can replay a start/result event, but it must not inflate the counters.
public struct SiriAskActivityTimeline: Equatable, Sendable {
    public private(set) var snapshot = SiriAskActivitySnapshot(label: SiriAskActivity.fallbackLabel)
    private var agentStarted = false
    private var startedTools: Set<String> = []
    private var finishedTools: Set<String> = []
    /// Running totals behind the detail clause. Kept privately because only
    /// one of them is ever on screen: the clause names the last kind of
    /// retrieval that completed, not both at once.
    private var found = 0
    private var opened = 0

    public init() {}

    @discardableResult
    public mutating func apply(_ event: SiriAskActivityEvent) -> SiriAskActivitySnapshot {
        switch event {
        case .relayReceived:
            snapshot.label = "Received"
        case .connecting, .requestSent:
            // One phrase for reaching the gateway and handing it the
            // question: they resolve within a moment of each other, and two
            // strings that fast read as a flicker rather than as progress.
            snapshot.label = "Asking…"
        case .agentStarted:
            guard !agentStarted else { return snapshot }
            agentStarted = true
            snapshot.label = "Thinking…"
        case .toolStarted(let id, let tool):
            guard startedTools.insert(id).inserted else { return snapshot }
            snapshot.label = SiriAskActivity.label(forTool: tool)
        case .toolFinished(let id, let outcome):
            guard finishedTools.insert(id).inserted else { return snapshot }
            switch outcome {
            case .none:
                break
            case .search(let count):
                found += max(0, count)
                updateDetail(opened: 0)
            case .documentOpened:
                opened += 1
                updateDetail(opened: 1)
            case .batch(let batchFound, let batchOpened):
                // Backends with child-progress support send those child
                // results before the parent batch result. The parent is the
                // durable fallback for backends without them, never another
                // contribution to the same aggregate counters.
                if finishedTools.contains(where: { $0.hasPrefix("\(id)#") }) {
                    return snapshot
                }
                found += max(0, batchFound)
                opened += max(0, batchOpened)
                updateDetail(opened: batchOpened)
            }
        }
        return snapshot
    }

    /// Point the clause at what this tool call just did. Opening a document
    /// is the deeper act, so a call that did both reports the read; a call
    /// that only searched reports what the agent has found to read from,
    /// which is what it answers off when a match arrives inline.
    private mutating func updateDetail(opened justOpened: Int) {
        if justOpened > 0, opened > 0 {
            snapshot.detail = "\(opened) read"
        } else if found > 0 {
            snapshot.detail = "\(found) found"
        }
    }
}

/// Read-along support: where to split an answer between the part already
/// spoken and the part still to come.
public enum SiriAskReadAlong {
    /// Split point for the highlight, given how far speech has got. Speech
    /// reports progress as UTF-16 offsets into the utterance, which stops
    /// matching a character count the moment an answer contains an accent or
    /// an emoji — so convert rather than assume. Returns nil when nothing has
    /// been spoken yet.
    ///
    /// An offset landing inside a grapheme cluster (a flag, a skin-toned
    /// emoji, a ZWJ sequence) has no `String.Index`; the split rounds down to
    /// the start of that cluster, so the highlight lags by one character
    /// rather than collapsing.
    public static func split(of text: String, spokenUTF16: Int) -> String.Index? {
        guard spokenUTF16 > 0, !text.isEmpty else { return nil }
        guard let utf16Index = text.utf16.index(
            text.utf16.startIndex,
            offsetBy: spokenUTF16,
            limitedBy: text.utf16.endIndex
        )
        else {
            return text.endIndex
        }
        if let exact = String.Index(utf16Index, within: text) { return exact }
        // Mid-cluster: walk to the start of the cluster containing this offset.
        let offset = text.utf16.distance(from: text.utf16.startIndex, to: utf16Index)
        var index = text.startIndex
        var consumed = 0
        while index < text.endIndex {
            let next = text.index(after: index)
            let width = text.utf16.distance(from: index, to: next)
            if consumed + width > offset { return index }
            consumed += width
            index = next
        }
        return text.endIndex
    }
}

/// The single source of spoken copy for a Siri ask, shared by the iPhone
/// intent and the watch intent so both surfaces read identical sentences.
public enum SiriAskDialog {
    public static func text(for outcome: SiriAskOutcome) -> String {
        switch outcome {
        case .answered(let text):
            text
        case .emptyAnswer:
            "The agent finished without a spoken answer. Check the conversation in Omnesis."
        case .failed(let reason):
            spokenFailure(reason: reason)
        case .stillWorking:
            "Still working on it — I'll send you the answer as a notification."
        case .previousTurnRunning:
            "Still working on your last question — that answer is on the way. Ask me again in a moment."
        case .notPaired:
            "Omnesis isn't paired with a gateway yet. Open the app to pair first."
        case .experimentalOff:
            "This gateway version doesn't support asking by voice. Update your gateway."
        case .unauthorized:
            "Omnesis couldn't authenticate. Re-pair with your gateway from the app."
        case .unreachable:
            "Sorry, I couldn't reach your Omnesis gateway."
        case .sendFailed:
            "Sorry, I couldn't send that question to your gateway."
        case .phoneUnreachable:
            "I couldn't reach your iPhone. Make sure it's nearby and unlocked, then try again."
        case .watchLinkInactive:
            "The watch couldn't open its link to your iPhone. Try again in a moment."
        case .relayFailed:
            "Sorry, something went wrong reaching your iPhone."
        case .answerOnPhone:
            "I got your answer but couldn't bring it to your watch. It's waiting in Omnesis on your iPhone."
        case .queuedForPhone:
            "Your iPhone didn't respond in time, so I've queued your question. "
                + "The answer will arrive as a notification once your iPhone picks it up."
        }
    }

    /// The label a screen puts over a status outcome: where the question is,
    /// since it is neither answered nor lost.
    public static func statusTitle(for outcome: SiriAskOutcome) -> String {
        outcome == .queuedForPhone ? "Queued for iPhone" : "Still working"
    }

    /// The generic apology, used whenever nothing usable named the condition.
    static let unexplainedFailure =
        "Sorry, something went wrong while answering. Check the conversation in Omnesis."

    /// Past this, a "reason" is no longer a sentence naming a condition — it is
    /// a wall of text, and speech has no way to skim it.
    private static let maxSpokenReasonLength = 160

    /// What Siri says when a turn dies.
    ///
    /// The gateway names the condition ("The model provider does not have the
    /// assigned model…"), which is far more use out loud than a generic
    /// apology — so it is spoken as one sentence, prefixed so the utterance
    /// still opens as an apology. Only the first sentence-or-line is used, and
    /// only if it is short enough to be heard as one; anything else falls back
    /// to the generic copy rather than reading a paragraph aloud.
    static func spokenFailure(reason: String?) -> String {
        guard let sentence = spokenReasonSentence(reason) else { return unexplainedFailure }
        return "Sorry — \(sentence)"
    }

    private static func spokenReasonSentence(_ reason: String?) -> String? {
        guard let reason else { return nil }
        let firstLine = reason
            .split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)[0]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !firstLine.isEmpty, firstLine.count <= maxSpokenReasonLength else { return nil }
        // A spoken sentence needs a full stop to be read with a falling
        // intonation; the gateway's messages usually carry one already.
        return ".!?".contains(firstLine.last ?? " ") ? firstLine : firstLine + "."
    }
}

/// The WatchConnectivity message contract for the watch → iPhone ask
/// relay. The watch sends `request(question:)`; the iPhone answers with
/// `reply(for:)`. Both directions are plain `[String: String]` so the
/// dictionaries satisfy WatchConnectivity's property-list requirement,
/// and both parsers are defensive — a malformed or unrecognised payload
/// degrades to a spoken failure rather than a crash.
public enum SiriAskWire {
    static let kindKey = "kind"
    static let askKind = "ask"
    static let progressKind = "progress"
    static let resultKind = "result"
    static let questionKey = "question"
    /// Correlates one ask with its progress and its result. Without it a
    /// message from a previous ask — still in flight when the next one starts —
    /// resolves the wrong wait.
    static let refKey = "ref"
    static let activityKey = "activity"
    static let detailKey = "detail"
    static let outcomeKey = "outcome"
    static let textKey = "text"

    /// Watch → iPhone: carry the dictated question, tagged with the ref the
    /// phone echoes back on the result so a late message from an earlier ask
    /// cannot be mistaken for this one's answer.
    public static func request(question: String, ref: String) -> [String: String] {
        [kindKey: askKind, questionKey: question, refKey: ref]
    }

    /// iPhone side: the ref carried by an ask, to be echoed on its result.
    public static func ref(from message: [String: Any]) -> String? {
        message[refKey] as? String
    }

    /// iPhone side: extract the trimmed question from a received message,
    /// or nil when the message isn't a well-formed ask.
    public static func question(from message: [String: Any]) -> String? {
        guard message[kindKey] as? String == askKind,
              let raw = message[questionKey] as? String
        else {
            return nil
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// iPhone → watch, mid-turn: a compact aggregate snapshot. It is sent
    /// fire-and-forget — a missed update only leaves the prior snapshot on
    /// screen and never affects the ask itself.
    public static func progress(snapshot: SiriAskActivitySnapshot, ref: String?) -> [String: String] {
        var message = [kindKey: progressKind, activityKey: snapshot.label]
        if let detail = snapshot.detail, !detail.isEmpty { message[detailKey] = detail }
        if let ref { message[refKey] = ref }
        return message
    }

    /// Sanity bounds on the two strings, not the layout rule. What actually
    /// keeps the status line unwrapped is the watch's own fallback (the count
    /// clause is dropped before a phrase is ever clipped) plus the vocabulary
    /// itself: `maxRenderableLabelLength` is the ceiling every label in
    /// `SiriAskActivity` is held under, and a test enforces it. These are the
    /// looser limits past which a packet is treated as corrupt.
    public static let maxRenderableLabelLength = 22
    private static let maxLabelLength = 40
    private static let maxDetailLength = 20

    /// Watch side: decode a progress snapshot and its request correlation.
    /// An over-long detail costs only the detail — the step it belongs to is
    /// still worth showing, and a wrist left on a stale label for the rest of
    /// the turn is a worse outcome than a missing count.
    public static func activitySnapshot(
        from message: [String: Any]
    )
        -> (snapshot: SiriAskActivitySnapshot, ref: String?)? {
        guard message[kindKey] as? String == progressKind,
              let label = message[activityKey] as? String,
              !label.isEmpty, label.count <= maxLabelLength
        else {
            return nil
        }
        var detail = message[detailKey] as? String
        if let raw = detail, raw.isEmpty || raw.count > maxDetailLength { detail = nil }
        return (
            SiriAskActivitySnapshot(label: label, detail: detail),
            message[refKey] as? String
        )
    }

    /// iPhone → watch, on completion: the finished outcome, sent
    /// fire-and-forget ALONGSIDE the reply. The reply is the primary path, but
    /// it is a single point of failure — a phone suspended after a background
    /// wake, or a reply timeout that never fires, would otherwise strand the
    /// watch forever on an answer that exists. Whichever arrives first wins.
    public static func result(for outcome: SiriAskOutcome, ref: String?) -> [String: String] {
        var message = reply(for: outcome)
        message[kindKey] = resultKind
        if let ref { message[refKey] = ref }
        return message
    }

    /// Watch side: the finished outcome carried by a result message and the
    /// ask it belongs to, or nil when the message isn't a result.
    public static func resultOutcome(
        from message: [String: Any]
    )
        -> (outcome: SiriAskOutcome, ref: String?)? {
        guard message[kindKey] as? String == resultKind else { return nil }
        return (outcome(from: message), message[refKey] as? String)
    }

    /// iPhone → watch: encode the outcome as the relay reply.
    public static func reply(for outcome: SiriAskOutcome) -> [String: String] {
        switch outcome {
        case .answered(let text):
            [outcomeKey: outcome.tag, textKey: text]
        case .failed(let reason):
            // Shares `textKey` with `answered`: the tag already says which of
            // the two it is, and a second string key would only be a second
            // thing to keep in step between the phone and the watch.
            if let reason, !reason.isEmpty {
                [outcomeKey: outcome.tag, textKey: reason]
            } else {
                [outcomeKey: outcome.tag]
            }
        default:
            [outcomeKey: outcome.tag]
        }
    }

    /// Watch side: decode a relay reply. An `answered` reply rebuilds its
    /// text (empty string if the key is somehow absent); an unrecognised
    /// tag or a missing outcome key falls back to `relayFailed`.
    public static func outcome(from reply: [String: Any]) -> SiriAskOutcome {
        guard let tag = reply[outcomeKey] as? String else { return .relayFailed }
        if tag == "answered" {
            return .answered(text: reply[textKey] as? String ?? "")
        }
        if tag == "failed" {
            return .failed(reason: reply[textKey] as? String)
        }
        return SiriAskOutcome(tag: tag) ?? .relayFailed
    }
}
