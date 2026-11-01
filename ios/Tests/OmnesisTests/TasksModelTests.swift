// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

// MARK: - Screen model

@available(iOS 17.0, macOS 14.0, *)
@MainActor
final class TasksModelTests: XCTestCase {
    /// A gateway stand-in that records calls and answers from a script.
    private actor FakeService: TasksService {
        var calls: [String] = []
        var page = TaskViewPage(view: .today, day: "2026-10-14", tasks: [])
        /// Pages answered for one view, ahead of `page`.
        var pages: [TaskViewKind: TaskViewPage] = [:]
        var failNext: Error?
        var failNextRead: Error?

        func setPage(_ page: TaskViewPage) {
            self.page = page
        }

        func setPage(_ page: TaskViewPage, for view: TaskViewKind) {
            pages[view] = page
        }

        func setFailNextRead(_ error: Error) {
            failNextRead = error
        }

        func setFailNext(_ error: Error?) {
            failNext = error
        }

        func view(_ view: TaskViewKind, day: String, limit: Int?, before: String?) async throws -> TaskViewPage {
            calls.append("view \(view.rawValue) \(day)")
            if let failNextRead {
                self.failNextRead = nil
                throw failNextRead
            }
            return pages[view] ?? page
        }

        func detail(id: String) async throws -> TaskDetail {
            calls.append("detail \(id)")
            return TaskDetail(task: TaskRecord(id: id, title: id), history: [])
        }

        func perform(_ action: TaskAction, on id: String) async throws -> TaskMutation {
            calls.append("\(action.name) \(id)")
            return try respond()
        }

        func undo(seq: Int) async throws -> TaskMutation {
            calls.append("undo \(seq)")
            return TaskMutation(task: nil, receipt: TaskReceipt(text: "Undone", undoSeq: nil))
        }

        func startConversation(about id: String) async throws -> ConversationSummary {
            throw GatewayClient.Error.notFound
        }

        private func respond() throws -> TaskMutation {
            if let failNext {
                self.failNext = nil
                throw failNext
            }
            return TaskMutation(task: nil, receipt: TaskReceipt(text: "Done: Pay the invoice", undoSeq: 7))
        }
    }

    private let now: Date = {
        var components = DateComponents()
        components.year = 2026
        components.month = 10
        components.day = 14
        components.hour = 9
        return Calendar.current.date(from: components)!
    }()

    private func model(_ service: FakeService) -> TasksModel {
        TasksModel(service: service, now: { [now] in now })
    }

    func testLoadSendsTheLocalDay() async {
        let service = FakeService()
        let task = TaskRecord(id: "t", title: "Pay the invoice")
        await service.setPage(TaskViewPage(view: .today, day: "2026-10-14", tasks: [task], counts: .init(suggested: 3)))
        let model = model(service)
        await model.load()
        let calls = await service.calls
        XCTAssertEqual(calls, ["view today 2026-10-14"])
        XCTAssertEqual(model.tasks, [task])
        XCTAssertEqual(model.counts.suggested, 3)
    }

    func testWidgetDateContextReadsSelectedDayWithoutChangingActionCalendar() async {
        let service = FakeService()
        let model = model(service)
        await model.load()
        model.openJournal(TaskWidgetDeepLink(view: .month, day: "2027-01-01"))
        XCTAssertTrue(model.pages.isEmpty)
        XCTAssertEqual(model.today, "2026-10-14")
        XCTAssertEqual(model.readDay, "2027-01-01")
        XCTAssertEqual(model.selected, .month)
        await model.load()
        model.returnToToday()
        XCTAssertNil(model.referenceDay)
        XCTAssertEqual(model.selected, .today)
        await model.load()
        let calls = await service.calls
        XCTAssertEqual(calls, ["view today 2026-10-14", "view month 2027-01-01", "view today 2026-10-14"])
    }

    func testInvalidWidgetDateDoesNotChangeJournal() {
        let service = FakeService()
        let model = model(service)
        model.openJournal(TaskWidgetDeepLink(view: .today, day: "2026-02-30"))
        XCTAssertNil(model.referenceDay)
        XCTAssertEqual(model.selected, .today)
    }

    func testConfirmedEditsAndUndoNotifyWidgetsWithUnchangedCountsInEitherDateContext() async {
        for futureContext in [false, true] {
            let service = FakeService()
            var refreshes = 0
            let model = TasksModel(service: service, onMutation: { refreshes += 1 }, now: { [now] in now })
            if futureContext {
                model.openJournal(TaskWidgetDeepLink(view: .month, day: "2027-01-01"))
            }
            await model.load()
            let counts = model.counts
            let task = TaskRecord(id: "sketchbook", title: "Choose a sketchbook")
            let edit = TaskAction.edit(
                title: "Choose a travel sketchbook", description: nil, scheduledFor: .unchanged, deadline: .unchanged
            )
            let edited = await model.perform(edit, on: task)
            XCTAssertTrue(edited)
            XCTAssertEqual(model.counts, counts)
            XCTAssertEqual(refreshes, 1, "a title-only edit must refresh widgets even on a future page")
            let undone = await model.undo(seq: 7)
            XCTAssertTrue(undone)
            XCTAssertEqual(model.counts, counts)
            XCTAssertEqual(refreshes, 2)
            await service.setFailNext(URLError(.notConnectedToInternet))
            let rejected = await model.perform(edit, on: task)
            XCTAssertFalse(rejected)
            XCTAssertEqual(refreshes, 2, "a failed mutation must not publish a widget refresh")
        }
    }

    func testBulletCompletesThenShowsUndoableReceipt() async {
        let service = FakeService()
        let task = TaskRecord(id: "t", title: "Pay the invoice")
        await service.setPage(TaskViewPage(view: .today, day: "2026-10-14", tasks: [task]))
        let model = model(service)
        await model.load()
        await model.tapBullet(task)
        let calls = await service.calls
        XCTAssertEqual(calls, ["view today 2026-10-14", "complete t", "view today 2026-10-14"])
        XCTAssertEqual(model.toast?.text, "Done: Pay the invoice")
        XCTAssertEqual(model.toast?.undoSeq, 7)

        let toast = try? XCTUnwrap(model.toast)
        if let toast { await model.undo(toast) }
        let afterUndo = await service.calls
        XCTAssertEqual(afterUndo.suffix(2), ["undo 7", "view today 2026-10-14"])
        XCTAssertEqual(model.toast?.text, "Undone")
        XCTAssertNil(model.toast?.undoSeq)
    }

    func testUndoBySeqFromHistoryShowsTheReceiptAndRereads() async {
        let service = FakeService()
        let model = model(service)
        let undone = await model.undo(seq: 52)
        XCTAssertTrue(undone)
        let calls = await service.calls
        XCTAssertEqual(calls, ["undo 52", "view today 2026-10-14"])
        XCTAssertEqual(model.toast?.text, "Undone")
        XCTAssertNil(model.toast?.undoSeq)
    }

    func testRefusedBulletRestoresTheRow() async {
        let service = FakeService()
        let task = TaskRecord(id: "t", title: "Pay the invoice")
        await service.setPage(TaskViewPage(view: .today, day: "2026-10-14", tasks: [task]))
        let model = model(service)
        await model.load()
        await service.setFailNext(GatewayClient.Error.notFound)
        await model.tapBullet(task)
        XCTAssertEqual(model.tasks.first?.state, .open)
        XCTAssertEqual(model.toast?.isError, true)
        XCTAssertEqual(model.toast?.text, "That task no longer exists.")
    }

    func testLoadKeepsEveryViewCount() async {
        let service = FakeService()
        let counts = TaskCounts(today: 4, month: 10, future: 3, anytime: 2, waiting: 1, suggested: 2)
        await service.setPage(TaskViewPage(view: .today, day: "2026-10-14", tasks: [], counts: counts))
        let model = model(service)
        await model.load()
        XCTAssertEqual(model.counts, counts)
    }

    func testSelectingAViewReloads() async {
        let service = FakeService()
        let model = model(service)
        await model.select(.suggested)
        XCTAssertEqual(model.selected, .suggested)
        let calls = await service.calls
        XCTAssertEqual(calls, ["view suggested 2026-10-14"])
    }

    /// A view read once is shown again at once when it is selected, before
    /// the read that refreshes it lands — a swipe back never shows an empty
    /// page.
    func testAViewReadOnceIsShownAtOnceWhenSelectedAgain() async {
        let service = FakeService()
        let today = TaskRecord(id: "t", title: "Pay the invoice")
        let month = TaskRecord(id: "m", title: "Book the venue tour", scheduledFor: "2026-10")
        await service.setPage(TaskViewPage(view: .today, day: "2026-10-14", tasks: [today]), for: .today)
        await service.setPage(TaskViewPage(view: .month, day: "2026-10-14", tasks: [month]), for: .month)
        let model = model(service)
        await model.load()
        await model.select(.month)
        XCTAssertEqual(model.tasks, [month])
        model.show(.today)
        XCTAssertEqual(model.tasks, [today], "Today is shown from what was read before")
        XCTAssertEqual(model.page(.month).tasks, [month], "Month keeps what it read")
    }

    /// Reading ahead reads each neighbour once; the selected view and views
    /// already read are left alone.
    func testPrefetchReadsOnlyViewsNotYetRead() async {
        let service = FakeService()
        let model = model(service)
        await model.load()
        await model.prefetch([.today, .month])
        await model.prefetch([.month])
        let calls = await service.calls
        XCTAssertEqual(calls, ["view today 2026-10-14", "view month 2026-10-14"])
        XCTAssertTrue(model.page(.month).loaded)
        XCTAssertEqual(model.selected, .today, "reading ahead does not turn the page")
    }

    /// A change re-reads the selected view at once and marks every other
    /// view read so far stale, so the read-ahead fetches the neighbours again.
    func testAChangeMarksTheOtherViewsStale() async {
        let service = FakeService()
        let task = TaskRecord(id: "t", title: "Pay the invoice")
        await service.setPage(TaskViewPage(view: .today, day: "2026-10-14", tasks: [task]))
        let model = model(service)
        await model.load()
        await model.prefetch([.month])
        let before = model.invalidations
        await model.tapBullet(task)
        XCTAssertTrue(model.page(.month).stale)
        XCTAssertFalse(model.page(.today).stale)
        XCTAssertEqual(model.invalidations, before + 1)
        await model.prefetch([.month])
        XCTAssertFalse(model.page(.month).stale)
        let calls = await service.calls
        XCTAssertEqual(calls.filter { $0.hasPrefix("view month") }.count, 2)
    }

    /// The circle's optimistic change shows on the task's row wherever it is
    /// listed, so the page beside it does not show it open during a swipe.
    func testTheCircleChangesTheRowInEveryViewThatListsIt() async {
        let service = FakeService()
        let task = TaskRecord(id: "t", title: "Pay the invoice", scheduledFor: "2026-10-14")
        await service.setPage(TaskViewPage(view: .today, day: "2026-10-14", tasks: [task]))
        let model = model(service)
        await model.load()
        await model.prefetch([.month])
        await model.tapBullet(task)
        XCTAssertEqual(model.page(.month).tasks.first?.state, .done, "Month still shows the task open")
        XCTAssertTrue(model.page(.month).stale)
    }

    /// Reaching a page read before re-reads it without a spinner, so its
    /// rows (and the banner above them) stay put; one never read shows it.
    func testRevisitingKeepsAReadPageOnScreen() async {
        let service = FakeService()
        let model = model(service)
        await model.revisit()
        XCTAssertTrue(model.page(.today).loaded)
        model.show(.month)
        await model.revisit()
        model.show(.today)
        let again = Task { await model.revisit() }
        await Task.yield()
        XCTAssertFalse(model.page(.today).loading, "a page read before shows no spinner while it is re-read")
        await again.value
    }

    /// A read-ahead overtaken by a newer one stops instead of restarting the
    /// newer one's reads.
    func testACancelledReadAheadReadsNothing() async {
        let service = FakeService()
        let model = model(service)
        let readAhead = Task { await model.prefetch([.month, .future]) }
        readAhead.cancel()
        await readAhead.value
        let calls = await service.calls
        XCTAssertEqual(calls, [])
    }

    /// A read abandoned because the screen moved on is not shown as an error.
    func testACancelledReadIsNotAnError() async {
        let service = FakeService()
        await service.setFailNextRead(URLError(.cancelled))
        let model = model(service)
        await model.load()
        XCTAssertNil(model.loadError)
        XCTAssertFalse(model.page(.today).loaded, "the view is read again when next wanted")
        XCTAssertFalse(model.loading)
    }

    func testConflictMessage() {
        XCTAssertEqual(
            TasksModel.message(for: GatewayClient.Error.serverError(status: 409, body: "{}")),
            "That task changed elsewhere. Showing it as it is now."
        )
    }
}
