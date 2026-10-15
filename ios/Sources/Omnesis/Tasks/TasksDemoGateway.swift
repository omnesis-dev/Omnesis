// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG
import Foundation

/// A stand-in for the gateway's `/tasks` surface that behaves like it: it
/// keeps its own store, places each task in the journal views by its plan
/// and deadline, applies commands to the store, answers a command that no
/// longer applies with the gateway's 400, and undoes from a ledger. Reads
/// return the store as it now is.
///
/// It backs the Tasks UI tests (`DEMO_MENU_REVEAL=tasks`), which drive the
/// real screen and check what it shows after each change — so a screen that
/// keeps showing a task as it was is caught on the simulator, not on a phone.
actor TasksDemoGateway: TasksService {
    private var tasks: [TaskRecord]
    private var ledger: [(seq: Int, before: TaskRecord)] = []
    /// Notes saved by accepting a suggestion with a note, as the gateway's
    /// Tell Omnesis ledger would hold them.
    private(set) var notes: [(id: String?, taskId: String, text: String)] = []
    private var nextSeq = 100
    private let schedule: TaskSchedule
    /// The instant a task resolved "now" is stamped with.
    private let resolvedNow: String

    init(tasks: [TaskRecord], now: Date, schedule: TaskSchedule = TaskSchedule()) {
        self.tasks = tasks
        self.schedule = schedule
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.resolvedNow = formatter.string(from: now)
    }

    // MARK: - Reads

    func view(_ view: TaskViewKind, day: String, limit _: Int?, before _: String?) async throws -> TaskViewPage {
        let owned = tasks.filter { !$0.isResolved && isMine($0) }
        let listed: [TaskRecord] = switch view {
        case .today:
            owned.filter { place($0, day: day) == .today }.map { carried($0, day: day) }
                + tasks.filter { $0.isResolved && resolvedDay($0) == day && isMine($0) }
        case .month, .future, .anytime:
            owned.filter { place($0, day: day) == view }
        case .waiting:
            owned.filter { !$0.blockedBy.isEmpty || (!$0.actors.isEmpty && $0.actors.allSatisfy { !$0.isSelf }) }
        case .suggested:
            tasks.filter(\.isSuggestion)
        case .done:
            tasks.filter { $0.isResolved && isMine($0) }
                .sorted { ($0.resolvedAt ?? "") > ($1.resolvedAt ?? "") }
        }
        return TaskViewPage(view: view, day: day, tasks: listed, counts: counts(day: day))
    }

    func detail(id: String) async throws -> TaskDetail {
        guard let task = tasks.first(where: { $0.id == id }) else { throw GatewayClient.Error.notFound }
        return TaskDetail(task: task, history: [])
    }

    // MARK: - Commands

    func perform(_ action: TaskAction, on id: String) async throws -> TaskMutation {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { throw GatewayClient.Error.notFound }
        let task = tasks[index]
        let updated: TaskRecord
        let verb: String
        switch action {
        case .complete(let note):
            // A suggestion marked done becomes one of the person's own, done.
            try require(!task.isResolved, "Task is already resolved")
            updated = task.changed(
                state: .done,
                accepted: task.isSuggestion ? true : nil,
                completionNote: .some(note),
                resolvedAt: .some(resolvedNow)
            )
            verb = "Done"
        case .strike:
            try require(!task.isResolved, "Task is already resolved")
            updated = task.changed(state: .dismissed, resolvedAt: .some(resolvedNow))
            verb = "Struck"
        case .reopen:
            try require(task.isResolved, "Task is already open")
            updated = task.changed(state: .open, completionNote: .some(nil), resolvedAt: .some(nil))
            verb = "Reopened"
        case .migrate(let to):
            try require(!task.isResolved, "Task is already resolved")
            updated = task.changed(scheduledFor: .some(to))
            verb = "Moved"
        case .accept(let scheduledFor, let note, let noteId):
            try require(task.isSuggestion, "Task is already accepted")
            var plan = task.scheduledFor
            if case .set(let value) = scheduledFor { plan = value }
            updated = task.changed(accepted: true, scheduledFor: .some(plan))
            if let note { notes.append((id: noteId, taskId: task.id, text: note)) }
            verb = "Added to your tasks"
        case .ignore:
            // The loop stays open on the gateway; only the Tasks views drop it.
            try require(task.isSuggestion, "Task is already accepted")
            updated = task.changed(ignored: true)
            verb = "Ignored"
        case .edit(let title, _, let scheduledFor, _):
            var plan = task.scheduledFor
            if case .set(let value) = scheduledFor { plan = value }
            updated = task.changed(title: title, scheduledFor: .some(plan))
            verb = "Edited"
        case .confirm, .keep, .delete:
            updated = task
            verb = "Updated"
        }
        nextSeq += 1
        ledger.append((nextSeq, task))
        tasks[index] = updated
        return TaskMutation(task: updated, receipt: TaskReceipt(text: "\(verb): \(task.title)", undoSeq: nextSeq))
    }

    func undo(seq: Int) async throws -> TaskMutation {
        guard let entry = ledger.last(where: { $0.seq == seq }),
              let index = tasks.firstIndex(where: { $0.id == entry.before.id })
        else { throw GatewayClient.Error.serverError(status: 400, body: #"{"error":"Nothing to undo"}"#) }
        ledger.removeAll { $0.seq == seq }
        tasks[index] = entry.before
        return TaskMutation(task: entry.before, receipt: TaskReceipt(text: "Undone: \(entry.before.title)", undoSeq: nil))
    }

    // MARK: - Placement

    /// The journal view an open task belongs to on `day`: a deadline that
    /// has arrived brings it to today, whatever its plan.
    private func place(_ task: TaskRecord, day: String) -> TaskViewKind {
        if let due = task.dueDay, due <= day { return .today }
        guard let plan = task.scheduledFor else { return .anytime }
        if plan == "someday" { return .future }
        let month = String(day.prefix(7))
        if plan.count == 10 {
            if plan <= day { return .today }
            return plan.hasPrefix(month) ? .month : .future
        }
        if plan < month { return .today }
        return plan == month ? .month : .future
    }

    private func carried(_ task: TaskRecord, day: String) -> TaskRecord {
        guard let plan = task.scheduledFor, plan.count == 10, plan < day else { return task.changed(carried: false) }
        return task.changed(carried: true)
    }

    private func resolvedDay(_ task: TaskRecord) -> String? {
        task.resolvedAt.map { String($0.prefix(10)) }
    }

    /// The person's own task: anything but a suggestion they never took on.
    private func isMine(_ task: TaskRecord) -> Bool {
        task.origin != .brain || task.accepted
    }

    private func counts(day: String) -> TaskCounts {
        let owned = tasks.filter { !$0.isResolved && isMine($0) }
        let placed = owned.map { place($0, day: day) }
        return TaskCounts(
            today: placed.filter { $0 == .today }.count,
            month: placed.filter { $0 == .month }.count,
            future: placed.filter { $0 == .future }.count,
            anytime: placed.filter { $0 == .anytime }.count,
            waiting: owned.filter { !$0.blockedBy.isEmpty }.count,
            suggested: tasks.filter(\.isSuggestion).count,
            proposals: owned.filter { $0.proposedChange != nil }.count,
            carried: owned.filter { ($0.scheduledFor?.count == 10) && ($0.scheduledFor ?? "") < day }.count
        )
    }

    private func require(_ condition: Bool, _ message: String) throws {
        guard condition else {
            throw GatewayClient.Error.serverError(status: 400, body: #"{"error":"\#(message)"}"#)
        }
    }
}

extension TaskRecord {
    /// A copy with some fields changed; `.some(nil)` clears an optional.
    fileprivate func changed(
        title: String? = nil,
        state: State? = nil,
        accepted: Bool? = nil,
        ignored: Bool? = nil,
        scheduledFor: String?? = nil,
        carried: Bool? = nil,
        completionNote: String?? = nil,
        resolvedAt: String?? = nil
    )
        -> TaskRecord {
        TaskRecord(
            id: id,
            title: title ?? self.title,
            description: description,
            state: state ?? self.state ?? .open,
            origin: origin ?? .user,
            accepted: accepted ?? self.accepted,
            ignored: ignored ?? self.ignored,
            scheduledFor: scheduledFor ?? self.scheduledFor,
            deadline: deadline,
            dueDay: dueDay,
            carried: carried ?? self.carried,
            completionNote: completionNote ?? self.completionNote,
            proposedChange: proposedChange,
            actors: actors,
            blockedBy: blockedBy,
            documents: documents,
            createdAt: createdAt,
            lastUpdate: lastUpdate,
            resolvedAt: resolvedAt ?? self.resolvedAt
        )
    }
}
#endif
