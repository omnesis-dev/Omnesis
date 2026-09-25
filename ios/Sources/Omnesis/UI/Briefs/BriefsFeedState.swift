// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Full-screen loading state for first-page feed refreshes. A refresh that
/// starts without requesting the indicator can still supersede the initial
/// load, so every owned completion clears the state.
struct BriefsFeedLoadingState: Equatable, Sendable {
    private(set) var isLoading = true

    mutating func begin(showIndicator: Bool) {
        if showIndicator {
            isLoading = true
        }
    }

    mutating func finishOwnedRefresh() {
        isLoading = false
    }
}

/// Pure list state for the Briefs feed — the ranked brief list,
/// once-per-brief read marking, and dismissal removal, kept UIKit-free
/// so the SwiftPM logic lane covers it. `BriefsView` owns one of these
/// in `@State`; all network side effects stay in the view.
public struct BriefsFeedState: Equatable, Sendable {
    public struct RemovedBrief: Equatable, Sendable {
        public let brief: BriefRecord
        public let index: Int
        fileprivate let feedIdentity: UUID
    }

    private let feedIdentity: UUID
    private var feedOrder: [String: Int]
    public private(set) var briefs: [BriefRecord]

    /// Ids already marked read — briefs that arrived `read` (counted on
    /// an earlier visit) plus those opened this session — so the
    /// mark-read POST fires exactly once per brief actually opened.
    private var readMarked: Set<String>

    public init(briefs: [BriefRecord]) {
        self.feedIdentity = UUID()
        self.feedOrder = Dictionary(uniqueKeysWithValues: briefs.enumerated().map { index, brief in
            (brief.id, index)
        })
        self.briefs = briefs
        self.readMarked = Set(briefs.filter { $0.state == .read }.map(\.id))
    }

    public static func == (lhs: BriefsFeedState, rhs: BriefsFeedState) -> Bool {
        lhs.briefs == rhs.briefs
            && lhs.readMarked == rhs.readMarked
            && lhs.feedOrder == rhs.feedOrder
    }

    public var isEmpty: Bool {
        briefs.isEmpty
    }

    public var count: Int {
        briefs.count
    }

    public func brief(withId id: String) -> BriefRecord? {
        briefs.first { $0.id == id }
    }

    /// True for rows that should carry the unread indicator: never
    /// marked read on the server and not yet opened this session.
    public func isUnread(id: String) -> Bool {
        !readMarked.contains(id)
    }

    /// Append one ranked cursor page without changing the feed identity.
    /// Dismiss rollbacks captured before this append remain valid, while a
    /// first-page refresh still creates a fresh identity and rejects them.
    @discardableResult
    public mutating func appendPage(_ page: [BriefRecord]) -> Int {
        var known = Set(briefs.map(\.id))
        var addedCount = 0
        for brief in page where known.insert(brief.id).inserted {
            feedOrder[brief.id] = feedOrder.count
            briefs.append(brief)
            addedCount += 1
            if brief.state == .read {
                readMarked.insert(brief.id)
            }
        }
        return addedCount
    }

    /// Record that a brief was actually opened. Returns true exactly
    /// once per unread brief — the caller then owes a mark-read POST.
    public mutating func markViewed(id: String) -> Bool {
        guard briefs.contains(where: { $0.id == id }), !readMarked.contains(id) else {
            return false
        }
        readMarked.insert(id)
        return true
    }

    /// Remove a brief from the displayed feed. Emptying the list is the
    /// caller's "no briefs to show" state.
    @discardableResult
    public mutating func remove(id: String) -> RemovedBrief? {
        guard let index = briefs.firstIndex(where: { $0.id == id }) else {
            return nil
        }
        let brief = briefs.remove(at: index)
        return RemovedBrief(brief: brief, index: index, feedIdentity: feedIdentity)
    }

    /// Restore a previously removed brief if a dismiss request fails.
    /// A refresh replaces the feed with a newer gateway answer; a rollback
    /// from the older feed must not reinsert stale data.
    public mutating func restore(_ removed: RemovedBrief) {
        guard removed.feedIdentity == feedIdentity else {
            return
        }
        guard !briefs.contains(where: { $0.id == removed.brief.id }) else {
            return
        }
        let currentOrder = Dictionary(uniqueKeysWithValues: briefs.enumerated().map { index, brief in
            (brief.id, index)
        })
        let originalFeedOrder = feedOrder
        briefs.insert(removed.brief, at: min(removed.index, briefs.count))
        briefs.sort { lhs, rhs in
            let lhsFeedOrder = originalFeedOrder[lhs.id] ?? Int.max
            let rhsFeedOrder = originalFeedOrder[rhs.id] ?? Int.max
            if lhsFeedOrder != rhsFeedOrder {
                return lhsFeedOrder < rhsFeedOrder
            }
            return (currentOrder[lhs.id] ?? Int.max) < (currentOrder[rhs.id] ?? Int.max)
        }
    }
}

/// Row-level plain-texting of a brief description: the Cognition Steward
/// writes markdown emphasis in it, and literal asterisks would read as
/// noise at row size. Detail views render the real markdown instead.
public func briefRowPlainDescription(_ markdown: String) -> String {
    markdown
        .replacingOccurrences(of: "**", with: "")
        .replacingOccurrences(of: "__", with: "")
}

/// The dismiss modal's snooze choices ("Not now"). `agentDecides`
/// sends no time — the Cognition Steward's feedback run picks when the brief
/// re-surfaces.
public enum BriefSnoozeChoice: Equatable, Sendable {
    case laterToday
    case tomorrow
    case pickATime(Date)
    case agentDecides

    /// Resolve to the `snoozeUntil` instant the dismiss POST carries.
    /// `laterToday` = three hours from now (a pragmatic "give me some
    /// air" horizon); `tomorrow` = 9am the next calendar day.
    public func resolvedTime(now: Date, calendar: Calendar = .current) -> Date? {
        switch self {
        case .laterToday:
            return now.addingTimeInterval(3 * 3600)
        case .tomorrow:
            let nextDay = calendar.date(byAdding: .day, value: 1, to: now) ?? now
            let startOfNextDay = calendar.startOfDay(for: nextDay)
            return calendar.date(byAdding: .hour, value: 9, to: startOfNextDay)
                ?? now.addingTimeInterval(24 * 3600)
        case .pickATime(let date):
            return date
        case .agentDecides:
            return nil
        }
    }
}
