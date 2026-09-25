// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The watch registry as the phone reads it: the listing's two indicator fields,
/// the authorising record behind a watch that wakes an agent, and the phrases
/// every watch surface prints from them.
///
/// A watch is a watch however it was asked for, so both indicators arrive on the
/// same row as every other watch's — and a gateway that predates them has to
/// decode into a watch that simply says less, not into a failure that empties
/// the screen.
final class WatchesClientTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var body = "{}"

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            return (Data(body.utf8), response)
        }
    }

    private let baseURL = URL(string: "http://gateway.example:7600")!

    private func client(_ session: MockSession) -> WatchesClient {
        WatchesClient(baseURL: baseURL, token: "omn_test", session: session)
    }

    // MARK: - The listing

    func testListingCarriesDeliveryAndDisclosure() async throws {
        let session = MockSession()
        session.body = """
        {"watches":[
          {"id":"w-invoice","name":"invoice-due","status":"active","firings":5,"note":null,
           "request":"Tell me when an invoice reaches its due date.","delivery":"agent-wake",
           "disclosure":{"authoredBy":"integration","subscriptionId":"subscription-example",
           "status":"active","integrationName":"Fictional OpenClaw integration"}},
          {"id":"w-payment","name":"large-payment","status":"active","firings":0,"note":null,
           "request":"Tell me when a large payment leaves the account.",
           "delivery":"omnesis-notify","disclosure":null}
        ]}
        """

        let watches = try await client(session).listWatches()

        XCTAssertEqual(watches.count, 2)
        XCTAssertEqual(watches[0].delivery, "agent-wake")
        XCTAssertEqual(watches[0].disclosure?.authoredBy, "integration")
        XCTAssertEqual(watches[0].disclosure?.subscriptionId, "subscription-example")
        XCTAssertEqual(watches[0].disclosure?.status, "active")
        XCTAssertEqual(watches[0].disclosure?.integrationName, "Fictional OpenClaw integration")
        // The summary genuinely stops there. Everything the watch's own page
        // shows is absent from a row, not empty on it.
        XCTAssertNil(watches[0].disclosure?.instruction)
        XCTAssertEqual(watches[1].delivery, "omnesis-notify")
        XCTAssertNil(watches[1].disclosure)
    }

    /// A gateway that predates both fields sends neither key. Decoding that as
    /// a failure would empty the whole screen over two absent indicators.
    func testListingFromAnOlderGatewayDecodes() async throws {
        let session = MockSession()
        session.body = """
        {"watches":[{"id":"w-spend","name":"monthly-spend","status":"paused","firings":12,
        "note":"node 'spend' failed","request":"Tell me what I spent this month."}]}
        """

        let watches = try await client(session).listWatches()

        XCTAssertEqual(watches.count, 1)
        XCTAssertNil(watches[0].delivery)
        XCTAssertNil(watches[0].disclosure)
        // Which reads, correctly, as a watch nobody else asked for that tells
        // nobody anything.
        XCTAssertEqual(watchAskedBy(watches[0]), "You asked for this")
        XCTAssertEqual(watchDeliveryLabel(watches[0]), "Records only")
    }

    // MARK: - The authorising record

    func testDisclosureReadsTheWholeRecord() async throws {
        let session = MockSession()
        session.body = """
        {"watch":{"id":"w-invoice","name":"invoice-due","status":"active",
        "disclosure":{"authoredBy":"integration","subscriptionId":"subscription-example",
        "status":"active","integrationName":"Fictional OpenClaw integration","revision":2,
        "interpretation":"an invoice that has not been paid reaches its due date",
        "condition":"an invoice I have not paid reaches its due date",
        "instruction":"Draft a payment reminder.","evidence":"condition-only",
        "approval":{"id":"approval-example","subscriptionId":"subscription-example",
        "status":"approved","revision":2},"expiresAt":1901209600000,"revokedAt":null,
        "policyRevision":"policy-example","firingCount":2,"lastFiredAt":1900000500000}}}
        """

        let disclosure = try await client(session).fetchDisclosure(watchId: "w-invoice")

        XCTAssertEqual(disclosure?.revision, 2)
        XCTAssertEqual(disclosure?.instruction, "Draft a payment reminder.")
        XCTAssertEqual(disclosure?.evidence, "condition-only")
        XCTAssertEqual(disclosure?.approval?.status, "approved")
        XCTAssertEqual(disclosure?.expiresAt, 1_901_209_600_000)
        XCTAssertNil(disclosure?.revokedAt)
        XCTAssertEqual(disclosure?.policyRevision, "policy-example")
        XCTAssertEqual(disclosure?.firingCount, 2)
        XCTAssertEqual(
            session.requests[0].url?.absoluteString,
            "http://gateway.example:7600/admin/watch/watches/w-invoice"
        )
    }

    /// A watch that wakes nobody has no record at all, which is a complete
    /// answer rather than a missing one.
    func testDisclosureIsAbsentForAWatchThatWakesNobody() async throws {
        let session = MockSession()
        session.body = """
        {"watch":{"id":"w-payment","name":"large-payment","status":"active","disclosure":null}}
        """

        let disclosure = try await client(session).fetchDisclosure(watchId: "w-payment")

        XCTAssertNil(disclosure)
    }

    /// And a gateway that predates the field omits the key entirely.
    func testDisclosureIsAbsentOnAnOlderGateway() async throws {
        let session = MockSession()
        session.body = """
        {"watch":{"id":"w-payment","name":"large-payment","status":"active"}}
        """

        let disclosure = try await client(session).fetchDisclosure(watchId: "w-payment")

        XCTAssertNil(disclosure)
    }

    // MARK: - What the two indicators say

    func testAskedByReadsTheRecordRatherThanTheDeliveryKind() {
        // An operator can perfectly well write a watch that wakes an agent.
        // Calling that one the integration's request would misattribute it.
        let ownWake = watch(delivery: "agent-wake", disclosure: disclosure(authoredBy: "operator"))
        XCTAssertEqual(watchAskedBy(ownWake), "You asked for this")

        let asked = watch(delivery: "agent-wake", disclosure: disclosure(authoredBy: "integration"))
        XCTAssertEqual(watchAskedBy(asked), "Fictional OpenClaw integration asked for this")

        // Named as the operator named the device — and when they named nothing,
        // said without inventing one.
        let anonymous = watch(
            delivery: "agent-wake",
            disclosure: disclosure(authoredBy: "integration", integrationName: nil)
        )
        XCTAssertEqual(watchAskedBy(anonymous), "An integration asked for this")
    }

    func testDeliveryLabelNamesWhereAFiringGoes() {
        XCTAssertEqual(watchDeliveryLabel(watch(delivery: "omnesis-notify")), "Notifies you")
        XCTAssertEqual(
            watchDeliveryLabel(
                watch(delivery: "agent-wake", disclosure: disclosure(authoredBy: "integration"))
            ),
            "Wakes Fictional OpenClaw integration"
        )
        XCTAssertEqual(watchDeliveryLabel(watch(delivery: "agent-wake")), "Wakes an agent")
        // Nowhere is a real setting, not a missing value.
        XCTAssertEqual(watchDeliveryLabel(watch(delivery: nil)), "Records only")
        // A kind this build has not heard of is printed as it arrived. Naming
        // it would be a confident false statement about where a watch reaches.
        XCTAssertEqual(watchDeliveryLabel(watch(delivery: "carrier-pigeon")), "carrier-pigeon")
    }

    func testDeliverySentenceStatesTheSilentCase() {
        XCTAssertEqual(
            watchDeliverySentence(watch(delivery: "omnesis-notify")),
            "Notifies your devices."
        )
        XCTAssertEqual(
            watchDeliverySentence(watch(delivery: nil)),
            "Delivers nowhere. Every firing is recorded here and nobody is told."
        )
    }

    func testWakeSentenceSurvivesAnUnrecordedInstruction() {
        XCTAssertEqual(
            watchDisclosureWakeSentence(disclosure(authoredBy: "integration")),
            "Wakes Fictional OpenClaw integration: Draft a payment reminder."
        )
        XCTAssertEqual(
            watchDisclosureWakeSentence(
                disclosure(authoredBy: "integration", integrationName: nil, instruction: "   ")
            ),
            "Wakes an integration: No instruction was recorded."
        )
    }

    /// A watch with no approval was never put to the operator. Saying "approved"
    /// about a request nobody made would invent a decision.
    func testApprovalLabelDistinguishesNoneFromApproved() {
        XCTAssertEqual(
            watchDisclosureApprovalLabel(disclosure(authoredBy: "integration")),
            "Approved"
        )
        XCTAssertEqual(
            watchDisclosureApprovalLabel(
                disclosure(authoredBy: "integration", approval: WatchDisclosureApproval(status: "pending"))
            ),
            // The same word the portal prints for a decision still waiting on
            // the operator, so the two surfaces describe one record alike.
            "Queued"
        )
        XCTAssertEqual(
            watchDisclosureApprovalLabel(disclosure(authoredBy: "operator", approval: nil)),
            "Not required — you asked for this watch yourself"
        )
    }

    // MARK: - Fixtures

    private func watch(delivery: String?, disclosure: WatchDisclosure? = nil) -> WatchRecord {
        WatchRecord(
            id: "w-invoice",
            name: "invoice-due",
            status: "active",
            firings: 0,
            note: nil,
            request: "Tell me when an invoice reaches its due date.",
            delivery: delivery,
            disclosure: disclosure
        )
    }

    private func disclosure(
        authoredBy: String,
        integrationName: String? = "Fictional OpenClaw integration",
        instruction: String? = "Draft a payment reminder.",
        approval: WatchDisclosureApproval? = WatchDisclosureApproval(status: "approved")
    )
        -> WatchDisclosure {
        WatchDisclosure(
            authoredBy: authoredBy,
            subscriptionId: "subscription-example",
            status: "active",
            integrationName: integrationName,
            revision: 1,
            interpretation: "an invoice that has not been paid reaches its due date",
            condition: "an invoice I have not paid reaches its due date",
            instruction: instruction,
            evidence: "condition-only",
            approval: approval,
            expiresAt: 1_901_209_600_000,
            revokedAt: nil,
            policyRevision: "policy-example",
            firingCount: 0,
            lastFiredAt: nil
        )
    }
}
