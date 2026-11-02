// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class TaskWidgetTests: XCTestCase {
    private var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.timeZone = TimeZone(secondsFromGMT: 0)!
        value.firstWeekday = 2
        return value
    }

    private func date(_ raw: String) -> Date {
        ISO8601DateFormatter().date(from: raw + "T12:00:00Z")!
    }

    private func schedule(_ period: TaskWidgetPeriod, _ day: String) -> TaskWidgetSchedule {
        .init(period: period, date: date(day), now: date("2026-10-14"), calendar: calendar)
    }

    private var credential: TaskWidgetCredential {
        .init(
            url: URL(string: "https://gateway.example.com")!,
            token: "test-token",
            deviceId: "widget-device",
            generation: "generation-one",
            tlsMode: "system"
        )
    }

    func testTomorrowExcludesCarryAndShowsDeadlineBeforeLaterPlan() {
        let tasks: [TaskWidgetTask] = [
            .init(id: "carry", title: "Old plan", scheduledFor: "2026-10-10"),
            .init(id: "tomorrow", title: "Tomorrow plan", scheduledFor: "2026-10-15"),
            .init(id: "deadline", title: "Earlier deadline", scheduledFor: "2026-11-04", dueDay: "2026-10-15"),
            .init(id: "done", title: "Finished", state: "done", scheduledFor: "2026-10-15"),
            .init(id: "suggestion", title: "Unaccepted", scheduledFor: "2026-10-15", origin: "brain"),
        ]
        XCTAssertEqual(Set(schedule(.day, "2026-10-15").tasks(from: tasks).map(\.id)), ["tomorrow", "deadline"])
        XCTAssertEqual(schedule(.day, "2026-10-14").tasks(from: tasks).map(\.id), ["carry"])
    }

    func testTodaySortsEveryOpenTaskByCreationBeforeTruncation() {
        let tasks: [TaskWidgetTask] = [
            .init(id: "old", title: "Inspect the storage shelves", scheduledFor: "2026-10-14", createdAt: "2026-10-10T08:00:00Z"),
            .init(id: "b-tie", title: "Prepare display labels", scheduledFor: "2026-10-14", createdAt: "2026-10-14T10:00:00Z"),
            .init(id: "new-carried", title: "Review the exhibit plan", scheduledFor: "2026-10-12", createdAt: "2026-10-14T11:00:00Z"),
            .init(
                id: "a-tie",
                title: "Check the lighting plan",
                scheduledFor: "2026-11-01",
                dueDay: "2026-10-14",
                createdAt: "2026-10-14T10:00:00Z"
            ),
            .init(id: "undated", title: "Review the packing list", scheduledFor: "2026-10-10"),
        ]
        let result = schedule(.day, "2026-10-14").tasks(from: tasks)
        XCTAssertEqual(result.map(\.id), ["new-carried", "a-tie", "b-tie", "old", "undated"])
        XCTAssertEqual(Array(result.prefix(2)).map(\.id), ["new-carried", "a-tie"])
    }

    func testSameDayTasksKeepCreationOrderWhenIdentifiersDisagree() {
        let tasks: [TaskWidgetTask] = [
            .init(
                id: "a-newer",
                title: "Newer plan",
                scheduledFor: "2026-10-15",
                createdAt: "2026-10-14T10:00:00.000Z"
            ),
            .init(
                id: "z-older",
                title: "Older plan",
                scheduledFor: "2026-10-15",
                createdAt: "2026-10-14T08:00:00.000Z"
            ),
            .init(
                id: "b-tied",
                title: "Same creation instant",
                scheduledFor: "2026-10-15",
                createdAt: "2026-10-14T10:00:00.000Z"
            ),
        ]
        XCTAssertEqual(
            schedule(.day, "2026-10-15").tasks(from: tasks).map(\.id),
            ["z-older", "a-newer", "b-tied"]
        )
    }

    func testMonthIncludesMonthPlansAndDaysWithoutUnscheduledTasks() {
        let tasks: [TaskWidgetTask] = [
            .init(id: "month", title: "Month plan", scheduledFor: "2026-11"),
            .init(id: "day", title: "Day plan", scheduledFor: "2026-11-03"),
            .init(id: "due", title: "Due without plan", dueDay: "2026-11-12"),
            .init(id: "anytime", title: "No date"),
            .init(id: "later", title: "Later plan", scheduledFor: "2026-12-01"),
        ]
        XCTAssertEqual(Set(schedule(.month, "2026-11-01").tasks(from: tasks).map(\.id)), ["month", "day", "due"])
        XCTAssertEqual(schedule(.day, "2026-11-03").tasks(from: tasks).map(\.id), ["day"])
    }

    func testMonthPlanWithDeadlineAppearsOnDeadlineDay() {
        let tasks: [TaskWidgetTask] = [
            .init(id: "month-due", title: "Month plan with deadline", scheduledFor: "2026-11", dueDay: "2026-11-12"),
            .init(id: "month-only", title: "Month plan without deadline", scheduledFor: "2026-11"),
        ]
        XCTAssertEqual(schedule(.day, "2026-11-12").tasks(from: tasks).map(\.id), ["month-due"])
        XCTAssertTrue(schedule(.day, "2026-11-11").tasks(from: tasks).isEmpty)
    }

    func testWeekUsesLocalCalendarAndCarriesOnlyInCurrentWeek() {
        let tasks: [TaskWidgetTask] = [
            .init(id: "carry", title: "Carried", scheduledFor: "2026-10-01"),
            .init(id: "sunday", title: "Sunday plan", scheduledFor: "2026-10-18"),
            .init(id: "monday", title: "Monday plan", scheduledFor: "2026-10-19"),
        ]
        XCTAssertEqual(Set(schedule(.week, "2026-10-14").tasks(from: tasks).map(\.id)), ["carry", "sunday"])
        XCTAssertEqual(schedule(.week, "2026-10-21").tasks(from: tasks).map(\.id), ["monday"])
    }

    func testCalendarDaySurvivesDSTAndYearBoundary() throws {
        var local = Calendar(identifier: .gregorian)
        local.timeZone = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        let instant = try XCTUnwrap(ISO8601DateFormatter().date(from: "2027-01-01T01:00:00Z"))
        XCTAssertEqual(TaskWidgetSchedule.dayString(instant, calendar: local), "2026-12-31")
        XCTAssertEqual(schedule(.month, "2026-12-31").month, "2026-12")
    }

    func testCredentialRotationPurgesCacheAndRejectsOldFetch() throws {
        let store = InMemoryStore()
        try TaskWidgetStorage.configure(credential, store: store)
        let snapshot = TaskWidgetSnapshot(tasks: [.init(id: "old", title: "Old account task")])
        try TaskWidgetStorage.save(snapshot: snapshot, credential: credential, store: store)
        XCTAssertEqual(try TaskWidgetStorage.snapshot(store: store), snapshot)
        let replacement = TaskWidgetCredential(
            url: credential.url,
            token: "next-token",
            deviceId: credential.deviceId,
            generation: "generation-two",
            tlsMode: "system"
        )
        try store.set("completion", forKey: "task-widget.action-error")
        try TaskWidgetStorage.configure(replacement, store: store)
        XCTAssertNil(try store.get("task-widget.action-error"))
        try TaskWidgetStorage.save(snapshot: snapshot, credential: credential, store: store)
        XCTAssertNil(try TaskWidgetStorage.snapshot(store: store))
        try TaskWidgetStorage.clear(store: store)
        XCTAssertNil(try TaskWidgetStorage.credential(store: store))
    }

    func testInsecureOrMalformedPinNeverBecomesWidgetAuthority() throws {
        let store = InMemoryStore()
        let invalid = TaskWidgetCredential(
            url: credential.url,
            token: credential.token,
            deviceId: credential.deviceId,
            tlsMode: "pinned-leaf",
            fingerprint: "bad-pin"
        )
        try TaskWidgetStorage.configure(invalid, store: store)
        XCTAssertNil(try TaskWidgetStorage.credential(store: store))
    }

    func testStaleRenderedAuthorityCannotCompleteAgainstNewPairing() async throws {
        let store = InMemoryStore()
        try TaskWidgetStorage.configure(credential, store: store)
        let renderedAuthority = credential.authorityID
        let replacement = try TaskWidgetCredential(
            url: XCTUnwrap(URL(string: "https://other.example.org")),
            token: "other-token",
            deviceId: "other-device",
            tlsMode: "system"
        )
        try TaskWidgetStorage.configure(replacement, store: store)
        let requests = Requests()
        do {
            try await TaskWidgetCompletion.perform(
                id: "old-task",
                expectedAuthorityID: renderedAuthority,
                store: store,
                request: { requests.send($0) }
            )
            XCTFail("Expected stale authority")
        } catch {
            XCTAssertEqual(error as? TaskWidgetCompletionError, .staleAuthority)
        }
        XCTAssertTrue(requests.values.isEmpty)
        XCTAssertNotEqual(renderedAuthority, replacement.authorityID)
    }

    func testCompletionFailureRetainsTaskAndSuccessRemovesIt() async throws {
        let store = InMemoryStore()
        try TaskWidgetStorage.configure(credential, store: store)
        let snapshot = TaskWidgetSnapshot(tasks: [.init(id: "task", title: "Plan the garden")])
        try TaskWidgetStorage.save(snapshot: snapshot, credential: credential, store: store)
        let requests = Requests()
        requests.status = 503
        do {
            try await TaskWidgetCompletion.perform(
                id: "task",
                expectedAuthorityID: credential.authorityID,
                store: store,
                request: { requests.send($0) }
            )
            XCTFail("Expected unavailable gateway")
        } catch {
            XCTAssertEqual(error as? TaskWidgetClientError, .unavailable)
        }
        XCTAssertEqual(try TaskWidgetStorage.snapshot(store: store), snapshot)
        requests.status = 200
        try await TaskWidgetCompletion.perform(
            id: "task",
            expectedAuthorityID: credential.authorityID,
            store: store,
            request: { requests.send($0) }
        )
        XCTAssertEqual(try TaskWidgetStorage.snapshot(store: store)?.tasks, [])
    }

    func testOlderInFlightFetchCannotResurrectCompletedTask() async throws {
        let store = InMemoryStore()
        try TaskWidgetStorage.configure(credential, store: store)
        let old = TaskWidgetSnapshot(
            tasks: [.init(id: "task", title: "Plan the garden")],
            updatedAt: Date().addingTimeInterval(-30)
        )
        try TaskWidgetStorage.save(snapshot: old, credential: credential, store: store)
        let requests = Requests()
        try await TaskWidgetCompletion.perform(
            id: "task",
            expectedAuthorityID: credential.authorityID,
            store: store,
            request: { requests.send($0) }
        )
        try TaskWidgetStorage.save(snapshot: old, credential: credential, store: store)
        XCTAssertEqual(try TaskWidgetStorage.snapshot(store: store)?.tasks, [])
    }

    private final class Requests: @unchecked Sendable {
        var values: [URLRequest] = []
        var status = 200
        func send(_ request: URLRequest) -> (Data, URLResponse) {
            values.append(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            let body = request.httpMethod == "GET"
                ? """
                {"tasks":[{"id":"one","title":"Plan the garden","state":"open","scheduledFor":null,
                "dueDay":null,"carried":false,"origin":"user","accepted":false,"ignored":false}]}
                """
                : "{}"
            return (Data(body.utf8), response)
        }
    }

    func testFetchReadsAllCompletePartitionsAndDeduplicatesTasks() async throws {
        let requests = Requests()
        let client = TaskWidgetClient(credential: credential, request: { requests.send($0) })
        let snapshot = try await client.fetch(now: date("2026-10-14"), calendar: calendar)
        XCTAssertEqual(snapshot.tasks.map(\.id), ["one"])
        XCTAssertEqual(requests.values.count, 4)
        XCTAssertEqual(Set(requests.values.compactMap {
            URLComponents(url: $0.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "view" }?.value
        }), ["today", "month", "future", "anytime"])
        XCTAssertTrue(requests.values.allSatisfy {
            $0.value(forHTTPHeaderField: "Authorization") == "Bearer test-token" && $0.timeoutInterval == 8
        })
    }

    func testCompletionEscapesIdentifierAndReportsAuthenticationFailure() async throws {
        let requests = Requests()
        let client = TaskWidgetClient(credential: credential, request: { requests.send($0) })
        try await client.complete(id: "task/with?#fragment")
        let request = try XCTUnwrap(requests.values.last)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertTrue(try XCTUnwrap(request.url?.absoluteString.contains("task%2Fwith%3F%23fragment/actions")))
        XCTAssertEqual(request.httpBody, Data(#"{"action":"complete"}"#.utf8))
        requests.status = 403
        do {
            try await client.complete(id: "task")
            XCTFail("Expected authentication failure")
        } catch {
            XCTAssertEqual(error as? TaskWidgetClientError, .unauthorized)
        }
    }
}
