// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class TasksClientTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var status = 200
        var body = "{}"

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
    }

    private let base = URL(string: "https://gateway.example.com:7600")!

    private func client(_ session: MockSession) -> TasksClient {
        TasksClient(baseURL: base, token: "omn_t", session: session)
    }

    private func jsonBody(_ request: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
    }

    private static let taskJSON = """
    {"id":"loop_1","title":"Pay the Studio Northstar invoice","description":"Invoice 2041",
     "state":"open","origin":"note","accepted":false,"scheduledFor":"2026-10-12",
     "deadline":{"type":"by","date":"2026-10-16"},"dueDay":"2026-10-16","carried":true,
     "completionNote":null,
     "proposedChange":{"kind":"complete","fields":null,"reason":"A payment confirmation arrived.",
                       "evidence":["doc_1"],"proposedAt":"2026-10-14T07:10:00.000Z"},
     "actors":[{"id":"p_self","name":"You","isSelf":true},{"id":"p_2","name":"Maya Reeves","isSelf":false}],
     "blockedBy":[{"id":"loop_0","title":"Get the invoice approved"}],
     "documents":[{"id":"doc_1","title":"Invoice 2041","sourceId":"mail:inbox"}],"createdAt":"2026-10-09T18:20:00.000Z",
     "lastUpdate":"2026-10-14T07:10:00.000Z","resolvedAt":null}
    """

    func testNoteProcessingStatusDistinguishesInactiveFromUnknown() throws {
        let decoder = JSONDecoder()
        let base = #"{"documents":{"total":0,"bySource":{}}}"#
        XCTAssertNil(try decoder.decode(StatusSnapshot.self, from: Data(base.utf8)).noteAgent)
        for (enabled, assigned, expected) in [
            (false, true, "Note processing is off"),
            (true, false, "Agent model is missing or unavailable"),
        ] {
            let body = #"""
            {"documents":{"total":0,"bySource":{}},
             "noteAgent":{"enabled":\#(enabled),"modelAssigned":\#(assigned),"active":false}}
            """#
            let status = try decoder.decode(StatusSnapshot.self, from: Data(body.utf8))
            XCTAssertTrue(status.noteAgent?.notice?.contains(expected) == true)
        }
        XCTAssertNil(NoteAgentStatus(enabled: true, modelAssigned: true, active: true).notice)
    }

    // MARK: - Reads

    func testViewRequestAndDecode() async throws {
        let session = MockSession()
        session.body = """
        {"view":"today","day":"2026-10-14","tasks":[\(Self.taskJSON)],
         "counts":{"today":4,"month":10,"future":3,"anytime":2,"waiting":1,
                   "suggested":2,"proposals":1,"carried":1}}
        """
        let page = try await client(session).view(.today, day: "2026-10-14")

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/tasks")
        XCTAssertEqual(
            Set(components.queryItems ?? []),
            [URLQueryItem(name: "view", value: "today"), URLQueryItem(name: "date", value: "2026-10-14")]
        )

        XCTAssertEqual(page.day, "2026-10-14")
        XCTAssertEqual(
            page.counts,
            TaskCounts(today: 4, month: 10, future: 3, anytime: 2, waiting: 1, suggested: 2, proposals: 1, carried: 1)
        )
        let task = try XCTUnwrap(page.tasks.first)
        XCTAssertEqual(task.id, "loop_1")
        XCTAssertEqual(task.state, .open)
        XCTAssertEqual(task.origin, .note)
        XCTAssertTrue(task.carried)
        XCTAssertEqual(task.deadline, TaskDeadline(type: .by, date: "2026-10-16"))
        XCTAssertEqual(task.proposedChange?.kind, .complete)
        XCTAssertEqual(task.proposedChange?.evidence, ["doc_1"])
        XCTAssertEqual(task.blockedBy, [TaskBlocker(id: "loop_0", title: "Get the invoice approved")])
        XCTAssertEqual(task.documents, [TaskDocument(id: "doc_1", title: "Invoice 2041", sourceId: "mail:inbox")])
        XCTAssertEqual(TaskJournal.people(task), ["Maya Reeves"])
        XCTAssertFalse(task.isResolved)
        XCTAssertFalse(task.isSuggestion)
    }

    func testDonePagingSendsLimitAndBefore() async throws {
        let session = MockSession()
        session.body = #"{"view":"done","day":"2026-10-14","tasks":[],"counts":{}}"#
        _ = try await client(session).view(.done, day: "2026-10-14", limit: 50, before: "2026-10-01T10:00:00.000Z")
        let url = try XCTUnwrap(session.requests.first?.url)
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        XCTAssertTrue(items.contains(URLQueryItem(name: "limit", value: "50")))
        XCTAssertTrue(items.contains(URLQueryItem(name: "before", value: "2026-10-01T10:00:00.000Z")))
    }

    /// Unknown states, origins and proposal kinds, a bare-string deadline and
    /// missing optional fields all decode instead of failing the view.
    func testTaskDecodeIsTolerant() throws {
        let task = try JSONDecoder().decode(
            TaskRecord.self,
            from: Data(
                """
                {"id":"loop_2","title":"Renew the passport","state":"paused","origin":"calendar",
                 "deadline":"2026-11-30","proposedChange":{"kind":"merge","reason":"Duplicate"},
                 "actors":"not a list"}
                """.utf8
            )
        )
        XCTAssertNil(task.state)
        XCTAssertNil(task.origin)
        XCTAssertEqual(task.deadline, TaskDeadline(type: .by, date: "2026-11-30"))
        XCTAssertNil(task.proposedChange?.kind)
        XCTAssertEqual(task.proposedChange?.reason, "Duplicate")
        XCTAssertEqual(task.actors, [])
        XCTAssertEqual(task.description, "")
        XCTAssertFalse(task.isResolved)
    }

    func testSuggestionAndResolvedFlags() {
        XCTAssertTrue(TaskRecord(id: "a", title: "A", origin: .brain).isSuggestion)
        XCTAssertFalse(TaskRecord(id: "b", title: "B", origin: .brain, accepted: true).isSuggestion)
        // An ignored suggestion is still an open loop, but no longer offered.
        XCTAssertFalse(TaskRecord(id: "i", title: "I", origin: .brain, ignored: true).isSuggestion)
        XCTAssertTrue(TaskRecord(id: "c", title: "C", state: .dismissed).isResolved)
        XCTAssertEqual(TaskRecord(id: "d", title: "D").with(state: .done).state, .done)
    }

    func testDetailDecodesHistory() async throws {
        let session = MockSession()
        session.body = """
        {"task":\(Self.taskJSON),
         "history":[
           {"seq":41,"at":"2026-10-14T08:00:00.000Z","note":"Moved to today","kind":"migrated",
            "surface":"tasks","conversationId":null,"from":"2026-10-12","to":"2026-10-14"},
           {"seq":37,"at":"2026-10-12T19:40:00.000Z","note":"Asked to keep it","kind":"edited",
            "surface":"conversation","conversationId":"conv_1","from":null,"to":null},
           {"seq":30,"at":"2026-10-10T08:00:00.000Z","note":"Reworded","kind":"renamed_in_future",
            "surface":"brain","conversationId":null,"from":{"title":"x"},"to":null}
         ],
         "undoSeq":41}
        """
        let detail = try await client(session).detail(id: "loop_1")
        XCTAssertEqual(session.requests.first?.url?.path, "/tasks/loop_1")
        XCTAssertEqual(detail.undoSeq, 41)
        XCTAssertEqual(detail.history.map(\.seq), [41, 37, 30])
        XCTAssertEqual(detail.history[0].to, "2026-10-14")
        XCTAssertEqual(detail.history[1].conversationId, "conv_1")
        XCTAssertNil(detail.history[2].from, "a non-string from is not rendered")
        XCTAssertEqual(TaskJournal.eventTitle(detail.history[0]), "Moved")
        XCTAssertEqual(TaskJournal.eventTitle(detail.history[2]), "Note")
        XCTAssertEqual(TaskJournal.eventSource(detail.history[1]), "In a conversation")
        XCTAssertNil(TaskJournal.eventSource(detail.history[0]))
    }

    func testAutoAppliedEventDecodesChangeAndEvidence() async throws {
        let session = MockSession()
        session.body = """
        {"task":\(Self.taskJSON),
         "history":[
           {"seq":52,"at":"2026-10-14T07:10:00.000Z","note":"The receipt says it was paid.",
            "kind":"auto_applied","surface":"brain","conversationId":null,"from":null,"to":null,
            "change":"complete","evidence":["doc_receipt_1"]},
           {"seq":41,"at":"2026-10-14T08:00:00.000Z","note":"Moved","kind":"migrated","surface":"tasks"}
         ],
         "undoSeq":52}
        """
        let detail = try await client(session).detail(id: "loop_1")
        XCTAssertEqual(detail.history[0].change, "complete")
        XCTAssertEqual(detail.history[0].evidence, ["doc_receipt_1"])
        // An older gateway sends neither field.
        XCTAssertNil(detail.history[1].change)
        XCTAssertEqual(detail.history[1].evidence, [])
        XCTAssertEqual(TaskJournal.eventTitle(detail.history[0]), "Marked done by Omnesis")
        XCTAssertNil(TaskJournal.eventSource(detail.history[0]))
        XCTAssertEqual(TaskJournal.autoAppliedUndoSeq(detail), 52)
    }

    func testSuggestionEventsReadAsTheyNowMean() {
        func title(_ kind: String) -> String {
            TaskJournal.eventTitle(TaskEvent(seq: 1, at: nil, note: "", kind: kind, surface: "tasks"))
        }
        XCTAssertEqual(title("ignored"), "Ignored")
        // An older gateway dismissed a declined suggestion.
        XCTAssertEqual(title("refused"), "Dismissed")
        XCTAssertEqual(title("completed"), "Done")
        XCTAssertEqual(title("accepted"), "Accepted")
    }

    func testIgnoredDecodesAndDefaultsToFalse() throws {
        let decoder = JSONDecoder()
        let ignored = try decoder.decode(
            TaskRecord.self,
            from: Data(#"{"id":"a","title":"A","origin":"brain","ignored":true}"#.utf8)
        )
        XCTAssertTrue(ignored.ignored)
        XCTAssertFalse(ignored.isSuggestion)
        let older = try decoder.decode(TaskRecord.self, from: Data(#"{"id":"b","title":"B","origin":"brain"}"#.utf8))
        XCTAssertFalse(older.ignored)
        XCTAssertTrue(older.isSuggestion)
    }

    /// Every read goes to the gateway: a view answered from the URL cache
    /// would show a task as it was before the last change — a suggestion
    /// still offering Accept after it was accepted.
    func testReadsNeverComeFromACache() async throws {
        let session = MockSession()
        session.body = #"{"view":"month","day":"2026-10-14","tasks":[],"counts":{}}"#
        let tasks = client(session)
        _ = try await tasks.view(.month, day: "2026-10-14")
        session.body = #"{"day":"2026-10-14","counts":{}}"#
        _ = try await tasks.counts(day: "2026-10-14")
        session.body = #"{"task":{"id":"loop_1","title":"T"},"history":[]}"#
        _ = try await tasks.detail(id: "loop_1")
        XCTAssertEqual(session.requests.count, 3)
        for request in session.requests {
            XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
        }
    }

    func testCountsRequestAndDecode() async throws {
        let session = MockSession()
        session.body = """
        {"day":"2026-10-14","counts":{"today":4,"month":10,"future":3,"anytime":2,"waiting":1,
                                      "suggested":2,"proposals":1,"carried":1}}
        """
        let page = try await client(session).counts(day: "2026-10-14")

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        let components = try XCTUnwrap(URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/tasks/counts")
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "date", value: "2026-10-14")])
        XCTAssertEqual(page.day, "2026-10-14")
        XCTAssertEqual(page.counts.today, 4)
        XCTAssertEqual(page.counts.month, 10)
        XCTAssertEqual(page.counts.future, 3)
        XCTAssertEqual(page.counts.anytime, 2)
        XCTAssertEqual(page.counts.waiting, 1)
        XCTAssertEqual(page.counts.suggested, 2)
        XCTAssertEqual(page.counts.proposals, 1)
        XCTAssertEqual(page.counts.carried, 1)
    }

    /// A gateway that predates the per-view counts sends only the three it
    /// had; the rest read as zero rather than failing the whole page.
    func testCountsMissingKeysDecodeAsZero() throws {
        let data = Data(#"{"view":"today","day":"2026-10-14","tasks":[],"counts":{"suggested":2}}"#.utf8)
        let page = try JSONDecoder().decode(TaskViewPage.self, from: data)
        XCTAssertEqual(page.counts, TaskCounts(suggested: 2))
        let bare = try JSONDecoder().decode(TaskCountsPage.self, from: Data(#"{"day":"2026-10-14"}"#.utf8))
        XCTAssertEqual(bare.counts, TaskCounts())
    }

    func testCountsUnauthorizedThrows() async {
        let session = MockSession()
        session.status = 401
        do {
            _ = try await client(session).counts(day: "2026-10-14")
            XCTFail("expected unauthorized")
        } catch GatewayClient.Error.unauthorized {
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    // MARK: - Mutations

    private static let mutationJSON = #"{"task":null,"receipt":{"text":"Deleted: Renew the passport","undoSeq":52}}"#

    func testActionBodies() throws {
        func encode(_ action: TaskAction) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(action)) as? [String: Any])
        }
        XCTAssertEqual(try encode(.complete(note: nil)) as NSDictionary, ["action": "complete"])
        XCTAssertEqual(try encode(.complete(note: "  ")) as NSDictionary, ["action": "complete"])
        XCTAssertEqual(
            try encode(.complete(note: " Paid by card ")) as NSDictionary,
            ["action": "complete", "note": "Paid by card"]
        )
        XCTAssertEqual(try encode(.migrate(to: "2026-11")) as NSDictionary, ["action": "migrate", "to": "2026-11"])
        XCTAssertEqual(try encode(.strike(reason: nil)) as NSDictionary, ["action": "strike"])
        XCTAssertEqual(try encode(.ignore(reason: "Not mine")) as NSDictionary, ["action": "ignore", "reason": "Not mine"])
        XCTAssertEqual(try encode(.ignore(reason: nil)) as NSDictionary, ["action": "ignore"])
        XCTAssertEqual(try encode(.confirm) as NSDictionary, ["action": "confirm"])
        XCTAssertEqual(try encode(.keep) as NSDictionary, ["action": "keep"])
        XCTAssertEqual(try encode(.reopen) as NSDictionary, ["action": "reopen"])
        XCTAssertEqual(try encode(.accept(scheduledFor: .unchanged)) as NSDictionary, ["action": "accept"])
        XCTAssertEqual(
            try encode(.accept(scheduledFor: .set("2026-10-15"))) as NSDictionary,
            ["action": "accept", "scheduledFor": "2026-10-15"]
        )
        // Accepting with a note sends the trimmed note and its id; a blank
        // note is no note at all.
        XCTAssertEqual(
            try encode(.accept(scheduledFor: .unchanged, note: " Pay from the joint account ", noteId: "n-1"))
                as NSDictionary,
            ["action": "accept", "note": "Pay from the joint account", "noteId": "n-1"]
        )
        XCTAssertEqual(
            try encode(.accept(scheduledFor: .set("someday"), note: "  ", noteId: "n-2")) as NSDictionary,
            ["action": "accept", "scheduledFor": "someday"]
        )
        // Clearing a field sends an explicit null; leaving it alone omits it.
        let cleared = try encode(.accept(scheduledFor: .set(nil)))
        XCTAssertTrue(cleared["scheduledFor"] is NSNull)
        let edit = try encode(.edit(
            title: "Renew the passport",
            description: nil,
            scheduledFor: .unchanged,
            deadline: .set(TaskDeadline(type: .onDay, date: "2026-11-30"))
        ))
        XCTAssertEqual(edit["action"] as? String, "edit")
        XCTAssertEqual(edit["title"] as? String, "Renew the passport")
        XCTAssertNil(edit["scheduledFor"])
        XCTAssertNil(edit["description"])
        XCTAssertEqual(edit["deadline"] as? NSDictionary, ["type": "on_day", "date": "2026-11-30"])
    }

    /// `POST /tasks/:id/conversation` with an empty object, answered with the
    /// new conversation's summary and its `task` origin.
    func testStartConversationRequestAndDecode() async throws {
        let session = MockSession()
        session.body = """
        {"conversation":{"id":"conv_42","title":"Pay the studio invoice","model":"claude-sonnet-4-6",
         "backend":"anthropic","createdAt":"2026-10-14T09:00:00.000Z","updatedAt":"2026-10-14T09:00:00.000Z",
         "messageCount":0,
         "origin":{"kind":"task","taskId":"loop_1","runId":"loop_1",
                   "task":{"title":"Pay the studio invoice","state":"open","sourceCount":1},
                   "seedMessageCount":0}}}
        """
        let summary = try await client(session).startConversation(about: "loop_1")

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/tasks/loop_1/conversation")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertTrue(try jsonBody(request).isEmpty)
        XCTAssertEqual(summary.sessionId, "conv_42")
        XCTAssertEqual(summary.messageCount, 0)
        XCTAssertEqual(summary.origin?.taskCard?.title, "Pay the studio invoice")
    }

    func testStartConversationOnAMissingTaskIsNotFound() async {
        let session = MockSession()
        session.status = 404
        session.body = #"{"error":"Task not found"}"#
        do {
            _ = try await client(session).startConversation(about: "loop_gone")
            XCTFail("expected notFound")
        } catch {
            XCTAssertEqual(error as? GatewayClient.Error, .notFound)
        }
    }

    func testPerformAndUndoRoutes() async throws {
        let session = MockSession()
        session.body = Self.mutationJSON
        let tasks = client(session)
        _ = try await tasks.perform(.strike(reason: nil), on: "loop 1")
        _ = try await tasks.undo(seq: 52)
        XCTAssertEqual(session.requests[0].url?.path, "/tasks/loop 1/actions")
        XCTAssertEqual(session.requests[1].url?.path, "/tasks/undo")
        XCTAssertEqual(try jsonBody(session.requests[1])["seq"] as? Int, 52)
    }

    func testConflictSurfacesAsServerError() async {
        let session = MockSession()
        session.status = 409
        session.body = #"{"error":"Task changed since you read it","code":"not_latest"}"#
        do {
            _ = try await client(session).perform(.confirm, on: "loop_1")
            XCTFail("expected a conflict")
        } catch GatewayClient.Error.serverError(let status, _) {
            XCTAssertEqual(status, 409)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testStatusDecodesTasks() throws {
        let status = try JSONDecoder().decode(
            TasksStatus.self,
            from: Data(#"{"available":true,"noteAgent":true}"#.utf8)
        )
        XCTAssertEqual(status, TasksStatus(available: true, noteAgent: true))
        let sparse = try JSONDecoder().decode(TasksStatus.self, from: Data("{}".utf8))
        XCTAssertFalse(sparse.available)
    }
}
