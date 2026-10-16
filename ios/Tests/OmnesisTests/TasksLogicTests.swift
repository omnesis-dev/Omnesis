// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The Tasks screen's pure logic: the device-local calendar arithmetic and
/// wording, the journal's sections, the edit sheet's "send only what
/// changed" rule, and the screen model's command flow against a fake gateway.
final class TasksLogicTests: XCTestCase {
    private let schedule: TaskSchedule = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London")!
        return TaskSchedule(calendar: calendar, locale: Locale(identifier: "en_GB"))
    }()

    private func date(_ day: String, hour: Int = 9) -> Date {
        let midnight = schedule.date(fromDay: day)!
        return schedule.calendar.date(byAdding: .hour, value: hour, to: midnight)!
    }

    // MARK: - Calendar

    func testDayIsLocalNotUTC() {
        // 23:30 in London during BST is 22:30 UTC the same day, and 00:30 the
        // next morning is still "tomorrow" locally while UTC says today.
        XCTAssertEqual(schedule.day(date("2026-10-14", hour: 23)), "2026-10-14")
        XCTAssertEqual(schedule.day(date("2026-10-15", hour: 0)), "2026-10-15")
    }

    func testQuickMoves() {
        let wednesday = date("2026-10-14")
        XCTAssertEqual(schedule.tomorrow(from: wednesday), "2026-10-15")
        XCTAssertEqual(schedule.nextWeek(from: wednesday), "2026-10-19")
        XCTAssertEqual(schedule.nextMonth(from: wednesday), "2026-11")
        // On a Monday, next week is a week away, never today.
        XCTAssertEqual(schedule.nextWeek(from: date("2026-10-19")), "2026-10-26")
        // On a Sunday, next week is tomorrow.
        XCTAssertEqual(schedule.nextWeek(from: date("2026-10-18")), "2026-10-19")
        // Month and year roll over.
        XCTAssertEqual(schedule.tomorrow(from: date("2026-12-31")), "2027-01-01")
        XCTAssertEqual(schedule.nextMonth(from: date("2026-12-31")), "2027-01")
        XCTAssertEqual(schedule.nextMonth(from: date("2027-01-31")), "2027-02")
    }

    func testParsingRejectsOtherShapes() {
        XCTAssertNil(schedule.date(fromDay: "2026-10"))
        XCTAssertNil(schedule.date(fromDay: "someday"))
        XCTAssertNil(schedule.date(fromMonth: "2026-10-14"))
        XCTAssertNotNil(schedule.date(fromMonth: "2026-10"))
    }

    func testScheduleLabels() {
        let today = "2026-10-14"
        XCTAssertEqual(schedule.scheduleLabel("2026-10-14", today: today), "Today")
        XCTAssertEqual(schedule.scheduleLabel("2026-10-15", today: today), "Tomorrow")
        XCTAssertEqual(schedule.scheduleLabel("2026-10-13", today: today), "Yesterday")
        XCTAssertEqual(schedule.scheduleLabel("2026-10-22", today: today), "Thu 22 Oct")
        XCTAssertEqual(schedule.scheduleLabel("2026-11", today: today), "November")
        XCTAssertEqual(schedule.scheduleLabel("2027-02", today: today), "February 2027")
        XCTAssertEqual(schedule.scheduleLabel("someday", today: today), "Someday")
        XCTAssertNil(schedule.scheduleLabel(nil, today: today))
    }

    func testDeadlineLabels() {
        let today = "2026-10-14"
        XCTAssertEqual(
            schedule.deadlineLabel(TaskDeadline(type: .by, date: "2026-10-16"), dueDay: "2026-10-16", today: today),
            "Due Fri 16 Oct"
        )
        XCTAssertEqual(
            schedule.deadlineLabel(TaskDeadline(type: .approximate, date: "2026-10-15"), dueDay: nil, today: today),
            "Around tomorrow"
        )
        XCTAssertEqual(
            schedule.deadlineLabel(TaskDeadline(type: .onDay, date: "2026-10-14"), dueDay: "2026-10-14", today: today),
            "Today"
        )
        XCTAssertNil(schedule.deadlineLabel(TaskDeadline(type: .anyTime), dueDay: nil, today: today))
        XCTAssertTrue(schedule.isOverdue(dueDay: "2026-10-13", today: today))
        XCTAssertFalse(schedule.isOverdue(dueDay: "2026-10-14", today: today))
        XCTAssertFalse(schedule.isOverdue(dueDay: nil, today: today))
    }

    // MARK: - Journal

    func testTodaySectionsOrderCarriedThenPlannedThenResolved() {
        let carried = TaskRecord(id: "c", title: "Carried", carried: true)
        let planned = TaskRecord(id: "p", title: "Planned")
        let done = TaskRecord(id: "d", title: "Done", state: .done)
        let struck = TaskRecord(id: "s", title: "Struck", state: .dismissed)
        let sections = TaskJournal.sections(for: .today, tasks: [planned, done, carried, struck])
        XCTAssertEqual(sections.map(\.title), ["Carried over", "Today", "Done today"])
        XCTAssertEqual(sections.map { $0.tasks.map(\.id) }, [["c"], ["p"], ["d", "s"]])

        // A page with only today's tasks needs no heading at all.
        let plain = TaskJournal.sections(for: .today, tasks: [planned])
        XCTAssertEqual(plain.count, 1)
        XCTAssertNil(plain[0].title)

        XCTAssertEqual(TaskJournal.sections(for: .month, tasks: [planned, carried]).first?.tasks.count, 2)
        XCTAssertTrue(TaskJournal.sections(for: .done, tasks: []).isEmpty)
    }

    func testSegmentsAndProposalWording() {
        XCTAssertEqual(
            TaskJournal.segments(experimental: true),
            [.today, .month, .future, .anytime, .waiting, .suggested, .done]
        )
        XCTAssertEqual(
            TaskJournal.segments(experimental: false),
            [.today, .month, .future, .anytime, .waiting, .done]
        )
        XCTAssertEqual(
            TaskJournal.proposalHeadline(TaskProposedChange(kind: .complete, reason: "Paid")),
            "Omnesis thinks this is done"
        )
        XCTAssertEqual(
            TaskJournal.proposalHeadline(TaskProposedChange(kind: .strike, reason: "Cancelled")),
            "Omnesis thinks this no longer applies"
        )
        XCTAssertEqual(
            TaskJournal.proposalFields(
                .init(title: "Book the venue", scheduledFor: "2026-10-15"),
                schedule: schedule,
                today: "2026-10-14"
            ),
            "Title: Book the venue · Plan: Tomorrow"
        )
        XCTAssertNil(TaskJournal.proposalFields(.init(), schedule: schedule, today: "2026-10-14"))
    }

    /// The pages a swipe reaches from a view: the segments either side of
    /// it, none past either end.
    func testNeighboursAreTheSegmentsEitherSide() {
        let segments = TaskJournal.segments(experimental: true)
        XCTAssertEqual(TaskJournal.neighbours(of: .today, in: segments), [.month])
        XCTAssertEqual(TaskJournal.neighbours(of: .future, in: segments), [.month, .anytime])
        XCTAssertEqual(TaskJournal.neighbours(of: .done, in: segments), [.suggested])
        XCTAssertEqual(TaskJournal.neighbours(of: .done, in: TaskJournal.segments(experimental: false)), [.waiting])
        XCTAssertEqual(TaskJournal.neighbours(of: .suggested, in: TaskJournal.segments(experimental: false)), [])
    }

    func testSegmentLabelsCarryOpenCountsOnlyAboveZero() {
        let counts = TaskCounts(today: 4, month: 10, future: 0, anytime: 2, waiting: 1, suggested: 3)
        XCTAssertEqual(TaskJournal.segmentLabel(for: .today, counts: counts), "Today (4)")
        XCTAssertEqual(TaskJournal.segmentLabel(for: .month, counts: counts), "Month (10)")
        XCTAssertEqual(TaskJournal.segmentLabel(for: .future, counts: counts), "Future")
        XCTAssertEqual(TaskJournal.segmentLabel(for: .anytime, counts: counts), "Anytime (2)")
        XCTAssertEqual(TaskJournal.segmentLabel(for: .waiting, counts: counts), "Waiting (1)")
        // Suggested shows its count as a badge beside the label; Done has none.
        XCTAssertEqual(TaskJournal.segmentLabel(for: .suggested, counts: counts), "Suggested")
        XCTAssertEqual(TaskJournal.segmentLabel(for: .done, counts: counts), "Done")
        XCTAssertEqual(TaskJournal.count(of: .suggested, in: counts), 3)
        XCTAssertEqual(TaskJournal.count(of: .done, in: counts), 0)
        XCTAssertEqual(TaskJournal.segmentLabel(for: .today, counts: TaskCounts()), "Today")
    }

    /// The list is one run of lines: completing a planned task moves the
    /// same line (same id) under "Done today" rather than adding a new one.
    func testEntriesKeepATaskOnOneLineAcrossSections() {
        let planned = TaskRecord(id: "t1", title: "Planned", scheduledFor: "2026-10-14")
        let carried = TaskRecord(id: "t0", title: "Carried", scheduledFor: "2026-10-12", carried: true)
        let before = TaskJournal.entries(for: .today, tasks: [carried, planned])
        XCTAssertEqual(before.map(\.id), ["heading:carried", "t0", "heading:today", "t1"])
        let after = TaskJournal.entries(for: .today, tasks: [carried, planned.with(state: .done)])
        XCTAssertEqual(after.map(\.id), ["heading:carried", "t0", "heading:resolved", "t1"])
        XCTAssertEqual(Set(after.map(\.id)).count, after.count, "every line has its own id")
        guard case .task(let moved) = after.last else { return XCTFail("the task is not last") }
        XCTAssertTrue(moved.isResolved)
        // Other views are one untitled run.
        XCTAssertEqual(TaskJournal.entries(for: .month, tasks: [planned]).map(\.id), ["t1"])
    }

    func testAChangeOmnesisAppliedNamesItselfAndOffersUndoWhileNewest() {
        func event(_ seq: Int, _ kind: String, change: String? = nil) -> TaskEvent {
            TaskEvent(seq: seq, at: nil, note: "The receipt says it was paid.", kind: kind, surface: "brain", change: change)
        }
        let done = event(9, "auto_applied", change: "complete")
        let edit = event(9, "auto_applied", change: "edit")
        XCTAssertEqual(TaskJournal.eventTitle(done), "Marked done by Omnesis")
        XCTAssertEqual(TaskJournal.eventTitle(edit), "Updated by Omnesis")
        // The title already says who made the change.
        XCTAssertNil(TaskJournal.eventSource(done))
        XCTAssertEqual(TaskJournal.eventSource(event(8, "struck")), "By Omnesis")

        let task = TaskRecord(id: "t", title: "Pay the invoice")
        XCTAssertEqual(TaskJournal.autoAppliedUndoSeq(TaskDetail(task: task, history: [done], undoSeq: 9)), 9)
        // Not undoable any more, or a later change came first, or not by Omnesis.
        XCTAssertNil(TaskJournal.autoAppliedUndoSeq(TaskDetail(task: task, history: [done], undoSeq: nil)))
        XCTAssertNil(TaskJournal.autoAppliedUndoSeq(TaskDetail(
            task: task,
            history: [event(10, "undone"), done],
            undoSeq: nil
        )))
        XCTAssertNil(TaskJournal.autoAppliedUndoSeq(TaskDetail(task: task, history: [event(9, "completed")], undoSeq: 9)))
    }

    func testMenuLabelAndReviewBanner() {
        XCTAssertEqual(TaskJournal.menuLabel(todayCount: 4), "Tasks (4)")
        XCTAssertEqual(TaskJournal.menuLabel(todayCount: 0), "Tasks")
        XCTAssertNil(TaskJournal.reviewBannerText(suggested: 0))
        XCTAssertEqual(TaskJournal.reviewBannerText(suggested: 1), "Omnesis has created 1 task for your review")
        XCTAssertEqual(TaskJournal.reviewBannerText(suggested: 5), "Omnesis has created 5 tasks for your review")
    }

    func testCaptureHintOnTheViewsAPersonFills() {
        XCTAssertEqual(
            TaskViewKind.allCases.filter(TaskJournal.showsCaptureHint(for:)),
            [.today, .month, .future, .anytime, .waiting]
        )
    }

    func testDocumentsShowAFewThenTheRestOnRequest() {
        let documents = (0 ..< 6).map {
            TaskDocument(id: "doc_\($0)", title: "Document \($0)", sourceId: "mail:inbox")
        }
        let short = TaskRecord(id: "loop_short", title: "Short", documents: Array(documents.prefix(4)))
        XCTAssertEqual(TaskJournal.documents(short, showAll: false).shown.count, 4)
        XCTAssertEqual(TaskJournal.documents(short, showAll: false).hidden, 0)

        let long = TaskRecord(id: "loop_long", title: "Long", documents: documents)
        let collapsed = TaskJournal.documents(long, showAll: false)
        XCTAssertEqual(collapsed.shown, Array(documents.prefix(3)))
        XCTAssertEqual(collapsed.hidden, 3)
        XCTAssertEqual(TaskJournal.documents(long, showAll: true).shown, documents)
        XCTAssertTrue(TaskJournal.documents(TaskRecord(id: "loop_none", title: "None"), showAll: false).shown.isEmpty)
    }

    // MARK: - Edit draft

    func testEditDraftSendsOnlyWhatChanged() {
        let task = TaskRecord(
            id: "t",
            title: "Pay the invoice",
            scheduledFor: "2026-10-14",
            deadline: TaskDeadline(type: .by, date: "2026-10-16"),
            dueDay: "2026-10-16"
        )
        var draft = TaskEditDraft(task: task, schedule: schedule, today: "2026-10-14")
        XCTAssertEqual(draft.plan, .day)
        XCTAssertTrue(draft.hasDeadline)
        XCTAssertNil(draft.action(comparedTo: task, schedule: schedule), "an untouched draft sends nothing")

        draft.title = "Pay the Studio Northstar invoice"
        XCTAssertEqual(
            draft.action(comparedTo: task, schedule: schedule),
            .edit(title: "Pay the Studio Northstar invoice", description: nil, scheduledFor: .unchanged, deadline: .unchanged)
        )

        draft = TaskEditDraft(task: task, schedule: schedule, today: "2026-10-14")
        draft.plan = .someday
        draft.hasDeadline = false
        XCTAssertEqual(
            draft.action(comparedTo: task, schedule: schedule),
            .edit(title: nil, description: nil, scheduledFor: .set("someday"), deadline: .set(nil))
        )

        draft = TaskEditDraft(task: task, schedule: schedule, today: "2026-10-14")
        draft.plan = .month
        draft.deadlineKind = .approximate
        XCTAssertEqual(
            draft.action(comparedTo: task, schedule: schedule),
            .edit(
                title: nil,
                description: nil,
                scheduledFor: .set("2026-10"),
                deadline: .set(TaskDeadline(type: .approximate, date: "2026-10-16"))
            )
        )
    }

    func testEditDraftReadsMonthAndUnplanned() {
        let month = TaskEditDraft(
            task: TaskRecord(id: "m", title: "M", scheduledFor: "2026-11"),
            schedule: schedule,
            today: "2026-10-14"
        )
        XCTAssertEqual(month.plan, .month)
        XCTAssertEqual(month.scheduledFor(schedule), "2026-11")
        let none = TaskEditDraft(task: TaskRecord(id: "n", title: "N"), schedule: schedule, today: "2026-10-14")
        XCTAssertEqual(none.plan, .none)
        XCTAssertFalse(none.hasDeadline)
        XCTAssertNil(none.scheduledFor(schedule))
    }
}

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

// MARK: - Menu count

// `AdminCoordinator` is UIKit-gated, so this runs in the simulator suite only.
#if canImport(UIKit)
@available(iOS 17.0, macOS 14.0, *)
@MainActor
final class TasksTodayCountTests: XCTestCase {
    /// The Tasks screen's reads move the menu's count at once; a gateway that
    /// does not serve Tasks reads as zero.
    func testCountFollowsTheTasksScreenAndZeroesWithoutTasks() async {
        let coord = AdminCoordinator()
        await coord.refreshTasksTodayCount(from: TaskCounts(today: 4, month: 10, suggested: 2))
        XCTAssertEqual(coord.tasksTodayCount, 4)
        await coord.refreshTasksTodayCount()
        XCTAssertEqual(coord.tasksTodayCount, 0, "no /status yet means no Tasks to count")
    }
}
#endif

// MARK: - Stale suggestions

/// A gateway that keeps its own record of each task, so a view read always
/// reflects what was accepted: Suggested lists the Brain's suggestions not
/// yet taken on, Month the tasks owned this month. `staleReadsLeft` answers
/// that many view reads with the screen's earlier copy, the way a cached
/// response would.
@available(iOS 17.0, macOS 14.0, *)
private actor TasksGatewayFake: TasksService {
    var tasks: [TaskRecord]
    var calls: [String] = []
    private var staleReadsLeft = 0
    private var stale: [TaskViewKind: [TaskRecord]] = [:]
    /// Holds `perform` until the test releases it.
    private var held: CheckedContinuation<Void, Never>?
    private var holdNextPerform = false
    private var failNextView = false

    init(tasks: [TaskRecord]) {
        self.tasks = tasks
    }

    func serveStale(_ view: TaskViewKind, _ copy: [TaskRecord], times: Int) {
        stale[view] = copy
        staleReadsLeft = times
    }

    func holdNext() {
        holdNextPerform = true
    }

    func failNextRead() {
        failNextView = true
    }

    func release() {
        held?.resume()
        held = nil
    }

    var isHolding: Bool {
        held != nil
    }

    func view(_ view: TaskViewKind, day: String, limit: Int?, before: String?) async throws -> TaskViewPage {
        calls.append("view \(view.rawValue)")
        if failNextView {
            failNextView = false
            throw URLError(.timedOut)
        }
        if staleReadsLeft > 0, let copy = stale[view] {
            staleReadsLeft -= 1
            return TaskViewPage(view: view, day: day, tasks: copy)
        }
        let listed: [TaskRecord] = switch view {
        case .suggested: tasks.filter(\.isSuggestion)
        case .month: tasks.filter { !$0.isSuggestion && $0.scheduledFor?.hasPrefix("2026-10") == true }
        default: []
        }
        return TaskViewPage(view: view, day: day, tasks: listed)
    }

    func detail(id: String) async throws -> TaskDetail {
        TaskDetail(task: TaskRecord(id: id, title: id), history: [])
    }

    func perform(_ action: TaskAction, on id: String) async throws -> TaskMutation {
        calls.append("\(action.name) \(id)")
        if holdNextPerform {
            holdNextPerform = false
            await withCheckedContinuation { held = $0 }
        }
        guard let index = tasks.firstIndex(where: { $0.id == id }) else { throw GatewayClient.Error.notFound }
        let task = tasks[index]
        guard case .accept = action else {
            return TaskMutation(task: task, receipt: TaskReceipt(text: "Done", undoSeq: nil))
        }
        guard task.isSuggestion else {
            throw GatewayClient.Error.serverError(status: 400, body: #"{"error":"already accepted"}"#)
        }
        let accepted = TaskRecord(
            id: task.id,
            title: task.title,
            origin: .brain,
            accepted: true,
            scheduledFor: task.scheduledFor
        )
        tasks[index] = accepted
        return TaskMutation(task: accepted, receipt: TaskReceipt(text: "Added: \(task.title)", undoSeq: 9))
    }

    func undo(seq: Int) async throws -> TaskMutation {
        TaskMutation(task: nil, receipt: TaskReceipt(text: "Undone", undoSeq: nil))
    }
}

@available(iOS 17.0, macOS 14.0, *)
@MainActor
final class TasksStaleSuggestionTests: XCTestCase {
    private let suggestion = TaskRecord(
        id: "loop_s",
        title: "Book the venue tour",
        origin: .brain,
        scheduledFor: "2026-10-20"
    )

    private func model(_ gateway: TasksGatewayFake) -> TasksModel {
        let now = Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 14, hour: 9))!
        return TasksModel(service: gateway, now: { now })
    }

    private func waitUntil(_ condition: @escaping () async -> Bool) async {
        for _ in 0 ..< 200 where await !condition() {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    /// The reported bug: a row still offers Accept after the suggestion was
    /// accepted, and the gateway refuses the repeat. The refusal must bring
    /// the screen back to what the gateway holds instead of leaving the
    /// stale buttons up.
    func testARefusedAcceptReloadsTheStaleRow() async throws {
        let gateway = TasksGatewayFake(tasks: [suggestion])
        let model = model(gateway)
        await model.select(.month)
        // The gateway took the suggestion on elsewhere; this screen's copy
        // still shows it waiting.
        _ = try await gateway.perform(.accept(scheduledFor: .unchanged), on: suggestion.id)
        await gateway.serveStale(.month, [suggestion], times: 1)
        await model.load()
        XCTAssertEqual(model.tasks.first?.isSuggestion, true, "the stale copy is on screen")

        let accepted = await model.perform(.accept(scheduledFor: .unchanged), on: suggestion)
        XCTAssertFalse(accepted)
        XCTAssertEqual(model.toast?.isError, true)
        XCTAssertEqual(model.tasks.map(\.id), [suggestion.id])
        XCTAssertEqual(model.tasks.first?.isSuggestion, false, "the refusal re-read the view")
    }

    /// Accepting shows the gateway's answer on the row at once, so no Accept
    /// is left to tap twice — even when the re-read after it fails.
    func testAnAcceptedRowLosesItsButtonsWithoutTheReread() async {
        let gateway = TasksGatewayFake(tasks: [suggestion])
        let model = model(gateway)
        await model.select(.suggested)
        XCTAssertEqual(model.tasks.first?.isSuggestion, true)
        await gateway.failNextRead()
        await model.perform(.accept(scheduledFor: .unchanged), on: suggestion)
        XCTAssertEqual(model.tasks.first?.isSuggestion, false, "the mutation's task replaces the row")
    }

    /// Ruled out: switching to Month while the accept is still in flight.
    /// Whichever read lands last, Month shows the task as the gateway now
    /// holds it.
    func testSwitchingViewsMidAcceptNeverShowsAStaleRow() async {
        let gateway = TasksGatewayFake(tasks: [suggestion])
        let model = model(gateway)
        await model.select(.suggested)
        await gateway.holdNext()
        let accept = Task { await model.perform(.accept(scheduledFor: .unchanged), on: suggestion) }
        await waitUntil { await gateway.isHolding }
        await model.select(.month)
        XCTAssertTrue(model.tasks.isEmpty, "not accepted yet, so not in Month")
        await gateway.release()
        _ = await accept.value
        XCTAssertEqual(model.selected, .month)
        XCTAssertEqual(model.tasks.map(\.id), [suggestion.id])
        XCTAssertEqual(model.tasks.first?.isSuggestion, false)
        let calls = await gateway.calls
        XCTAssertEqual(calls.filter { $0.hasPrefix("accept") }.count, 1)
    }
}
