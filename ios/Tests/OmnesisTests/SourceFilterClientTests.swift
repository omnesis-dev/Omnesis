// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessSourceFilterClientTests: XCTestCase {
    private final class Session: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var body = "{}"
        var status = 200
        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
        }
    }

    func testOldEditorCannotReadOptionsThroughChangedPairing() async throws {
        let oldSession = Session(), newSession = Session()
        let old = try AccessClient(baseURL: XCTUnwrap(URL(string: "https://old.example.org")), token: "old-owner", session: oldSession)
        let changedGateway = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://new.example.org")),
            token: "new-owner",
            session: newSession
        )
        let changedToken = AccessClient(baseURL: old.baseURL, token: "new-owner", session: newSession)
        for current in [changedGateway, changedToken] {
            do {
                _ = try await old.authorized(for: current).scopeOptions(sourceId: "gmail:mail@example.org", kind: "label", query: "Design")
                XCTFail("An old source draft must not cross a pairing boundary")
            } catch GatewayClient.Error.unauthorized {} catch { XCTFail("Unexpected error: \(error)") }
        }
        XCTAssertTrue(oldSession.requests.isEmpty)
        XCTAssertTrue(newSession.requests.isEmpty)
        XCTAssertTrue(try old.authorized(for: old) === old)
    }

    func testProviderPolicyPreviewPayloadsUseStrictWireReferencesAndSeparateDisplayNames() async throws {
        let participant = ScopeRef(
            kind: "participant",
            label: "Jamie Lopez",
            identifiers: [.init(type: "email", value: "jamie@example.org")]
        )
        let cases: [(String, [ScopeRef])] = [
            ("gmail:mail@example.org", [.init(kind: "label", id: "Label_design"), participant]),
            ("google-drive:files@example.org", [.init(kind: "folder", id: "projects")]),
            ("whatsapp-messages:+15550100111", [.init(kind: "conversation", id: "conversation-example")]),
        ]
        for (sourceId, refs) in cases {
            let session = Session()
            session.body = """
            {"sourceId":"\(sourceId)","total":1,"visible":1,"hidden":0,"unknown":0,
             "items":[],"samples":[],"readiness":[]}
            """
            let client = try AccessClient(
                baseURL: XCTUnwrap(URL(string: "https://gateway.example.org")),
                token: "fictional-owner",
                session: session
            )
            var policy = ScopePolicy.empty(sourceId: sourceId, levelId: "example-level", capability: "answer")
            policy.rules[0].match = refs
            _ = try await client.scopePreview(policy)
            let body = try XCTUnwrap(session.requests.last?.httpBody)
            let root = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
            let encodedPolicy = try XCTUnwrap(root["policy"] as? [String: Any])
            let rules = try XCTUnwrap(encodedPolicy["rules"] as? [[String: Any]])
            let matches = try XCTUnwrap(rules.first?["match"] as? [[String: Any]])
            for ref in matches {
                let participant = ref["kind"] as? String == "participant"
                XCTAssertEqual(Set(ref.keys), participant ? ["kind", "label", "identifiers"] : ["kind", "id"])
            }
        }
        // Deliberately invalid defensive input: the DTO must remain lossless rather than silently stripping fields.
        let invalid = ScopeRef(kind: "folder", id: "opaque-invalid-example", label: "Invalid wire field")
        let encodedInvalid = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(invalid)) as? [String: Any])
        XCTAssertEqual(encodedInvalid["label"] as? String, "Invalid wire field")
    }

    func testPickerEncodesAccountAndQueryAsSeparateComponents() async throws {
        let session = Session()
        session.body = """
        {"sourceId":"scope-chat:one/account","sourceType":"scope-chat",
        "scopes":{"items":[]},"readiness":[],"items":[],"nextCursor":"next-page"}
        """
        let client = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example")),
            token: "fictional-owner",
            session: session
        )
        let value = try await client.scopeOptions(
            sourceId: "scope-chat:one/account",
            kind: "folder",
            query: "Cedar & archive",
            parentId: "folder/one",
            cursor: "page+two"
        )
        XCTAssertEqual(value.nextCursor, "next-page")
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertTrue(try XCTUnwrap(request.url?.absoluteString.contains("scope-chat%3Aone%2Faccount/options")))
        let query = try XCTUnwrap(try URLComponents(url: XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(query.first { $0.name == "q" }?.value, "Cedar & archive")
        XCTAssertEqual(query.first { $0.name == "parentId" }?.value, "folder/one")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-store")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer fictional-owner")
    }

    func testPreviewSendsCapturedIdentifiersAndKeepsUnknownCounts() async throws {
        let session = Session()
        session.body = """
        {"sourceId":"scope-chat:one","total":3,"visible":1,"hidden":2,"unknown":1,"items":[],"samples":[],"readiness":[]}
        """
        var policy = ScopePolicy.empty(sourceId: "scope-chat:one", levelId: "new", capability: "answer")
        policy.rules[0].match = [.init(kind: "participant", label: "Maya", identifiers: [.init(type: "phone", value: "+15550100123")])]
        let client = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example")),
            token: "fictional-owner",
            session: session
        )
        let value = try await client.scopePreview(policy)
        XCTAssertEqual(value.hidden, 2)
        XCTAssertEqual(value.unknown, 1)
        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertNotNil(body["policy"])
        XCTAssertFalse(try XCTUnwrap(try String(data: XCTUnwrap(request.httpBody), encoding: .utf8)?.contains("personId")))
    }

    func testLevelUpdateCarriesBothPreviousFilterRevisionsIncludingRemovedCapabilities() async throws {
        let session = Session()
        session.status = 409
        session.body = "{\"error\":\"stale-filter-revision\"}"
        let client = try AccessClient(
            baseURL: XCTUnwrap(URL(string: "https://gateway.example")),
            token: "fictional-owner",
            session: session
        )
        do {
            _ = try await client.updateLevel(
                id: "level-example",
                name: "Research assistant",
                rules: [.notes],
                expectedRevision: 7,
                expectedFilterRevisions: ["answer": 4, "direct": 2]
            )
            XCTFail("Stale edits must be refused")
        } catch GatewayClient.Error.serverError(let status, _) { XCTAssertEqual(status, 409) }
        let request = try XCTUnwrap(session.requests.first)
        let body = try XCTUnwrap(try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(body["expectedRevision"] as? Int, 7)
        XCTAssertEqual(body["expectedFilterRevisions"] as? [String: Int], ["answer": 4, "direct": 2])
        XCTAssertEqual(session.requests.count, 1)
    }
}

private actor ScopeReadProbe {
    private var continuations: [CheckedContinuation<Data, Never>] = []
    private(set) var starts = 0
    private(set) var active = 0
    private(set) var peak = 0
    let firstTwo: XCTestExpectation
    let allThree: XCTestExpectation
    init(firstTwo: XCTestExpectation, allThree: XCTestExpectation) {
        self.firstTwo = firstTwo
        self.allThree = allThree
    }

    func run() async -> Data {
        starts += 1
        active += 1
        peak = max(peak, active)
        if starts <= 2 { firstTwo.fulfill() }
        allThree.fulfill()
        let result = await withCheckedContinuation { continuations.append($0) }
        active -= 1
        return result
    }

    func completePending() {
        let pending = continuations
        continuations = []
        pending.forEach { $0.resume(returning: Data("result".utf8)) }
    }
}

extension AccessSourceFilterClientTests {
    func testCancelledConsumersKeepPhysicalReadBudgetUntilTransportCompletes() async throws {
        let coordinator = ScopeReadCoordinator()
        let firstTwo = expectation(description: "two physical reads")
        firstTwo.expectedFulfillmentCount = 2
        let allThree = expectation(description: "third starts after capacity is released")
        allThree.expectedFulfillmentCount = 3
        let probe = ScopeReadProbe(firstTwo: firstTwo, allThree: allThree)
        let first = Task { try await coordinator.read(key: "gateway-a/owner/source/options") { await probe.run() } }
        let duplicate = Task { try await coordinator.read(key: "gateway-a/owner/source/options") { await probe.run() } }
        let second = Task { try await coordinator.read(key: "gateway-a/owner/source/preview") { await probe.run() } }
        let third = Task { try await coordinator.read(key: "gateway-b/other/source/options") { await probe.run() } }
        await fulfillment(of: [firstTwo], timeout: 3)
        first.cancel()
        let startsBeforeRelease = await probe.starts
        XCTAssertEqual(startsBeforeRelease, 2)
        await probe.completePending()
        await fulfillment(of: [allThree], timeout: 3)
        await probe.completePending()
        do { _ = try await first.value
            XCTFail("Cancelled consumer should not accept a result")
        } catch is CancellationError {}
        _ = try await duplicate.value
        _ = try await second.value
        _ = try await third.value
        let peak = await probe.peak
        let starts = await probe.starts
        XCTAssertEqual(peak, 2)
        XCTAssertEqual(starts, 3)
    }
}

private actor ScopeReadCounter {
    private(set) var count = 0
    func next() -> Data {
        count += 1
        return Data([UInt8(count)])
    }
}

extension AccessSourceFilterClientTests {
    func testImmediateFollowupReadNeverReusesCompletedValidation() async throws {
        let coordinator = ScopeReadCoordinator()
        let counter = ScopeReadCounter()
        for _ in 0 ..< 20 {
            async let first = coordinator.read(key: "same-gateway-and-source") { await counter.next() }
            async let duplicate = coordinator.read(key: "same-gateway-and-source") { await counter.next() }
            let completed = try await duplicate
            let fresh = try await coordinator.read(key: "same-gateway-and-source") { await counter.next() }
            _ = try await first
            XCTAssertGreaterThan(try XCTUnwrap(fresh.first), try XCTUnwrap(completed.first))
        }
    }
}

extension AccessSourceFilterClientTests {
    func testCancelledQueuedSearchNeverReachesTransportBeforeCurrentSearch() async throws {
        let coordinator = ScopeReadCoordinator()
        let firstTwo = expectation(description: "physical slots occupied")
        firstTwo.expectedFulfillmentCount = 2
        let allThree = expectation(description: "current fourth request starts")
        allThree.expectedFulfillmentCount = 3
        let probe = ScopeReadProbe(firstTwo: firstTwo, allThree: allThree)
        let first = Task { try await coordinator.read(key: "first") { await probe.run() } }
        let second = Task { try await coordinator.read(key: "second") { await probe.run() } }
        await fulfillment(of: [firstTwo], timeout: 3)
        let cancelled = Task {
            try await coordinator.read(key: "obsolete-query") {
                XCTFail("Cancelled queued request reached transport")
                return Data()
            }
        }
        for _ in 0 ..< 1000 {
            if await coordinator.queuedCount == 1 { break }
            await Task.yield()
        }
        let queued = await coordinator.queuedCount
        XCTAssertEqual(queued, 1)
        cancelled.cancel()
        do { _ = try await cancelled.value
            XCTFail("Expected cancellation")
        } catch is CancellationError {}
        let current = Task { try await coordinator.read(key: "current-query") { await probe.run() } }
        await probe.completePending()
        await fulfillment(of: [allThree], timeout: 3)
        await probe.completePending()
        _ = try await first.value
        _ = try await second.value
        _ = try await current.value
        let starts = await probe.starts
        XCTAssertEqual(starts, 3)
    }
}
