// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Vocabulary for the Direct half of the Audit screen: session labels and the
// payload text behind each card's raw-JSON affordance.
//
// Deliberately free of SwiftUI so the wording stays unit testable in the
// sim-less logic lane.
//
// Direct rows are unreviewed reads that never reuse the Answer release
// vocabulary (shared, held, denied): only failures speak, through the shared
// error card, and a call without a result reads "No result recorded."

// MARK: - Session labels

/// The session's headline. An explicit caller grouping key names its kind —
/// anything else reads as the gateway's best-effort grouping, never as a
/// conversation or workflow the caller named. A key from a newer gateway
/// than this client shows verbatim rather than guessing a friendlier label,
/// mirroring the portal.
func directAuditSessionLabel(_ session: DirectAuditSessionSummary) -> String {
    guard let key = session.explicitKey else { return "Grouped by activity" }
    let parts = key.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty else { return key }
    let id = String(parts[1])
    switch parts[0] {
    case "workflow": return "Workflow \(id)"
    case "conversation": return "Conversation \(id)"
    default: return key
    }
}

/// The agent the session belongs to: the operator-approved principal name,
/// or "External agent" when the principal row is gone.
func directAuditAgentName(_ session: DirectAuditSessionSummary) -> String {
    let name = session.principalName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return name.isEmpty ? "External agent" : name
}

/// Whether the session carries the heuristic marker: no caller grouping key
/// was sent, so calls were grouped while idle gaps stayed under an hour.
func directAuditSessionIsHeuristic(_ session: DirectAuditSessionSummary) -> Bool {
    session.explicitKey == nil
}

func directAuditCallCountLabel(_ eventCount: Int) -> String {
    eventCount == 1 ? "1 call" : "\(eventCount) calls"
}

// MARK: - Day groups

/// One calendar day's calls inside a transcript, oldest first. The first
/// group's heading is the transcript's top date; a later group's heading
/// interleaves before its first call. Headings reuse the feed's day wording
/// ("Today", "Yesterday", an abbreviated weekday date, "Date unknown").
struct DirectTranscriptDay: Equatable, Sendable {
    let id: String
    let heading: String
    var events: [DirectAuditEventSummary]
}

/// Group an already-oldest-first transcript by local calendar day without
/// reordering it.
func directTranscriptDays(_ events: [DirectAuditEventSummary], now: Int64) -> [DirectTranscriptDay] {
    var indexByKey: [String: Int] = [:]
    var result: [DirectTranscriptDay] = []
    for event in events {
        let key = event.createdAt > 0 ? privacyDayKey(event.createdAt) : "unknown"
        if let index = indexByKey[key] {
            result[index].events.append(event)
        } else {
            indexByKey[key] = result.count
            result.append(DirectTranscriptDay(
                id: key,
                heading: privacyFeedDayHeading(event.createdAt, now: now),
                events: [event]
            ))
        }
    }
    return result
}

// MARK: - Payload rendering

/// The full payload as human-readable text: pretty-printed JSON with sorted
/// keys, falling back to a debug description when the value does not survive
/// a JSON round-trip. Shown in the raw-JSON sheet behind each card's trailing
/// affordance — the sheet scrolls, so the text is never clipped.
func directAuditPayloadText(_ value: JSONValue) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    guard let data = try? encoder.encode(value),
          let text = String(data: data, encoding: .utf8)
    else {
        return String(describing: value)
    }
    return text
}

/// Whether the record carries a result: refused/failed calls record no result
/// (undefined on the wire), and read like the portal's "No result recorded."
/// rather than rendering an empty card.
func directRecordHasResult(_ record: JSONValue) -> Bool {
    guard case .object(let fields) = record else { return false }
    guard let result = fields["result"] else { return false }
    return result != .null
}

/// Whether the fetched payload is a truncation sentinel rather than the call's
/// args/result record.
func directAuditPayloadIsTruncatedSentinel(_ value: JSONValue) -> Bool {
    guard case .object(let fields) = value,
          case .bool(let truncated) = fields["truncated"]
    else { return false }
    return truncated
}
