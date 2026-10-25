// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
import Foundation
@testable import Omnesis
import XCTest

/// "Chat about this" on a task: the gateway capability that offers it, the
/// `task` origin a started chat carries, the fan target, and the facts on
/// the chat's card.
@available(iOS 17.0, macOS 14.0, *)
final class TaskConversationTests: XCTestCase {
    // MARK: - Capability

    private func status(_ capabilities: String?) throws -> StatusSnapshot {
        let field = capabilities.map { #","capabilities":\#($0)"# } ?? ""
        return try JSONDecoder().decode(
            StatusSnapshot.self,
            from: Data(#"{"documents":{"total":0,"bySource":{}}\#(field)}"#.utf8)
        )
    }

    func testAdvertisedCapabilityOffersTheChat() throws {
        let snapshot = try status(#"{"taskConversations":{"min":1,"max":1},"sourceContract":{"min":1,"max":3}}"#)
        XCTAssertEqual(snapshot.capabilities.taskConversations, GatewayCapabilityRange(min: 1, max: 1))
        XCTAssertTrue(snapshot.capabilities.supportsTaskConversations)
    }

    func testGatewayWithoutTheMapOffersNoChat() throws {
        XCTAssertFalse(try status(nil).capabilities.supportsTaskConversations)
        XCTAssertFalse(try status("{}").capabilities.supportsTaskConversations)
    }

    /// A gateway that only speaks a later version of the endpoint is not one
    /// this app can call.
    func testVersionOutOfRangeOffersNoChat() throws {
        let snapshot = try status(#"{"taskConversations":{"min":2,"max":3}}"#)
        XCTAssertNotNil(snapshot.capabilities.taskConversations)
        XCTAssertFalse(snapshot.capabilities.supportsTaskConversations)
    }

    /// A malformed entry or map withholds the feature without failing the
    /// snapshot the rest of the app reads.
    func testMalformedCapabilityLeavesTheSnapshotReadable() throws {
        let entry = try status(#"{"taskConversations":true}"#)
        XCTAssertFalse(entry.capabilities.supportsTaskConversations)
        let map = try status(#"[1,2]"#)
        XCTAssertFalse(map.capabilities.supportsTaskConversations)
        XCTAssertEqual(map.documents.total, 0)
    }

    // MARK: - Origin

    private static let summaryJSON = """
    {"id":"conv_42","title":"Renew the studio lease","model":"claude-sonnet-4-6",
     "backend":"anthropic","createdAt":"2026-10-14T09:00:00.000Z","updatedAt":"2026-10-14T09:00:00.000Z",
     "messageCount":0,"pinned":false,"unread":false,
     "origin":{"kind":"task","taskId":"loop_lease","runId":"loop_lease",
               "task":{"title":"Renew the studio lease","state":"open","due":"2026-10-23","sourceCount":3},
               "seedMessageCount":0}}
    """

    func testTaskOriginDecodes() throws {
        let summary = try JSONDecoder().decode(ConversationSummary.self, from: Data(Self.summaryJSON.utf8))
        let origin = try XCTUnwrap(summary.origin)
        XCTAssertTrue(origin.isTask)
        XCTAssertFalse(origin.isDailyBrief)
        XCTAssertEqual(origin.taskId, "loop_lease")
        XCTAssertEqual(origin.runId, "loop_lease")
        XCTAssertEqual(origin.seedMessageCount, 0)
        XCTAssertEqual(
            origin.taskCard,
            TaskConversationOriginSnapshot(
                title: "Renew the studio lease",
                state: "open",
                due: "2026-10-23",
                sourceCount: 3
            )
        )
        XCTAssertTrue(summary.isDeletable)
    }

    /// A list row carries only the anchor: it reads as a task chat, with no
    /// card until the conversation itself is opened.
    func testListRowWithOnlyTheAnchor() throws {
        let summary = try JSONDecoder().decode(
            ConversationSummary.self,
            from: Data("""
            {"id":"conv_42","title":"Renew the studio lease","model":"m","backend":"b",
             "createdAt":"2026-10-14T09:00:00.000Z","updatedAt":"2026-10-14T09:00:00.000Z","messageCount":2,
             "origin":{"kind":"task","taskId":"loop_lease","runId":"loop_lease"}}
            """.utf8)
        )
        let origin = try XCTUnwrap(summary.origin)
        XCTAssertTrue(origin.isTask)
        XCTAssertEqual(origin.taskId, "loop_lease")
        XCTAssertNil(origin.taskCard)
        XCTAssertFalse(AgentCoordinator.hasContextCard(origin))
    }

    /// The snapshot's optional fields may be absent: no due day, no count.
    func testTaskOriginWithoutDueDayOrCount() throws {
        let origin = try JSONDecoder().decode(
            ConversationOrigin.self,
            from: Data(#"{"kind":"task","taskId":"t","runId":"t","task":{"title":"Pay the invoice","state":"done"}}"#.utf8)
        )
        let card = try XCTUnwrap(origin.taskCard)
        XCTAssertNil(card.due)
        XCTAssertEqual(card.sourceCount, 0)
        XCTAssertEqual(card.state, "done")
    }

    /// A snapshot this build cannot read drops only the card: the origin, and
    /// so the conversation, still decodes.
    func testMalformedTaskSnapshotKeepsTheOrigin() throws {
        let origin = try JSONDecoder().decode(
            ConversationOrigin.self,
            from: Data(#"{"kind":"task","taskId":"t","runId":"t","task":{"state":"open"}}"#.utf8)
        )
        XCTAssertTrue(origin.isTask)
        XCTAssertEqual(origin.taskId, "t")
        XCTAssertNil(origin.taskCard)
        XCTAssertFalse(AgentCoordinator.hasContextCard(origin))
    }

    /// A task chat has its card without any seed to hide: its messages are
    /// all the user's own, and none is dropped.
    func testTaskChatHasACardAndHidesNothing() {
        let origin = ConversationOrigin(
            kind: "task",
            taskId: "t",
            runId: "t",
            task: TaskConversationOriginSnapshot(title: "Pay the invoice", state: "open"),
            seedMessageCount: 0
        )
        XCTAssertTrue(AgentCoordinator.hasContextCard(origin))
        let messages: [ChatMessage] = [
            .user(parts: [.text("What's left?")]),
            .assistant(parts: [.text("Only the signature.")]),
        ]
        XCTAssertEqual(AgentCoordinator.visibleMessages(messages, origin: origin).count, 2)
    }

    /// A task snapshot on an origin of another kind draws no task card.
    func testTaskSnapshotOnAnotherKindDrawsNoCard() {
        let origin = ConversationOrigin(
            kind: "something_new",
            runId: "r",
            task: TaskConversationOriginSnapshot(title: "Pay the invoice", state: "open")
        )
        XCTAssertNil(origin.taskCard)
        XCTAssertFalse(AgentCoordinator.hasContextCard(origin))
    }

    // MARK: - Fan

    private func session(kind: TaskFanSession.Kind, offersChat: Bool) -> TaskFanSession {
        TaskFanSession(
            anchor: CGPoint(x: 300, y: 700),
            bounds: CGRect(x: 0, y: 0, width: 393, height: 800),
            today: "2026-10-14",
            kind: kind,
            offersChat: offersChat
        )
    }

    func testTaskFanEndsWithChatWhenOffered() {
        let fan = session(kind: .task, offersChat: true)
        XCTAssertEqual(fan.targets.map(\.action), [.done, .doneWithNote, .tomorrow, .nextMonth, .otherMonth, .cancelTask, .chat])
        XCTAssertEqual(fan.targets.last?.label, "Chat about this")
    }

    func testTaskFanHasNoChatWhenNotOffered() {
        XCTAssertFalse(session(kind: .task, offersChat: false).targets.contains { $0.action == .chat })
    }

    func testSuggestionFanNeverOffersChat() {
        XCTAssertFalse(session(kind: .suggestion, offersChat: true).targets.contains { $0.action == .chat })
    }

    /// Lifting on Chat about this performs it; it is an action, not a page
    /// of the fan.
    func testReleasingOnChatPerformsIt() throws {
        var fan = session(kind: .task, offersChat: true)
        let chat = try XCTUnwrap(fan.targets.first { $0.action == .chat })
        XCTAssertFalse(TaskFanAction.chat.isNavigation)
        XCTAssertEqual(fan.release(at: chat.center, at: Date()), .perform(.chat))
    }

    /// Back from the month fan, a task's main fan still ends with Chat.
    func testChatSurvivesNavigatingBack() {
        var fan = session(kind: .task, offersChat: true)
        _ = fan.tap(.otherMonth)
        XCTAssertFalse(fan.targets.contains { $0.action == .chat })
        _ = fan.tap(.back)
        XCTAssertEqual(fan.targets.last?.action, .chat)
    }

    // MARK: - Card facts

    private let schedule: TaskSchedule = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return TaskSchedule(calendar: calendar, locale: Locale(identifier: "en_GB"))
    }()

    func testFactsForAnOpenTaskDueSoonWithSources() {
        let facts = TaskConversationOriginSnapshot(title: "t", state: "open", due: "2026-10-15", sourceCount: 3)
            .cardFacts(today: "2026-10-14", schedule: schedule)
        XCTAssertEqual(facts.map(\.text), ["Open", "Due tomorrow", "3 sources"])
        XCTAssertEqual(facts.map(\.tone), [.neutral, .neutral, .neutral])
    }

    func testAnOpenTaskPastItsDueDayIsFlagged() {
        let facts = TaskConversationOriginSnapshot(title: "t", state: "open", due: "2026-10-09", sourceCount: 1)
            .cardFacts(today: "2026-10-14", schedule: schedule)
        XCTAssertEqual(facts.map(\.text), ["Open", "Due Fri 9 Oct", "1 source"])
        XCTAssertEqual(facts[1].tone, .danger)
    }

    /// A resolved task's past due day is history, not a warning.
    func testADoneTaskPastItsDueDayIsNotFlagged() {
        let facts = TaskConversationOriginSnapshot(title: "t", state: "done", due: "2026-10-09")
            .cardFacts(today: "2026-10-14", schedule: schedule)
        XCTAssertEqual(facts.map(\.text), ["Done", "Due Fri 9 Oct"])
        XCTAssertEqual(facts[1].tone, .neutral)
    }

    func testStateLabels() {
        let labels = ["open", "snoozed", "done", "dismissed", "archived"].map {
            TaskConversationOriginSnapshot(title: "t", state: $0).stateLabel
        }
        XCTAssertEqual(labels, ["Open", "Snoozed", "Done", "Struck", "Archived"])
    }
}

/// Starting a chat from the Tasks screen: the new conversation's id on
/// success, a toast and nothing opened on failure.
@available(iOS 17.0, macOS 14.0, *)
@MainActor
final class TaskConversationModelTests: XCTestCase {
    /// Answers `startConversation` from a script and records every call.
    private actor ChatService: TasksService {
        var calls: [String] = []
        var failure: Error?

        func fail(with error: Error) {
            failure = error
        }

        func view(_ view: TaskViewKind, day: String, limit: Int?, before: String?) async throws -> TaskViewPage {
            calls.append("view \(view.rawValue) \(day)")
            return TaskViewPage(view: view, day: day, tasks: [])
        }

        func detail(id: String) async throws -> TaskDetail {
            TaskDetail(task: TaskRecord(id: id, title: id), history: [])
        }

        func perform(_ action: TaskAction, on id: String) async throws -> TaskMutation {
            TaskMutation(task: nil, receipt: TaskReceipt(text: "Done", undoSeq: nil))
        }

        func undo(seq: Int) async throws -> TaskMutation {
            TaskMutation(task: nil, receipt: TaskReceipt(text: "Undone", undoSeq: nil))
        }

        func startConversation(about id: String) async throws -> ConversationSummary {
            calls.append("conversation \(id)")
            if let failure { throw failure }
            return ConversationSummary(
                sessionId: "conv_\(id)",
                title: id,
                model: "m",
                backend: "b",
                createdAt: "2026-10-14T09:00:00.000Z",
                updatedAt: "2026-10-14T09:00:00.000Z",
                messageCount: 0
            )
        }
    }

    private let task = TaskRecord(id: "t", title: "Renew the studio lease")

    private func model(_ service: ChatService) -> TasksModel {
        let now = Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 14, hour: 9))!
        return TasksModel(service: service, now: { now })
    }

    /// The new conversation's id, no toast, nothing left busy, nothing re-read.
    func testStartReturnsTheNewConversation() async {
        let service = ChatService()
        let model = model(service)
        let id = await model.startConversation(about: task)
        XCTAssertEqual(id, "conv_t")
        XCTAssertNil(model.toast)
        XCTAssertTrue(model.busyIds.isEmpty)
        let calls = await service.calls
        XCTAssertEqual(calls, ["conversation t"])
    }

    /// A task deleted elsewhere answers 404: a toast says so, nothing opens,
    /// and the journal is read again so the stale row goes.
    func testAMissingTaskShowsWhyAndRereads() async {
        let service = ChatService()
        await service.fail(with: GatewayClient.Error.notFound)
        let model = model(service)
        let id = await model.startConversation(about: task)
        XCTAssertNil(id)
        XCTAssertEqual(model.toast?.text, "That task no longer exists.")
        XCTAssertEqual(model.toast?.isError, true)
        XCTAssertNil(model.toast?.undoSeq)
        XCTAssertTrue(model.busyIds.isEmpty)
        let calls = await service.calls
        XCTAssertEqual(calls, ["conversation t", "view today 2026-10-14"])
    }

    /// With no agent model to answer, the gateway refuses with 503 and says
    /// why; the toast carries its words and the journal is not re-read.
    func testNoAgentModelShowsTheGatewaysReason() async {
        let service = ChatService()
        await service.fail(with: GatewayClient.Error.serverError(
            status: 503,
            body: #"{"error":"No agent model is assigned."}"#
        ))
        let model = model(service)
        let id = await model.startConversation(about: task)
        XCTAssertNil(id)
        XCTAssertEqual(model.toast?.text, "No agent model is assigned.")
        XCTAssertEqual(model.toast?.isError, true)
        let calls = await service.calls
        XCTAssertEqual(calls, ["conversation t"])
    }

    /// An unreachable gateway is a toast and nothing more.
    func testOfflineShowsAToast() async {
        let service = ChatService()
        await service.fail(with: URLError(.notConnectedToInternet))
        let model = model(service)
        let id = await model.startConversation(about: task)
        XCTAssertNil(id)
        XCTAssertEqual(model.toast?.text, "Couldn't reach the gateway. Try again.")
        let calls = await service.calls
        XCTAssertEqual(calls, ["conversation t"])
    }

    /// Without a gateway (unpaired, or a fixture) nothing is started.
    func testWithoutAGatewayNothingStarts() async {
        let model = TasksModel(service: nil)
        let id = await model.startConversation(about: task)
        XCTAssertNil(id)
        XCTAssertNil(model.toast)
    }
}
