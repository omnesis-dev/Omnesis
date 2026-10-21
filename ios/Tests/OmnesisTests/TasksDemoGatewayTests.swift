// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The UI tests drive the Tasks screen against `TasksDemoGateway`, so it
/// must behave like the gateway: views follow the store, commands change
/// it, a command that no longer applies is refused with 400, Undo restores.
final class TasksDemoGatewayTests: XCTestCase {
    private let day = "2026-10-14"
    private let now: Date = {
        var components = DateComponents()
        components.year = 2026
        components.month = 10
        components.day = 14
        components.hour = 9
        return Calendar.current.date(from: components)!
    }()

    private let planned = TaskRecord(id: "p", title: "Planned today", scheduledFor: "2026-10-14")
    private let suggestion = TaskRecord(id: "s", title: "A suggestion", origin: .brain)

    private func gateway() -> TasksDemoGateway {
        TasksDemoGateway(tasks: [planned, suggestion], now: now)
    }

    private func ids(_ gateway: TasksDemoGateway, _ view: TaskViewKind) async throws -> [String] {
        try await gateway.view(view, day: day, limit: nil, before: nil).tasks.map(\.id)
    }

    private func status(_ error: Error) -> Int? {
        if case GatewayClient.Error.serverError(let status, _) = error { return status }
        return nil
    }

    func testCompletingMovesTheTaskUnderDoneTodayAndRefusesARepeat() async throws {
        let gateway = gateway()
        let mutation = try await gateway.perform(.complete(note: "Went well"), on: "p")
        XCTAssertEqual(mutation.task?.state, .done)
        XCTAssertEqual(mutation.task?.completionNote, "Went well")
        XCTAssertEqual(mutation.receipt.text, "Done: Planned today")
        let today = try await gateway.view(.today, day: day, limit: nil, before: nil)
        XCTAssertEqual(today.tasks.map(\.id), ["p"])
        XCTAssertEqual(today.tasks.first?.isResolved, true)
        XCTAssertEqual(today.counts.today, 0)
        do {
            _ = try await gateway.perform(.complete(note: nil), on: "p")
            XCTFail("a repeat completion was accepted")
        } catch {
            XCTAssertEqual(status(error), 400)
        }
    }

    func testMovingPlacesTheTaskInItsView() async throws {
        let gateway = gateway()
        _ = try await gateway.perform(.migrate(to: "2026-10-15"), on: "p")
        let today = try await ids(gateway, .today)
        let month = try await ids(gateway, .month)
        XCTAssertEqual(today, [])
        XCTAssertEqual(month, ["p"])
        _ = try await gateway.perform(.migrate(to: "2027-01"), on: "p")
        let future = try await ids(gateway, .future)
        XCTAssertEqual(future, ["p"])
    }

    func testAcceptingLeavesSuggestedOnceOnly() async throws {
        let gateway = gateway()
        let suggestedBefore = try await ids(gateway, .suggested)
        XCTAssertEqual(suggestedBefore, ["s"])
        _ = try await gateway.perform(.accept(scheduledFor: .unchanged), on: "s")
        let suggested = try await ids(gateway, .suggested)
        let anytime = try await ids(gateway, .anytime)
        XCTAssertEqual(suggested, [])
        XCTAssertEqual(anytime, ["s"])
        do {
            _ = try await gateway.perform(.accept(scheduledFor: .unchanged), on: "s")
            XCTFail("a repeat accept was accepted")
        } catch {
            XCTAssertEqual(status(error), 400)
        }
    }

    func testStrikingAndUndoing() async throws {
        let gateway = gateway()
        let mutation = try await gateway.perform(.strike(reason: nil), on: "p")
        let done = try await ids(gateway, .done)
        XCTAssertEqual(done, ["p"])
        let seq = try XCTUnwrap(mutation.receipt.undoSeq)
        _ = try await gateway.undo(seq: seq)
        let today = try await gateway.view(.today, day: day, limit: nil, before: nil)
        XCTAssertEqual(today.tasks.map(\.id), ["p"])
        XCTAssertEqual(today.tasks.first?.isResolved, false)
        let doneAfter = try await ids(gateway, .done)
        XCTAssertEqual(doneAfter, [])
    }

    func testIgnoringHidesTheSuggestionEverywhereAndUndoBringsItBack() async throws {
        let gateway = gateway()
        let mutation = try await gateway.perform(.ignore(reason: nil), on: "s")
        XCTAssertEqual(mutation.task?.ignored, true)
        XCTAssertEqual(mutation.task?.state, .open, "an ignored suggestion stays an open loop")
        XCTAssertEqual(mutation.receipt.text, "Ignored: A suggestion")
        for view in TaskViewKind.allCases {
            let listed = try await ids(gateway, view)
            XCTAssertFalse(listed.contains("s"), "\(view) lists the ignored suggestion")
        }
        let counts = try await gateway.view(.today, day: day, limit: nil, before: nil).counts
        XCTAssertEqual(counts.suggested, 0)
        _ = try await gateway.undo(seq: XCTUnwrap(mutation.receipt.undoSeq))
        let suggested = try await ids(gateway, .suggested)
        XCTAssertEqual(suggested, ["s"])
    }

    func testMarkingASuggestionDoneMakesItTheirsAndDone() async throws {
        let gateway = gateway()
        let mutation = try await gateway.perform(.complete(note: nil), on: "s")
        XCTAssertEqual(mutation.task?.state, .done)
        XCTAssertEqual(mutation.task?.accepted, true)
        let suggested = try await ids(gateway, .suggested)
        let done = try await ids(gateway, .done)
        XCTAssertEqual(suggested, [])
        XCTAssertEqual(done, ["s"])
        _ = try await gateway.undo(seq: XCTUnwrap(mutation.receipt.undoSeq))
        let suggestedAfter = try await ids(gateway, .suggested)
        let doneAfter = try await ids(gateway, .done)
        XCTAssertEqual(suggestedAfter, ["s"])
        XCTAssertEqual(doneAfter, [])
    }

    func testAcceptingWithANoteKeepsTheNoteForTheTask() async throws {
        let gateway = gateway()
        let mutation = try await gateway.perform(
            .accept(scheduledFor: .set("2026-10-14"), note: "Ask about the deposit", noteId: "n-1"),
            on: "s"
        )
        XCTAssertEqual(mutation.task?.accepted, true)
        XCTAssertEqual(mutation.receipt.text, "Added to your tasks: A suggestion")
        let today = try await ids(gateway, .today)
        XCTAssertEqual(today, ["p", "s"])
        let notes = await gateway.notes
        XCTAssertEqual(notes.map(\.taskId), ["s"])
        XCTAssertEqual(notes.map(\.text), ["Ask about the deposit"])
    }

    /// Each Chat about this starts a new conversation titled after the task.
    /// The answer carries the `task` anchor only; resuming it brings the
    /// snapshot the card is drawn from. An unknown task is the gateway's 404.
    func testStartingAChatAboutATask() async throws {
        let gateway = gateway()
        let first = try await gateway.startConversation(about: "p")
        let second = try await gateway.startConversation(about: "p")
        XCTAssertNotEqual(first.sessionId, second.sessionId)
        XCTAssertEqual(first.title, "Planned today")
        XCTAssertEqual(first.messageCount, 0)
        XCTAssertEqual(first.origin?.taskId, "p")
        XCTAssertEqual(first.origin?.runId, "p")
        XCTAssertNil(first.origin?.taskCard)
        let resumed = await gateway.conversation(id: first.sessionId)
        XCTAssertEqual(resumed?.origin?.taskCard, TaskConversationOriginSnapshot(title: "Planned today", state: "open"))
        do {
            _ = try await gateway.startConversation(about: "gone")
            XCTFail("a chat about an unknown task was started")
        } catch {
            XCTAssertEqual(error as? GatewayClient.Error, .notFound)
        }
    }
}
