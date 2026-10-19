// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

extension DailyBriefMessageRef {
    /// The id of the transcript turn this brief opens. Derived from the
    /// brief's message id, so it is the same on every page load and the
    /// transcript can tell which turns start a day.
    public var turnId: String {
        "brief-\(messageId)"
    }
}

/// One day of the Morning brief conversation: the brief, then the
/// conversation that followed it until the next brief.
@available(iOS 17.0, *)
struct DailyBriefDay: Identifiable, Equatable {
    let brief: DailyBriefMessageRef
    /// The brief's own turn first, then every turn after it that day.
    var turns: [AgentTurn]

    var id: String {
        brief.messageId
    }

    /// The person's messages that day.
    var replyCount: Int {
        turns.filter { turn in
            if case .user = turn { return true }
            return false
        }.count
    }
}

/// The Morning brief conversation's turns grouped by the brief that opened
/// each day.
@available(iOS 17.0, *)
struct DailyBriefTranscript: Equatable {
    /// Turns before the first loaded brief: the end of a day whose brief is
    /// on a page not loaded yet.
    var leading: [AgentTurn] = []
    /// Oldest first.
    var days: [DailyBriefDay] = []

    init(turns: [AgentTurn], briefs: [DailyBriefMessageRef]) {
        let briefByTurnId = Dictionary(briefs.map { ($0.turnId, $0) }) { _, last in last }
        for turn in turns {
            if let brief = briefByTurnId[turn.id] {
                days.append(DailyBriefDay(brief: brief, turns: [turn]))
            } else if days.isEmpty {
                leading.append(turn)
            } else {
                days[days.count - 1].turns.append(turn)
            }
        }
    }

    /// The day the conversation is about now. It is always shown open;
    /// every earlier day starts folded.
    var latest: DailyBriefDay? {
        days.last
    }
}

/// The words and dates of the Morning brief conversation, in the phone's
/// own calendar.
enum DailyBriefCopy {
    static let title = "Morning brief"
    static let composerPrompt = "Reply about today's brief…"

    /// What the composer says while idle in a conversation with this origin.
    static func composerPrompt(for origin: ConversationOrigin?) -> String {
        origin?.isDailyBrief == true ? composerPrompt : "Ask Omnesis"
    }

    /// "Today", "Yesterday" or a short date ("Tue 13 Oct" in en_GB) for a
    /// local `YYYY-MM-DD` day. Nil when `day` is not a date.
    static func dayLabel(_ day: String, now: Date, calendar: Calendar, locale: Locale) -> String? {
        label(day, now: now, calendar: calendar, locale: locale, template: "EEEdMMM")
    }

    /// The same day spelled out for VoiceOver ("Tuesday 13 October").
    static func spokenDayLabel(_ day: String, now: Date, calendar: Calendar, locale: Locale) -> String? {
        label(day, now: now, calendar: calendar, locale: locale, template: "EEEEdMMMM")
    }

    /// The local time a brief was sent ("07:02" in en_GB), or nil when the
    /// reference does not say.
    static func sentTime(_ sentAt: String?, calendar: Calendar, locale: Locale) -> String? {
        guard let sentAt, let date = instant(sentAt) else { return nil }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter.string(from: date)
    }

    /// "Based on 5 things".
    static func basedOn(_ count: Int) -> String {
        "Based on \(things(count))"
    }

    /// The one line a folded day shows: "Morning brief · 5 things · 2 replies".
    /// The count of things is left out until it is known, and nothing is
    /// said about a count of zero.
    static func foldedSummary(itemCount: Int?, replyCount: Int) -> String {
        var parts = [title]
        if let itemCount, itemCount > 0 { parts.append(things(itemCount)) }
        if replyCount > 0 { parts.append(replyCount == 1 ? "1 reply" : "\(replyCount) replies") }
        return parts.joined(separator: " · ")
    }

    static func things(_ count: Int) -> String {
        count == 1 ? "1 thing" : "\(count) things"
    }

    /// Midnight at the start of a local `YYYY-MM-DD` day.
    static func startOfDay(_ day: String, calendar: Calendar) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        guard let date = calendar.date(from: components) else { return nil }
        return calendar.startOfDay(for: date)
    }

    private static func label(
        _ day: String,
        now: Date,
        calendar: Calendar,
        locale: Locale,
        template: String
    )
        -> String? {
        guard let date = startOfDay(day, calendar: calendar) else { return nil }
        // Whole calendar days between the two midnights, so a day that is
        // 23 or 25 hours long across a clock change still counts as one.
        let today = calendar.startOfDay(for: now)
        switch calendar.dateComponents([.day], from: date, to: today).day {
        case 0: return "Today"
        case 1: return "Yesterday"
        default:
            let formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.timeZone = calendar.timeZone
            formatter.locale = locale
            formatter.setLocalizedDateFormatFromTemplate(template)
            return formatter.string(from: date)
        }
    }

    private static func instant(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)
    }
}

/// What the Morning brief conversation remembers while it is on screen:
/// which days are open, which "Based on" lists are open, and the items each
/// day's brief was based on.
///
/// The latest brief's day is always open with its list showing — sources
/// are what the reader most wants to check. Every earlier day starts folded
/// to one line, and its list starts closed when the day is opened.
@available(iOS 17.0, *)
@MainActor
@Observable
final class DailyBriefModel {
    enum ItemsState: Equatable {
        case loading
        case loaded(DailyBriefItems)
        case failed
    }

    let conversationId: String
    @ObservationIgnored private let loader: (any DailyBriefItemsLoading)?
    /// Items by brief day.
    private(set) var items: [String: ItemsState]
    /// Earlier days the reader opened, by brief message id.
    private(set) var openedDays: Set<String> = []
    /// "Based on" lists whose open state the reader changed, by brief
    /// message id. A list's default is open for the latest brief and closed
    /// for earlier ones; a toggle flips it.
    private(set) var toggledFooters: Set<String> = []
    /// The latest brief seen, by message id.
    private(set) var latestId: String?
    /// Why the last reaction to an item was not saved, by observation id.
    /// Cleared by the next reaction to that item.
    private(set) var reactionFailures: [String: any Error] = [:]
    /// Reactions sent per item, so a reply to an older one is ignored once
    /// a newer one has been shown.
    @ObservationIgnored private var reactionSerials: [String: Int] = [:]

    init(
        conversationId: String,
        loader: (any DailyBriefItemsLoading)?,
        preloaded: [DailyBriefItems] = []
    ) {
        self.conversationId = conversationId
        self.loader = loader
        self.items = Dictionary(preloaded.map { ($0.day, .loaded($0)) }) { _, last in last }
    }

    /// Note the latest brief. A newer brief arriving folds the day that was
    /// latest, as if the conversation had just been opened.
    func observeLatest(_ latest: DailyBriefMessageRef?) {
        guard let latest, latest.messageId != latestId else { return }
        if let previous = latestId {
            openedDays.remove(previous)
            toggledFooters.remove(previous)
        }
        latestId = latest.messageId
    }

    func isOpen(_ brief: DailyBriefMessageRef) -> Bool {
        brief.messageId == latestId || openedDays.contains(brief.messageId)
    }

    /// Open or fold an earlier day. The latest day does not fold.
    func toggleDay(_ brief: DailyBriefMessageRef) {
        guard brief.messageId != latestId else { return }
        if openedDays.remove(brief.messageId) == nil {
            openedDays.insert(brief.messageId)
        }
    }

    func isFooterOpen(_ brief: DailyBriefMessageRef) -> Bool {
        let openByDefault = brief.messageId == latestId
        return openByDefault != toggledFooters.contains(brief.messageId)
    }

    func toggleFooter(_ brief: DailyBriefMessageRef) {
        if toggledFooters.remove(brief.messageId) == nil {
            toggledFooters.insert(brief.messageId)
        }
    }

    /// How many things a day's brief was based on, once known.
    func itemCount(day: String) -> Int? {
        if case .loaded(let page) = items[day] { return page.items.count }
        return nil
    }

    /// When a day's brief was sent, as its items read says.
    func sentAt(day: String) -> String? {
        if case .loaded(let page) = items[day] { return page.sentAt }
        return nil
    }

    /// Fetch a day's items unless they are loaded or on their way. A failed
    /// fetch stays failed until `retry`.
    func load(day: String) async {
        switch items[day] {
        case .loading, .loaded, .failed: return
        case nil: await fetch(day: day)
        }
    }

    func retry(day: String) async {
        guard items[day] == .failed else { return }
        await fetch(day: day)
    }

    private func fetch(day: String) async {
        guard let loader else { return }
        items[day] = .loading
        do {
            let page = try await loader.items(conversationId: conversationId, day: day)
            items[day] = .loaded(page)
        } catch {
            items[day] = .failed
        }
    }

    // MARK: - Reactions

    /// Why the last reaction to an item was not saved, if it was not.
    func reactionFailure(observationId: String) -> (any Error)? {
        reactionFailures[observationId]
    }

    /// Set, replace or clear (`reaction: nil`) the owner's reaction to one
    /// of a day's items. The item shows the reaction at once; the gateway's
    /// answer replaces it, and a failure puts the previous reaction back and
    /// keeps the error for the row. Returns whether the gateway took it.
    @discardableResult
    func react(
        day: String,
        observationId: String,
        reaction: DailyBriefReaction.Kind?,
        note: String? = nil
    ) async -> Bool {
        guard let current = item(day: day, observationId: observationId) else { return false }
        let previous = current.reaction
        setReaction(reaction.map { DailyBriefReaction(kind: $0, note: note) }, day: day, observationId: observationId)
        reactionFailures[observationId] = nil
        let serial = (reactionSerials[observationId] ?? 0) + 1
        reactionSerials[observationId] = serial
        guard let loader else { return true }
        do {
            let settled = try await loader.react(
                conversationId: conversationId,
                day: day,
                observationId: observationId,
                reaction: reaction,
                note: note
            )
            guard reactionSerials[observationId] == serial else { return true }
            setReaction(settled, day: day, observationId: observationId)
            return true
        } catch {
            guard reactionSerials[observationId] == serial else { return false }
            setReaction(previous, day: day, observationId: observationId)
            reactionFailures[observationId] = error
            return false
        }
    }

    /// One of a loaded day's items.
    private func item(day: String, observationId: String) -> DailyBriefItem? {
        guard case .loaded(let page) = items[day] else { return nil }
        return page.items.first { $0.observationId == observationId }
    }

    private func setReaction(_ reaction: DailyBriefReaction?, day: String, observationId: String) {
        guard case .loaded(var page) = items[day],
              let index = page.items.firstIndex(where: { $0.observationId == observationId })
        else { return }
        page.items[index].reaction = reaction
        items[day] = .loaded(page)
    }
}

#if DEBUG
@available(iOS 17.0, *)
extension DailyBriefModel {
    /// Puts a day's items in a state directly, for previews of states a
    /// fetch passes through.
    func showForPreview(_ state: ItemsState, day: String) {
        items[day] = state
    }
}
#endif
