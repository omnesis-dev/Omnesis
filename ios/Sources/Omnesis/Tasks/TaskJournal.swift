// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How the Tasks screen lays out and words what the gateway returns. Pure, so
/// the ordering a person reads and the sentences they see are covered by the
/// logic lane rather than only by a screenshot.
public enum TaskJournal {
    /// A run of rows under an optional heading.
    public struct Section: Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String?
        public let tasks: [TaskRecord]
    }

    /// The segments, in the order the bar shows them. Suggested holds the
    /// Brain's suggestions, which exist only on an experimental gateway, so
    /// it is offered only there.
    public static func segments(experimental: Bool) -> [TaskViewKind] {
        let all: [TaskViewKind] = [.today, .month, .future, .anytime, .waiting, .suggested, .done]
        return experimental ? all : all.filter { $0 != .suggested }
    }

    /// The segments either side of `view` in `segments` — the pages a swipe
    /// from `view` reaches, read ahead so they are already filled while the
    /// finger draws them in.
    public static func neighbours(of view: TaskViewKind, in segments: [TaskViewKind]) -> [TaskViewKind] {
        guard let index = segments.firstIndex(of: view) else { return [] }
        return [index - 1, index + 1].filter(segments.indices.contains).map { segments[$0] }
    }

    public static func label(for view: TaskViewKind) -> String {
        switch view {
        case .today: "Today"
        case .month: "Month"
        case .future: "Future"
        case .anytime: "Anytime"
        case .waiting: "Waiting"
        case .suggested: "Suggested"
        case .done: "Done"
        }
    }

    /// How many open tasks a view holds, from the counts every read carries.
    /// Done has no count: it is a history, not a list to work through.
    public static func count(of view: TaskViewKind, in counts: TaskCounts) -> Int {
        switch view {
        case .today: counts.today
        case .month: counts.month
        case .future: counts.future
        case .anytime: counts.anytime
        case .waiting: counts.waiting
        case .suggested: counts.suggested
        case .done: 0
        }
    }

    /// A segment's chip text: "Today (4)", or the bare label when the view
    /// holds nothing. Suggested is the exception — its count is the accent
    /// badge beside the label, because it asks for a decision.
    public static func segmentLabel(for view: TaskViewKind, counts: TaskCounts) -> String {
        let label = label(for: view)
        guard view != .suggested else { return label }
        let count = count(of: view, in: counts)
        return count > 0 ? "\(label) (\(count))" : label
    }

    /// The menu entry for the Tasks screen: "Tasks (4)" while today holds
    /// open tasks, plain "Tasks" otherwise.
    public static func menuLabel(todayCount: Int) -> String {
        todayCount > 0 ? "Tasks (\(todayCount))" : "Tasks"
    }

    /// The banner at the top of Today that leads to the Suggested view. Nil
    /// when there is nothing to review.
    public static func reviewBannerText(suggested: Int) -> String? {
        guard suggested > 0 else { return nil }
        return suggested == 1
            ? "Omnesis has created 1 task for your review"
            : "Omnesis has created \(suggested) tasks for your review"
    }

    /// Whether a view ends with the reminder that tasks are added through
    /// Tell Omnesis. Suggested and Done hold what Omnesis or the past put
    /// there, so the reminder would not answer anything a reader there asks.
    public static func showsCaptureHint(for view: TaskViewKind) -> Bool {
        view != .suggested && view != .done
    }

    /// Today reads like the day's page of a bullet journal: what was carried
    /// over from earlier days first, then what is planned or due today, then
    /// what got resolved today. Every other view is one run in the gateway's
    /// order. Empty sections are dropped.
    public static func sections(for view: TaskViewKind, tasks: [TaskRecord]) -> [Section] {
        guard view == .today else {
            return tasks.isEmpty ? [] : [Section(id: view.rawValue, title: nil, tasks: tasks)]
        }
        let carried = tasks.filter { !$0.isResolved && $0.carried }
        let planned = tasks.filter { !$0.isResolved && !$0.carried }
        let resolved = tasks.filter(\.isResolved)
        return [
            Section(id: "carried", title: "Carried over", tasks: carried),
            Section(id: "today", title: carried.isEmpty && resolved.isEmpty ? nil : "Today", tasks: planned),
            Section(id: "resolved", title: "Done today", tasks: resolved),
        ].filter { !$0.tasks.isEmpty }
    }

    /// One line of a view's list: a section heading or a task.
    public enum Entry: Equatable, Sendable, Identifiable {
        case heading(section: String, title: String, count: Int)
        case task(TaskRecord)

        /// A task keeps its id whichever section it is in, so moving
        /// between sections is a move of one line, never a new line beside
        /// a stale one.
        public var id: String {
            switch self {
            case .heading(let section, _, _): "heading:\(section)"
            case .task(let task): task.id
            }
        }
    }

    /// The view's sections as one list of lines, in reading order. The
    /// screen renders this one list rather than a list per section: a task
    /// that changes section in an update — completing a planned task moves
    /// it to "Done today" — must be the same line moving, or the screen can
    /// keep drawing it as it was.
    public static func entries(for view: TaskViewKind, tasks: [TaskRecord]) -> [Entry] {
        sections(for: view, tasks: tasks).flatMap { section -> [Entry] in
            let heading: [Entry] = section.title.map {
                [.heading(section: section.id, title: $0, count: section.tasks.count)]
            } ?? []
            return heading + section.tasks.map(Entry.task)
        }
    }

    /// What an empty view says, as a title and a line under it.
    public static func emptyState(for view: TaskViewKind) -> (title: String, detail: String) {
        switch view {
        case .today: ("Nothing for today", "Tasks planned for today, and those carried over, appear here.")
        case .month: ("Nothing else this month", "Tasks planned for later this month appear here.")
        case .future: ("Nothing planned further out", "Tasks for later months, and someday, appear here.")
        case .anytime: ("No unscheduled tasks", "Tasks without a day or deadline appear here.")
        case .waiting: ("Nothing waiting on others", "Tasks that depend on someone else appear here.")
        case .suggested: ("No suggestions", "When Omnesis spots something you may want to do, it appears here.")
        case .done: ("Nothing done yet", "Completed and struck tasks appear here.")
        }
    }

    /// The one line that introduces a change Omnesis proposes.
    public static func proposalHeadline(_ change: TaskProposedChange) -> String {
        switch change.kind {
        case .complete: "Omnesis thinks this is done"
        case .strike: "Omnesis thinks this no longer applies"
        case .edit: "Omnesis suggests a change"
        case nil: "Omnesis suggests a change"
        }
    }

    /// An edit proposal's new values, in words: "Title: Book the venue ·
    /// Plan: Tomorrow". Nil when the proposal names no field.
    public static func proposalFields(
        _ fields: TaskProposedFields?,
        schedule: TaskSchedule,
        today: String
    )
        -> String? {
        guard let fields else { return nil }
        var parts: [String] = []
        if let title = fields.title { parts.append("Title: \(title)") }
        if let planned = fields.scheduledFor {
            parts.append("Plan: \(schedule.scheduleLabel(planned, today: today) ?? planned)")
        }
        if let deadline = fields.deadline,
           let label = schedule.deadlineLabel(deadline, dueDay: nil, today: today) {
            parts.append(label)
        }
        if fields.description != nil { parts.append("New details") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// A history line's verb.
    public static func eventTitle(_ event: TaskEvent) -> String {
        switch event.kind {
        case "created": "Added"
        case "accepted": "Accepted"
        case "ignored": "Ignored"
        // Older gateways dismissed a declined suggestion.
        case "refused": "Dismissed"
        case "migrated": "Moved"
        case "completed": "Done"
        case "struck": "Struck"
        case "edited": "Edited"
        case "reopened": "Reopened"
        case "proposal_confirmed": "Change confirmed"
        case "proposal_kept": "Kept as it was"
        case "auto_applied": event.change == "complete" ? "Marked done by Omnesis" : "Updated by Omnesis"
        case "auto_accepted": "Added by Omnesis"
        case "withheld": "Withheld by Omnesis"
        case "undone": "Undone"
        default: "Note"
        }
    }

    /// The kinds of change Omnesis makes on its own: applying a change,
    /// adding a task, or withholding one. Their titles say so.
    private static let autonomousKinds: Set<String> = ["auto_applied", "auto_accepted", "withheld"]

    /// Where a change came from, for the history line's caption. Nil for a
    /// change made on this screen, which needs no attribution, and for a
    /// change Omnesis made on its own, whose title already says so.
    public static func eventSource(_ event: TaskEvent) -> String? {
        guard !autonomousKinds.contains(event.kind) else { return nil }
        return switch event.surface {
        case "conversation": "In a conversation"
        case "note": "From a note"
        case "brain": "By Omnesis"
        default: nil
        }
    }

    /// The change a task's history offers to undo in place: the newest
    /// entry, when Omnesis made it on its own and it is still the change
    /// undo would revert. Nil otherwise.
    public static func autoAppliedUndoSeq(_ detail: TaskDetail) -> Int? {
        guard let newest = detail.history.first,
              autonomousKinds.contains(newest.kind),
              newest.seq == detail.undoSeq
        else { return nil }
        return newest.seq
    }

    /// The names of the other people a task involves.
    public static func people(_ task: TaskRecord) -> [String] {
        task.actors.filter { !$0.isSelf }.compactMap(\.name).filter { !$0.isEmpty }
    }

    /// How many of a task's documents its row lists before "+N more".
    public static let documentsShown = 3

    /// The documents a task's row lists, and how many it holds back: all of
    /// them once the person asked for more, otherwise the first few. Holding
    /// back a single document would take as much room as listing it, so a
    /// list one longer than the limit is shown whole.
    public static func documents(_ task: TaskRecord, showAll: Bool) -> (shown: [TaskDocument], hidden: Int) {
        let all = task.documents
        if showAll || all.count <= documentsShown + 1 { return (all, 0) }
        return (Array(all.prefix(documentsShown)), all.count - documentsShown)
    }
}
