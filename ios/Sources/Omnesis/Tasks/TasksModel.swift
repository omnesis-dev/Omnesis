// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// The `/tasks` calls the Tasks screen makes, as a seam so the screen's state
/// machine runs in tests without a gateway.
public protocol TasksService: Sendable {
    func view(_ view: TaskViewKind, day: String, limit: Int?, before: String?) async throws -> TaskViewPage
    func detail(id: String) async throws -> TaskDetail
    func perform(_ action: TaskAction, on id: String) async throws -> TaskMutation
    func undo(seq: Int) async throws -> TaskMutation
}

extension TasksClient: TasksService {}

/// The bottom-of-screen confirmation after a change: what happened, and the
/// way back when there is one.
public struct TaskToast: Equatable, Sendable, Identifiable {
    public let id: Int
    public let text: String
    /// Present when the change can be undone.
    public let undoSeq: Int?
    public let isError: Bool
}

/// The Tasks screen's state: the selected view, its rows, and the toast.
/// Every change goes to the gateway and the view is re-read afterwards,
/// because one command can move a task between sections or views
/// (completing a carried task drops it from "Carried over" into "Done
/// today"). Only completing from the circle is applied before the gateway
/// answers — it is the one gesture that has to feel instant.
@available(iOS 17.0, macOS 14.0, *)
@MainActor
@Observable
public final class TasksModel {
    public private(set) var selected: TaskViewKind = .today
    public private(set) var tasks: [TaskRecord] = []
    public private(set) var counts = TaskCounts()
    public private(set) var loading = false
    public private(set) var loadError: Error?
    /// Whether the Done history has older entries to page in.
    public private(set) var canLoadMoreDone = false
    public private(set) var loadingMore = false
    public private(set) var toast: TaskToast?
    /// Tasks with a command in flight; their controls are disabled.
    public private(set) var busyIds: Set<String> = []

    @ObservationIgnored private let service: TasksService?
    @ObservationIgnored private let schedule: TaskSchedule
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var loadGeneration = 0
    @ObservationIgnored private var toastCounter = 0

    static let doneLimit = 50

    public init(
        service: TasksService?,
        schedule: TaskSchedule = TaskSchedule(),
        now: @escaping () -> Date = Date.init
    ) {
        self.service = service
        self.schedule = schedule
        self.now = now
    }

    /// A model that shows fixed content and talks to nothing — previews and
    /// snapshots.
    public static func fixture(
        selected: TaskViewKind = .today,
        tasks: [TaskRecord],
        counts: TaskCounts = .init(),
        toast: TaskToast? = nil,
        loadError: Error? = nil,
        now: Date = Date()
    )
        -> TasksModel {
        let model = TasksModel(service: nil, now: { now })
        model.selected = selected
        model.tasks = tasks
        model.counts = counts
        model.toast = toast
        model.loadError = loadError
        return model
    }

    /// The device's local day, `YYYY-MM-DD`.
    public var today: String {
        schedule.day(now())
    }

    public var sections: [TaskJournal.Section] {
        TaskJournal.sections(for: selected, tasks: tasks)
    }

    /// `sections` as the one list of lines the screen draws.
    public var entries: [TaskJournal.Entry] {
        TaskJournal.entries(for: selected, tasks: tasks)
    }

    // MARK: - Reading

    public func select(_ view: TaskViewKind) async {
        guard view != selected else { return }
        selected = view
        tasks = []
        canLoadMoreDone = false
        await load()
    }

    /// Re-read the selected view. `showSpinner` false keeps the rows on
    /// screen while it loads (pull to refresh, after a command).
    public func load(showSpinner: Bool = true) async {
        guard let service else {
            // Unpaired, or a fixture: keep what is shown, and say why nothing
            // can load only when there is nothing to show.
            if tasks.isEmpty { loadError = URLError(.cannotConnectToHost) }
            return
        }
        loadGeneration &+= 1
        let generation = loadGeneration
        let view = selected
        if showSpinner { loading = true }
        defer { if generation == loadGeneration { loading = false } }
        do {
            let limit = view == .done ? Self.doneLimit : nil
            let page = try await service.view(view, day: today, limit: limit, before: nil)
            guard generation == loadGeneration else { return }
            tasks = page.tasks
            counts = page.counts
            canLoadMoreDone = view == .done && page.tasks.count >= Self.doneLimit
            loadError = nil
        } catch {
            guard generation == loadGeneration else { return }
            loadError = error
        }
    }

    /// Page in older Done history, resolved before the oldest row shown.
    public func loadMoreDone() async {
        guard let service, selected == .done, canLoadMoreDone, !loadingMore,
              let before = tasks.last?.resolvedAt
        else { return }
        let generation = loadGeneration
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await service.view(.done, day: today, limit: Self.doneLimit, before: before)
            guard generation == loadGeneration else { return }
            let known = Set(tasks.map(\.id))
            tasks += page.tasks.filter { !known.contains($0.id) }
            canLoadMoreDone = page.tasks.count >= Self.doneLimit
        } catch {
            guard generation == loadGeneration else { return }
            showError(error)
        }
    }

    public func detail(id: String) async throws -> TaskDetail {
        guard let service else { throw URLError(.cannotConnectToHost) }
        return try await service.detail(id: id)
    }

    // MARK: - Commands

    /// The bullet tap: complete an open task, or reopen a resolved one. The
    /// row changes before the gateway answers and changes back if it refuses.
    public func tapBullet(_ task: TaskRecord) async {
        guard !busyIds.contains(task.id) else { return }
        let action: TaskAction = task.isResolved ? .reopen : .complete(note: nil)
        replace(task.id, with: task.with(state: task.isResolved ? .open : .done))
        await run(action, on: task.id) { self.replace(task.id, with: task) }
    }

    /// Any other command on a task. Returns whether the gateway accepted it.
    @discardableResult
    public func perform(_ action: TaskAction, on task: TaskRecord) async -> Bool {
        guard !busyIds.contains(task.id) else { return false }
        return await run(action, on: task.id)
    }

    public func undo(_ toast: TaskToast) async {
        guard let service, let seq = toast.undoSeq else { return }
        dismissToast()
        do {
            let mutation = try await service.undo(seq: seq)
            show(text: mutation.receipt.text, undoSeq: nil, isError: false)
        } catch {
            showError(error)
        }
        await load(showSpinner: false)
    }

    public func dismissToast() {
        toast = nil
    }

    /// Dismiss `toast` only if it is still the one showing — the auto-hide
    /// timer of an older toast must not take down a newer one.
    public func dismissToast(id: Int) {
        if toast?.id == id { toast = nil }
    }

    // MARK: - Internals

    /// Sends a command. `rollback` undoes an optimistic change when the
    /// gateway refuses, before any re-read shows what it holds instead.
    @discardableResult
    private func run(_ action: TaskAction, on id: String, rollback: (() -> Void)? = nil) async -> Bool {
        guard let service else { return false }
        busyIds.insert(id)
        defer { busyIds.remove(id) }
        do {
            let mutation = try await service.perform(action, on: id)
            // The row shows the task as the gateway now holds it straight
            // away — an accepted suggestion loses its Accept — and the view
            // is re-read to move it wherever it now belongs.
            if let task = mutation.task { replace(id, with: task) }
            showReceipt(mutation.receipt)
            await load(showSpinner: false)
            return true
        } catch {
            rollback?()
            showError(error)
            if Self.isRefusal(error) { await load(showSpinner: false) }
            return false
        }
    }

    /// Whether the gateway refused a command on what it holds — the task
    /// changed elsewhere (409), was already accepted or is no longer what
    /// the command expects (400, 422), or is gone (404). The screen was
    /// showing something stale, so it is re-read. Authorization and
    /// transport failures say nothing about the task and leave it.
    static func isRefusal(_ error: Error) -> Bool {
        guard let gateway = error as? GatewayClient.Error else { return false }
        switch gateway {
        case .notFound: return true
        case .serverError(let status, _): return (400 ..< 500).contains(status)
        default: return false
        }
    }

    private func replace(_ id: String, with task: TaskRecord) {
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { return }
        tasks[index] = task
    }

    private func showReceipt(_ receipt: TaskReceipt) {
        show(text: receipt.text, undoSeq: receipt.undoSeq, isError: false)
    }

    private func showError(_ error: Error) {
        show(text: Self.message(for: error), undoSeq: nil, isError: true)
    }

    private func show(text: String, undoSeq: Int?, isError: Bool) {
        toastCounter &+= 1
        toast = TaskToast(id: toastCounter, text: text, undoSeq: undoSeq, isError: isError)
    }

    /// One sentence for a failed command.
    static func message(for error: Error) -> String {
        if let gateway = error as? GatewayClient.Error {
            switch gateway {
            case .notFound: return "That task no longer exists."
            case .serverError(409, _): return "That task changed elsewhere. Showing it as it is now."
            case .serverError:
                if let message = gateway.gatewayMessage, !message.isEmpty { return message }
            case .unauthorized, .forbidden: return "The gateway refused the change. Re-pair this phone."
            default: break
            }
        }
        if error is URLError { return "Couldn't reach the gateway. Try again." }
        return "Couldn't save the change. Try again."
    }
}
