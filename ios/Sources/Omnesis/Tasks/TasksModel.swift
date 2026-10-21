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
    func startConversation(about id: String) async throws -> ConversationSummary
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

/// One journal view as the screen last read it.
public struct TaskViewState {
    public var tasks: [TaskRecord] = []
    /// A read is in flight; the page shows a spinner only while it has no
    /// rows to show instead.
    public var loading = false
    public var loadError: Error?
    /// Whether the Done history has older entries to page in.
    public var canLoadMoreDone = false
    /// Whether the view has been read at all.
    public var loaded = false
    /// Whether a command may have changed what the view holds since it was
    /// read: it is still shown, and read again before it is next reached.
    public var stale = false
}

/// The Tasks screen's state: the selected view, every view it has read, and
/// the toast.
///
/// Views are kept once read, so swiping between them shows each at once; a
/// view is read again whenever it is selected, and the views beside the
/// selected one are read ahead (`prefetch`) so a swipe draws in a filled
/// page. Every change goes to the gateway and the selected view is re-read
/// afterwards, because one command can move a task between sections or
/// views (completing a carried task drops it from "Carried over" into "Done
/// today"); the other views are marked stale for the same reason. Only
/// completing from the circle is applied before the gateway answers — it is
/// the one gesture that has to feel instant.
@available(iOS 17.0, macOS 14.0, *)
@MainActor
@Observable
public final class TasksModel {
    public private(set) var selected: TaskViewKind = .today
    public private(set) var pages: [TaskViewKind: TaskViewState] = [:]
    public private(set) var counts = TaskCounts()
    public private(set) var loadingMore = false
    public private(set) var toast: TaskToast?
    /// Tasks with a command in flight; their controls are disabled.
    public private(set) var busyIds: Set<String> = []
    /// Bumped each time views go stale, so the screen reads ahead again.
    public private(set) var invalidations = 0

    @ObservationIgnored private let service: TasksService?
    @ObservationIgnored private let schedule: TaskSchedule
    @ObservationIgnored private let now: () -> Date
    @ObservationIgnored private var generations: [TaskViewKind: Int] = [:]
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
        model.pages[selected] = TaskViewState(tasks: tasks, loadError: loadError, loaded: true)
        model.counts = counts
        model.toast = toast
        return model
    }

    /// The device's local day, `YYYY-MM-DD`.
    public var today: String {
        schedule.day(now())
    }

    /// `view` as last read; empty and unread before its first read.
    public func page(_ view: TaskViewKind) -> TaskViewState {
        pages[view] ?? TaskViewState()
    }

    /// The selected view's rows, read state and error — conveniences for
    /// callers that only ever look at the view on screen.
    public var tasks: [TaskRecord] {
        page(selected).tasks
    }

    public var loading: Bool {
        page(selected).loading
    }

    public var loadError: Error? {
        page(selected).loadError
    }

    // MARK: - Reading

    /// Make `view` the selected one, showing what was last read of it. The
    /// screen reads it again (`load`) once it is selected.
    public func show(_ view: TaskViewKind) {
        if view != selected { selected = view }
    }

    /// Select `view` and read it.
    public func select(_ view: TaskViewKind) async {
        guard view != selected else { return }
        show(view)
        await load()
    }

    /// Re-read the selected view. `showSpinner` false keeps the page as it is
    /// while it loads (pull to refresh, after a command); a page with rows
    /// keeps them on screen either way.
    public func load(showSpinner: Bool = true) async {
        await load(selected, showSpinner: showSpinner)
    }

    /// Re-read the view the screen has just reached: a page read before
    /// keeps its rows on screen meanwhile, one never read shows a spinner.
    public func revisit() async {
        await load(selected, showSpinner: !page(selected).loaded)
    }

    /// Read ahead each of `views` that has not been read, or has gone stale,
    /// so a swipe to it draws in a filled page. Without a gateway there is
    /// nothing to read and nothing to report.
    public func prefetch(_ views: [TaskViewKind]) async {
        guard service != nil else { return }
        for view in views where view != selected {
            // A read-ahead overtaken by a newer one stops here rather than
            // restarting reads the newer one has in flight.
            guard !Task.isCancelled else { return }
            let page = page(view)
            if !page.loading, !page.loaded || page.stale { await load(view, showSpinner: true) }
        }
    }

    /// Read `view`. `showSpinner` false leaves its page as it is while it
    /// loads.
    public func load(_ view: TaskViewKind, showSpinner: Bool) async {
        guard let service else {
            // Unpaired, or a fixture: keep what is shown, and say why nothing
            // can load only when nothing was ever there to show.
            if !page(view).loaded { pages[view, default: TaskViewState()].loadError = URLError(.cannotConnectToHost) }
            return
        }
        let generation = (generations[view] ?? 0) &+ 1
        generations[view] = generation
        if showSpinner { pages[view, default: TaskViewState()].loading = true }
        defer { if generation == generations[view] { pages[view]?.loading = false } }
        do {
            let limit = view == .done ? Self.doneLimit : nil
            let read = try await service.view(view, day: today, limit: limit, before: nil)
            guard generation == generations[view] else { return }
            pages[view] = TaskViewState(
                tasks: read.tasks,
                canLoadMoreDone: view == .done && read.tasks.count >= Self.doneLimit,
                loaded: true
            )
            counts = read.counts
        } catch {
            // A read abandoned because the screen moved on is not a failure:
            // the view is simply read again when it is next wanted.
            guard generation == generations[view], !Self.isCancellation(error) else { return }
            pages[view, default: TaskViewState()].loadError = error
        }
    }

    /// Page in older Done history, resolved before the oldest row shown.
    public func loadMoreDone() async {
        guard let service, selected == .done, page(.done).canLoadMoreDone, !loadingMore,
              let before = page(.done).tasks.last?.resolvedAt
        else { return }
        let generation = generations[.done]
        loadingMore = true
        defer { loadingMore = false }
        do {
            let older = try await service.view(.done, day: today, limit: Self.doneLimit, before: before)
            guard generation == generations[.done], var done = pages[.done] else { return }
            let known = Set(done.tasks.map(\.id))
            done.tasks += older.tasks.filter { !known.contains($0.id) }
            done.canLoadMoreDone = older.tasks.count >= Self.doneLimit
            pages[.done] = done
        } catch {
            guard generation == generations[.done] else { return }
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
        guard let seq = toast.undoSeq else { return }
        await undo(seq: seq)
    }

    /// Undo the change recorded as `seq` — a receipt's, or one a task's
    /// history offers — and show what the undo did. Returns whether the
    /// gateway accepted it.
    @discardableResult
    public func undo(seq: Int) async -> Bool {
        guard let service else { return false }
        dismissToast()
        var undone = false
        do {
            let mutation = try await service.undo(seq: seq)
            present(text: mutation.receipt.text, undoSeq: nil, isError: false)
            undone = true
        } catch {
            showError(error)
        }
        await reread()
        return undone
    }

    /// Starts a new chat about `task` and returns its conversation id, or
    /// nil after showing why it could not be started.
    public func startConversation(about task: TaskRecord) async -> String? {
        guard let service, !busyIds.contains(task.id) else { return nil }
        busyIds.insert(task.id)
        defer { busyIds.remove(task.id) }
        do {
            return try await service.startConversation(about: task.id).sessionId
        } catch {
            present(text: Self.conversationMessage(for: error), undoSeq: nil, isError: true)
            if Self.isRefusal(error) { await reread() }
            return nil
        }
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
            // away — an accepted suggestion loses its Accept — and the views
            // are re-read to move it wherever it now belongs.
            if let task = mutation.task { replace(id, with: task) }
            showReceipt(mutation.receipt)
            await reread()
            return true
        } catch {
            rollback?()
            showError(error)
            if Self.isRefusal(error) { await reread() }
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

    /// After a change: the selected view is read again at once, and every
    /// other view read so far is marked stale, to be read again before it
    /// is next reached.
    private func reread() async {
        var invalidated = false
        for view in pages.keys where view != selected {
            if pages[view]?.loading == true {
                // A read that began before the change would land what the
                // view held before it: drop it, and read again.
                generations[view, default: 0] &+= 1
                pages[view]?.loading = false
                invalidated = true
            } else if pages[view]?.loaded == true {
                pages[view]?.stale = true
                invalidated = true
            }
        }
        if invalidated { invalidations &+= 1 }
        await load(showSpinner: false)
    }

    /// Shows `task` in place of its row in every view that lists it.
    private func replace(_ id: String, with task: TaskRecord) {
        for view in pages.keys {
            guard let index = pages[view]?.tasks.firstIndex(where: { $0.id == id }) else { continue }
            pages[view]?.tasks[index] = task
        }
    }

    /// Whether `error` is a read abandoned by its caller rather than a failure.
    static func isCancellation(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    private func showReceipt(_ receipt: TaskReceipt) {
        present(text: receipt.text, undoSeq: receipt.undoSeq, isError: false)
    }

    private func showError(_ error: Error) {
        present(text: Self.message(for: error), undoSeq: nil, isError: true)
    }

    private func present(text: String, undoSeq: Int?, isError: Bool) {
        toastCounter &+= 1
        toast = TaskToast(id: toastCounter, text: text, undoSeq: undoSeq, isError: isError)
    }

    /// One sentence for a chat that could not be started.
    static func conversationMessage(for error: Error) -> String {
        if let gateway = error as? GatewayClient.Error {
            switch gateway {
            case .notFound: return "That task no longer exists."
            case .unauthorized, .forbidden: return "The gateway refused the chat. Re-pair this phone."
            // 503 when no agent model is available; the gateway says which.
            case .serverError:
                if let message = gateway.gatewayMessage, !message.isEmpty { return message }
            default: break
            }
        }
        if error is URLError { return "Couldn't reach the gateway. Try again." }
        return "Couldn't start a chat about this task. Try again."
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
