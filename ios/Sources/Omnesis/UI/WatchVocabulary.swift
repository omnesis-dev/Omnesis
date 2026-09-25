// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// What a watch is, said in the operator's words.
//
// A watch is a watch however it was asked for: who asked and where a firing
// goes are two facts printed on it, not two kinds of thing kept on separate
// screens. The portal prints exactly these phrases, and the two surfaces have
// to say the same things about the same watch.
//
// Deliberately outside the UIKit gate: these are string decisions with real
// edge cases — an unnamed integration, a delivery kind this build has not heard
// of, a watch that delivers nowhere — and they are cheap to test only while
// they are separable from a view.

/// Who asked for this watch, in one phrase.
///
/// A watch with no disclosure was the operator's: there was no egress to
/// approve, so no record of a request exists and there is nothing else it could
/// have been. Read from the record rather than guessed from the delivery kind —
/// an operator can perfectly well write a watch that wakes an agent, and calling
/// that one the integration's request would misattribute their own.
func watchAskedBy(_ watch: WatchRecord) -> String {
    guard let disclosure = watch.disclosure, disclosure.authoredBy == "integration" else {
        return "You asked for this"
    }
    return "\(disclosure.integrationName ?? "An integration") asked for this"
}

/// Where a watch's firings go, short enough for a row.
///
/// `nil` delivery means the watch delivers nowhere, which is a real setting
/// rather than a missing value: it records, and interrupts no one. A kind this
/// build has not heard of is printed as it arrived — naming it wrongly would be
/// a confident false statement about where a watch reaches.
func watchDeliveryLabel(_ watch: WatchRecord) -> String {
    switch watch.delivery {
    case "omnesis-notify":
        return "Notifies you"
    case "agent-wake":
        guard let agent = watch.disclosure?.integrationName else { return "Wakes an agent" }
        return "Wakes \(agent)"
    case .none:
        return "Records only"
    case .some(let kind):
        return kind
    }
}

/// The same fact as a sentence, for the watch's own page.
///
/// Only reached for a watch that discloses nothing — one that wakes an agent
/// says where it reaches once, in the section that also says what it was
/// approved to send. Saying it twice would print one fact under two different
/// names for the same integration.
func watchDeliverySentence(_ watch: WatchRecord) -> String {
    switch watch.delivery {
    case "omnesis-notify":
        "Notifies your devices."
    case .none:
        "Delivers nowhere. Every firing is recorded here and nobody is told."
    default:
        "\(watchDeliveryLabel(watch))."
    }
}

/// What the woken agent is asked to do, and who it is.
func watchDisclosureWakeSentence(_ disclosure: WatchDisclosure) -> String {
    let agent = disclosure.integrationName ?? "an integration"
    let instruction = disclosure.instruction?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let instruction, !instruction.isEmpty else {
        return "Wakes \(agent): No instruction was recorded."
    }
    return "Wakes \(agent): \(instruction)"
}

/// Where the operator's decision on this watch stands.
///
/// A watch with no approval was never put to them: they wrote it themselves,
/// and saying "approved" about a request nobody made would invent a decision.
func watchDisclosureApprovalLabel(_ disclosure: WatchDisclosure) -> String {
    guard let approval = disclosure.approval else {
        return "Not required — you asked for this watch yourself"
    }
    return subscriptionStatusLabel(approval.status)
}

/// Running first, held next, finished last.
///
/// Which of these is still doing something is the question a reader brings to
/// the list, and each row states its own status — so order is enough to answer
/// it, and no heading has to.
///
/// Stable within a rank, so the runtime's own order survives inside each band,
/// and a status this build has not heard of sorts with the finished rather than
/// vanishing.
func orderedWatches(_ watches: [WatchRecord]) -> [WatchRecord] {
    func rank(_ status: String) -> Int {
        switch status {
        case "active": 0
        case "paused": 1
        default: 2
        }
    }
    return watches.enumerated()
        .sorted { left, right in
            let a = rank(left.element.status)
            let b = rank(right.element.status)
            return a == b ? left.offset < right.offset : a < b
        }
        .map(\.element)
}

/// One firing, holding whichever of its two halves this install has.
///
/// The runtime records what the watch *caught*; the record that authorises its
/// egress records what it actually *sent*. Those are the same event seen from
/// two sides, so one firing earns one row.
struct WatchFiringRow: Identifiable, Equatable {
    let caught: WatchFiringRecord?
    let sent: PrivacySubscriptionFiring?
    /// Which firing at its sequence this is. A sequence names a set rather than
    /// one firing, so without this two rows on the same tick share an identity.
    var occurrence: Int = 0

    var id: String {
        guard let caught else { return "sent:\(sent?.id ?? "unknown")" }
        return occurrence == 0 ? "seq:\(caught.seq)" : "seq:\(caught.seq)#\(occurrence)"
    }

    /// When this row happened, whichever half of it this install has, in epoch
    /// milliseconds.
    ///
    /// A caught firing is stamped with the moment the watch spoke, as an
    /// instant in text; a sent one with the moment the wake was written, as a
    /// number. Both come from the same clock, so once they are the same kind of
    /// value a row with only one of them still sits in its right place.
    var at: Int64? {
        if let caught {
            let text = caught.noticedAt ?? caught.firedAt
            guard let date = ISO8601DateFormatter.omnesisParser.date(from: text) else { return nil }
            return Int64(date.timeIntervalSince1970 * 1000)
        }
        return sent?.createdAt
    }
}

/// Both ledgers, folded into one list, newest first.
///
/// The join is `seq`, the journal event a firing happened on. A sequence names
/// a *set* of firings rather than one — a broadcast arm re-judges every live
/// cell on the same tick — and what tells those apart in the runtime, the node
/// and key that fired, is not on this wire. So a sequence is read as a queue:
/// each caught firing takes the next sent record still unclaimed at that
/// sequence, and no record is handed to two rows.
///
/// A sent firing nothing claims still gets a row of its own rather than being
/// dropped: it is a record written before the runtime stamped its identity, or
/// one whose caught half is older than the page this screen holds, and losing
/// it would understate what left the machine.
func mergeWatchFirings(
    caught: [WatchFiringRecord],
    sent: [PrivacySubscriptionFiring]
)
    -> [WatchFiringRow] {
    var bySeq: [Int: [PrivacySubscriptionFiring]] = [:]
    for firing in sent {
        guard let seq = firing.seq else { continue }
        bySeq[seq, default: []].append(firing)
    }
    var claimed: Set<String> = []
    var occurrences: [Int: Int] = [:]
    var rows: [WatchFiringRow] = []
    for firing in caught {
        var match: PrivacySubscriptionFiring?
        if !(bySeq[firing.seq]?.isEmpty ?? true) {
            match = bySeq[firing.seq]?.removeFirst()
            if let match { claimed.insert(match.id) }
        }
        let occurrence = occurrences[firing.seq, default: 0]
        occurrences[firing.seq] = occurrence + 1
        rows.append(WatchFiringRow(caught: firing, sent: match, occurrence: occurrence))
    }
    rows += sent
        .filter { !claimed.contains($0.id) }
        .map { WatchFiringRow(caught: nil, sent: $0) }

    // A row with no usable instant cannot be placed among the dated ones, so it
    // keeps the order it arrived in, below them.
    return rows.enumerated()
        .sorted { left, right in
            let leftAt = left.element.at
            let rightAt = right.element.at
            if let leftAt, let rightAt {
                if leftAt != rightAt { return leftAt > rightAt }
                // Two firings on the same instant are ordered by the journal
                // sequence, which is what the runtime increments per event.
                let leftSeq = left.element.caught?.seq
                let rightSeq = right.element.caught?.seq
                if let leftSeq, let rightSeq, leftSeq != rightSeq { return leftSeq > rightSeq }
                return left.offset < right.offset
            }
            if leftAt == nil, rightAt == nil { return left.offset < right.offset }
            return rightAt == nil
        }
        .map(\.element)
}

extension ISO8601DateFormatter {
    /// Parses the gateway's instants, which carry fractional seconds.
    static let omnesisParser: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
