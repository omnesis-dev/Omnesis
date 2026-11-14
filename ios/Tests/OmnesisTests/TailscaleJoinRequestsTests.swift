// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Waiting to join lists the devices waiting to join through Tailscale and sends one
/// decision at a time; a request that is gone by then is said to be gone, and the list
/// is read again.
@MainActor
final class TailscaleJoinRequestsTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_800_000_000)

    private func request(_ id: String, name: String, minutesAgo: Double) -> TailscaleJoinRequest {
        TailscaleJoinRequest(
            id: id,
            name: name,
            kind: "collector",
            machine: name,
            os: "macOS",
            login: "maya@example.com",
            requestedAt: base.addingTimeInterval(-minutesAgo * 60),
            expiresAt: base.addingTimeInterval(600)
        )
    }

    // MARK: - Model

    func testLoadListsTheWaitingDevicesOldestFirst() async {
        let client = ScriptedJoinClient(lists: [[
            request("b", name: "studio-cli", minutesAgo: 1),
            request("a", name: "maya-laptop", minutesAgo: 4),
        ]])
        let model = TailscaleJoinRequestsModel()
        XCTAssertFalse(model.loaded)

        await model.refresh(client: client)

        XCTAssertTrue(model.loaded)
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.requests.map(\.id), ["a", "b"])
        XCTAssertNil(model.error)
    }

    func testAnEmptyListIsLoadedAndEmpty() async {
        let model = TailscaleJoinRequestsModel()
        await model.refresh(client: ScriptedJoinClient(lists: [[]]))
        XCTAssertTrue(model.loaded)
        XCTAssertTrue(model.requests.isEmpty)
        XCTAssertNil(model.error)
    }

    func testApprovingSendsTheDecisionAndRemovesTheRequest() async {
        let waiting = [request("a", name: "maya-laptop", minutesAgo: 4), request("b", name: "studio-cli", minutesAgo: 1)]
        let client = ScriptedJoinClient(lists: [waiting])
        let model = TailscaleJoinRequestsModel()
        await model.refresh(client: client)

        await model.decide(waiting[0], approve: true, client: client)

        XCTAssertEqual(client.decisions, [.init(id: "a", approve: true)])
        XCTAssertEqual(model.requests.map(\.id), ["b"])
        XCTAssertNil(model.notice)
        XCTAssertNil(model.deciding)
        XCTAssertFalse(model.busy)
        XCTAssertEqual(client.listReads, 1, "A decision that landed needs no fresh read")
    }

    func testDenyingSendsTheDecisionAndRemovesTheRequest() async {
        let waiting = [request("a", name: "maya-laptop", minutesAgo: 4)]
        let client = ScriptedJoinClient(lists: [waiting])
        let model = TailscaleJoinRequestsModel()
        await model.refresh(client: client)

        await model.decide(waiting[0], approve: false, client: client)

        XCTAssertEqual(client.decisions, [.init(id: "a", approve: false)])
        XCTAssertTrue(model.requests.isEmpty)
        XCTAssertTrue(model.loaded, "An emptied list reads as nothing waiting")
    }

    func testARequestGoneByTheDecisionIsSaidToBeGoneAndTheListIsReadAgain() async {
        let gone = request("a", name: "maya-laptop", minutesAgo: 12)
        let still = request("b", name: "studio-cli", minutesAgo: 1)
        let arrived = request("c", name: "kitchen-mac", minutesAgo: 0)
        let client = ScriptedJoinClient(lists: [[gone, still], [still, arrived]], goneIds: ["a"])
        let model = TailscaleJoinRequestsModel()
        await model.refresh(client: client)

        await model.decide(gone, approve: true, client: client)

        XCTAssertEqual(model.notice, "That request has expired or was already decided.")
        XCTAssertEqual(model.requests.map(\.id), ["b", "c"])
        XCTAssertEqual(client.listReads, 2)
        XCTAssertNil(model.error)
        XCTAssertFalse(model.busy)

        await model.decide(still, approve: false, client: client)
        XCTAssertNil(model.notice, "The next decision clears the note")
    }

    func testAFailedDecisionKeepsTheRequestAndReportsTheError() async {
        let waiting = request("a", name: "maya-laptop", minutesAgo: 1)
        let client = ScriptedJoinClient(lists: [[waiting]], decisionError: URLError(.timedOut))
        let model = TailscaleJoinRequestsModel()
        await model.refresh(client: client)

        await model.decide(waiting, approve: true, client: client)

        XCTAssertEqual(model.requests, [waiting])
        XCTAssertEqual((model.error as? URLError)?.code, .timedOut)
        XCTAssertNil(model.notice)
    }

    func testAFailedReadIsReportedAndStillCountsAsLoaded() async {
        let model = TailscaleJoinRequestsModel()
        await model.refresh(client: ScriptedJoinClient(lists: [], listError: URLError(.cannotConnectToHost)))
        XCTAssertTrue(model.loaded)
        XCTAssertEqual((model.error as? URLError)?.code, .cannotConnectToHost)
    }

    func testOnlyAListedRequestCanBeDecided() async {
        let client = ScriptedJoinClient(lists: [[]])
        let model = TailscaleJoinRequestsModel()
        await model.refresh(client: client)
        await model.decide(request("x", name: "unlisted", minutesAgo: 1), approve: true, client: client)
        XCTAssertTrue(client.decisions.isEmpty)
    }

    func testStopForgetsTheList() async {
        let model = TailscaleJoinRequestsModel()
        await model.refresh(client: ScriptedJoinClient(lists: [[request("a", name: "maya-laptop", minutesAgo: 1)]]))
        model.stop()
        XCTAssertTrue(model.requests.isEmpty)
        XCTAssertFalse(model.loaded)
    }

    // MARK: - Opening from a notification

    func testAnOpenRequestIsTakenOnce() {
        let opener = TailscaleJoinRequestOpener()
        XCTAssertFalse(opener.consumeOpen())
        opener.requestOpen()
        XCTAssertTrue(opener.consumeOpen())
        XCTAssertFalse(opener.consumeOpen())
        XCTAssertTrue(TailscaleJoinRequestOpener.eligible(scopes: ["read", "admin"]))
        XCTAssertFalse(TailscaleJoinRequestOpener.eligible(scopes: ["read"]))
        XCTAssertFalse(TailscaleJoinRequestOpener.eligible(scopes: nil))
    }

    // MARK: - Presentation

    func testEachRequestReadsAsWhereItCameFromAndWhen() {
        let row = request("a", name: "maya-laptop", minutesAgo: 5)
        XCTAssertEqual(TailscaleJoinPresentation.machineLine(row), "on maya-laptop · macOS")
        XCTAssertEqual(TailscaleJoinPresentation.accountLine(row), "Tailscale account maya@example.com")
        XCTAssertTrue(TailscaleJoinPresentation.requestedLine(row, now: base).hasPrefix("Requested "))
        XCTAssertTrue(TailscaleJoinPresentation.requestedLine(row, now: base).contains("5"))

        let bare = sparse(machine: " ", login: "")
        XCTAssertNil(TailscaleJoinPresentation.machineLine(bare))
        XCTAssertNil(TailscaleJoinPresentation.accountLine(bare))
        XCTAssertEqual(TailscaleJoinPresentation.machineLine(sparse(machine: "studio-desktop", login: nil)), "on studio-desktop")
    }

    /// A request the gateway described with less: no operating system, and the given machine and login.
    private func sparse(machine: String?, login: String?) -> TailscaleJoinRequest {
        TailscaleJoinRequest(id: "s", name: "x", kind: "cli", machine: machine, os: nil, login: login, requestedAt: base, expiresAt: base)
    }

    func testARecentRequestOrOneStampedAheadOfThePhoneClockIsJustNow() {
        for minutesAgo in [-0.1, 0, 0.5] {
            XCTAssertEqual(
                TailscaleJoinPresentation.requestedLine(request("a", name: "maya-laptop", minutesAgo: minutesAgo), now: base),
                "Requested just now"
            )
        }
    }

    // MARK: - Wire

    func testTheListDecodesTheGatewaysTimestamps() async throws {
        let json = #"{"requests":[{"id":"tsj-1","name":"maya-laptop","kind":"collector","machine":"maya-laptop","#
            + #""os":"macOS","login":"maya@example.com","requestedAt":"2026-11-14T18:00:00.000Z","#
            + #""expiresAt":"2026-11-14T18:10:00Z"}]}"#
        let session = JoinHTTPSession(responses: [(200, json)])
        let client = try AdminClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")),
            token: "synthetic-token",
            session: session
        )

        let rows = try await client.tailscaleJoinRequests()

        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].requestedAt, Date(timeIntervalSince1970: 1_794_679_200))
        XCTAssertEqual(rows[0].expiresAt.timeIntervalSince(rows[0].requestedAt), 600)
        XCTAssertEqual(session.requests.first?.httpMethod, "GET")
        XCTAssertEqual(session.requests.first?.url?.path, "/admin/tailscale/join-requests")
        XCTAssertEqual(session.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-token")
    }

    func testAMalformedTimestampFailsTheRead() async throws {
        let json = #"{"requests":[{"id":"tsj-1","name":"n","kind":"cli","requestedAt":"yesterday","expiresAt":"2026-11-14T18:10:00Z"}]}"#
        let client = try AdminClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")),
            token: "t",
            session: JoinHTTPSession(responses: [(200, json)])
        )
        do {
            _ = try await client.tailscaleJoinRequests()
            XCTFail("a malformed timestamp must fail the read")
        } catch {
            guard case GatewayClient.Error.decoding = error else { return XCTFail("\(error)") }
        }
    }

    func testADecisionPostsToTheRequestAndReadsTheOutcome() async throws {
        let session = JoinHTTPSession(responses: [
            (200, #"{"status":"approved"}"#),
            (200, #"{"status":"denied"}"#),
            (404, #"{"error":"gone"}"#),
        ])
        let client = try AdminClient(baseURL: XCTUnwrap(URL(string: "https://gateway.example.test")), token: "t", session: session)

        let approved = try await client.decideTailscaleJoin(requestId: "tsj-1", approve: true)
        let denied = try await client.decideTailscaleJoin(requestId: "tsj/../2", approve: false)
        do {
            _ = try await client.decideTailscaleJoin(requestId: "tsj-3", approve: true)
            XCTFail("a gone request must throw")
        } catch {
            XCTAssertEqual(error as? GatewayClient.Error, .notFound)
        }

        XCTAssertEqual([approved, denied], [.approved, .denied])
        XCTAssertEqual(session.requests.map(\.httpMethod), ["POST", "POST", "POST"])
        XCTAssertEqual(
            session.requests.map { $0.url?.absoluteString },
            [
                "https://gateway.example.test/admin/tailscale/join-requests/tsj-1/decision",
                "https://gateway.example.test/admin/tailscale/join-requests/tsj%2F..%2F2/decision",
                "https://gateway.example.test/admin/tailscale/join-requests/tsj-3/decision",
            ]
        )
        let bodies = try session.requests.map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap($0.httpBody)) as? [String: Any])
        }
        XCTAssertEqual(bodies.map { $0["approve"] as? Bool }, [true, false, true])
        XCTAssertEqual(bodies.map { Set($0.keys) }, [["approve"], ["approve"], ["approve"]])
    }
}

/// Serves list reads in order and records each decision; `goneIds` answer as the gateway
/// does for a request that expired or was decided elsewhere.
private final class ScriptedJoinClient: TailscaleJoinDeciding, @unchecked Sendable {
    struct Decision: Equatable {
        let id: String
        let approve: Bool
    }

    private var lists: [[TailscaleJoinRequest]]
    private let goneIds: Set<String>
    private let listError: Error?
    private let decisionError: Error?
    private(set) var decisions: [Decision] = []
    private(set) var listReads = 0

    init(lists: [[TailscaleJoinRequest]], goneIds: Set<String> = [], listError: Error? = nil, decisionError: Error? = nil) {
        self.lists = lists
        self.goneIds = goneIds
        self.listError = listError
        self.decisionError = decisionError
    }

    func tailscaleJoinRequests() async throws -> [TailscaleJoinRequest] {
        listReads += 1
        if let listError { throw listError }
        return lists.count > 1 ? lists.removeFirst() : (lists.first ?? [])
    }

    func decideTailscaleJoin(requestId: String, approve: Bool) async throws -> TailscaleJoinDecision {
        if let decisionError { throw decisionError }
        if goneIds.contains(requestId) { throw GatewayClient.Error.notFound }
        decisions.append(Decision(id: requestId, approve: approve))
        return approve ? .approved : .denied
    }
}

private final class JoinHTTPSession: URLSessionLike, @unchecked Sendable {
    private var responses: [(Int, String)]
    private(set) var requests: [URLRequest] = []

    init(responses: [(Int, String)]) {
        self.responses = responses
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        let (status, body) = responses.isEmpty ? (500, "") : responses.removeFirst()
        let url = try XCTUnwrap(request.url)
        let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil))
        return (Data(body.utf8), response)
    }
}
