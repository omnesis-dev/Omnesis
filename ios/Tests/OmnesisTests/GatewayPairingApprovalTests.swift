// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@MainActor
final class GatewayPairingApprovalTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1000)
    private let code = "465 774"
    private let id = "00000000-0000-4000-8000-000000000901"

    private func request(
        id: String = "00000000-0000-4000-8000-000000000901",
        kind: String = "ios",
        name: String = "Test phone",
        status: String = "pending",
        code: String = "465 774",
        expiry: Double = 1_100_000
    )
        -> GatewayPairingApprovalRequest {
        .init(requestId: id, kind: kind, name: name, status: status, verificationCode: code, expiresAt: expiry)
    }

    func testApprovalRequiresEveryGroupComparisonOfCurrentPendingRequest() async {
        let row = request()
        let client = ApprovalClient([row])
        let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
        await model.refresh(client: client)
        XCTAssertEqual(model.requests, [row])
        XCTAssertFalse(model.canApprove(row))
        await model.decide(row, approve: true, client: client)
        let decisionCount = await client.decisionCount()
        XCTAssertEqual(decisionCount, 0)
        model.setCompared(true, requestId: "unknown")
        XCTAssertFalse(model.isCompared(row))
        model.setCompared(true, requestId: id)
        XCTAssertTrue(model.canApprove(row))
        model.setCompared(false, requestId: id)
        XCTAssertFalse(model.canApprove(row))
        model.setCompared(true, requestId: id)
        await model.decide(row, approve: true, client: client)
        XCTAssertTrue(model.requests.isEmpty)
        XCTAssertFalse(model.isCompared(row))
        let lastDecision = await client.lastDecision()
        XCTAssertEqual(lastDecision, true)
    }

    func testOnlyRequestsStillWaitingAreListed() async {
        let approved = request(id: "00000000-0000-4000-8000-000000000902", status: "approved")
        let denied = request(id: "00000000-0000-4000-8000-000000000903", status: "denied")
        let first = request()
        let second = request(id: "00000000-0000-4000-8000-000000000904")
        let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
        await model.refresh(client: ApprovalClient([approved, first, denied, second]))
        XCTAssertEqual(model.requests, [first, second])
    }

    func testOneButtonConfirmsOnlyTheCurrentDisplayedRequest() async {
        let row = request()
        let client = ApprovalClient([row])
        let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
        await model.refresh(client: client)
        await model.confirmAndApprove(request(id: UUID().uuidString), client: client)
        let before = await client.decisionCount()
        XCTAssertEqual(before, 0)
        await model.confirmAndApprove(row, client: client)
        await model.confirmAndApprove(row, client: client)
        let after = await client.decisionCount()
        XCTAssertEqual(after, 1)
        XCTAssertTrue(model.requests.isEmpty)
    }

    func testRejectionDoesNotRequireComparisonButStillNeedsCurrentPendingRequest() async {
        let row = request()
        let client = ApprovalClient([row])
        let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
        await model.refresh(client: client)
        await model.decide(request(id: UUID().uuidString), approve: false, client: client)
        let decisionCount = await client.decisionCount()
        XCTAssertEqual(decisionCount, 0)
        await model.decide(row, approve: false, client: client)
        let lastDecision = await client.lastDecision()
        XCTAssertEqual(lastDecision, false)
        XCTAssertFalse(model.busy)
    }

    func testExpiredAndNonpendingRequestsCannotApproveOrReject() async {
        for row in [request(expiry: 1_000_000), request(status: "approved"), request(status: "approving"), request(status: "denied")] {
            let client = ApprovalClient([row])
            let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
            await model.refresh(client: client)
            model.setCompared(true, requestId: row.id)
            XCTAssertFalse(model.canApprove(row))
            await model.decide(row, approve: false, client: client)
            let decisionCount = await client.decisionCount()
            XCTAssertEqual(decisionCount, 0)
        }
    }

    func testRefreshDropsComparisonIfGatewayCodeChangesAndKeepsUnchangedComparison() async {
        let row = request()
        let client = ApprovalClient([row])
        let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
        await model.refresh(client: client)
        model.setCompared(true, requestId: id)
        await model.refresh(client: client)
        XCTAssertTrue(model.isCompared(row))
        await client.setRows([request(id: UUID().uuidString)])
        await model.refresh(client: client)
        XCTAssertFalse(model.isCompared(row))
        await client.setRows([row])
        await model.refresh(client: client)
        model.setCompared(true, requestId: id)
        let changed = request(code: "081 434")
        await client.setRows([changed])
        await model.refresh(client: client)
        XCTAssertFalse(model.isCompared(changed))
        await model.decide(row, approve: true, client: client)
        let decisionCount = await client.decisionCount()
        XCTAssertEqual(decisionCount, 0)
    }

    func testMalformedRequestsNeverReachApprovalSurface() async {
        let invalid = [
            request(id: "not-uuid"),
            request(kind: "unknown"),
            request(name: ""),
            request(name: String(repeating: "x", count: 81)),
            request(status: "unknown"),
            request(code: "AAAA"),
            request(code: "AAAA-BBBB-CCCC-DDDD-EEEE"),
            request(code: "465774"),
            request(expiry: 0),
            request(expiry: .infinity),
        ]
        for rows in invalid.map({ [$0] }) + [[request(), request()]] + [Array(repeating: request(), count: 129)] {
            let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
            await model.refresh(client: ApprovalClient(rows))
            XCTAssertTrue(model.requests.isEmpty)
            XCTAssertNotNil(model.error)
            XCTAssertFalse(model.busy)
        }
        for kind in ["ios", "android", "collector", "cli", "portal"] {
            let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
            await model.refresh(client: ApprovalClient([request(kind: kind)]))
            XCTAssertNil(model.error)
        }
    }

    func testDefaultClockRejectsExpiredRequestWithoutChangingItsTrustPolicy() async {
        let row = request(expiry: 1)
        let model = GatewayPairingApprovalModel()
        await model.refresh(client: ApprovalClient([row]))
        model.setCompared(true, requestId: row.id)
        XCTAssertFalse(model.canApprove(row))
    }

    func testFailuresKeepComparisonForExplicitRetryAndNeverImplyApproval() async {
        let row = request()
        let client = ApprovalClient([row])
        await client.setFailure(true)
        let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
        await model.refresh(client: client)
        XCTAssertNotNil(model.error)
        await client.setFailure(false)
        await model.refresh(client: client)
        XCTAssertNil(model.error)
        model.setCompared(true, requestId: id)
        await client.setFailure(true)
        await model.decide(row, approve: true, client: client)
        XCTAssertNotNil(model.error)
        XCTAssertTrue(model.canApprove(row))
        XCTAssertEqual(model.requests, [row])
        await client.setFailure(false)
        await model.decide(row, approve: true, client: client)
        XCTAssertNil(model.error)
        XCTAssertTrue(model.requests.isEmpty)
    }

    func testStopFencesLateListAndDecisionSuccessOrFailureAndBusySubmissions() async {
        for decision in [false, true] {
            for failure in [false, true] {
                let row = request()
                let client = ApprovalClient([row])
                let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
                if decision {
                    await model.refresh(client: client)
                    model.setCompared(true, requestId: id)
                }
                await client.hold()
                let pending = Task {
                    if decision { await model.decide(row, approve: true, client: client) } else { await model.refresh(client: client) }
                }
                await client.waitUntilHeld()
                XCTAssertTrue(model.busy)
                XCTAssertFalse(model.canApprove(row))
                await model.refresh(client: client)
                await model.decide(row, approve: false, client: client)
                model.stop()
                await client.release(failure: failure)
                await pending.value
                XCTAssertFalse(model.busy)
                XCTAssertTrue(model.requests.isEmpty)
                XCTAssertNil(model.error)
            }
        }
    }

    private actor ApprovalClient: GatewayPairingApproving {
        private var rows: [GatewayPairingApprovalRequest]
        private var failure = false
        private var decisions: [Bool] = []
        private var shouldHold = false
        private var continuation: CheckedContinuation<Void, Never>?
        private var waiter: CheckedContinuation<Void, Never>?
        init(_ rows: [GatewayPairingApprovalRequest]) {
            self.rows = rows
        }

        func setRows(_ rows: [GatewayPairingApprovalRequest]) {
            self.rows = rows
        }

        func setFailure(_ failure: Bool) {
            self.failure = failure
        }

        func hold() {
            shouldHold = true
        }

        func decisionCount() -> Int {
            decisions.count
        }

        func lastDecision() -> Bool? {
            decisions.last
        }

        func waitUntilHeld() async {
            if continuation != nil { return }
            await withCheckedContinuation { waiter = $0 }
        }

        func release(failure: Bool) {
            self.failure = failure
            continuation?.resume()
            continuation = nil
        }

        private func gate() async throws {
            if shouldHold {
                await withCheckedContinuation {
                    continuation = $0
                    waiter?.resume()
                    waiter = nil
                }
            }
            if failure { throw URLError(.cannotConnectToHost) }
        }

        func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
            try await gate()
            return rows
        }

        func decidePairingApproval(requestId: String, approve: Bool) async throws {
            decisions.append(approve)
            try await gate()
        }
    }
}

@available(iOS 17.0, *)
@MainActor
final class GatewayPairingTrustSignInTests: XCTestCase {
    private func row(canTrust: Bool?) -> GatewayPairingApprovalRequest {
        GatewayPairingApprovalRequest(
            requestId: "00000000-0000-4000-8000-000000000961",
            kind: "ios",
            name: "Fictional phone",
            status: "pending",
            verificationCode: "465 774",
            expiresAt: 4_102_444_800_000,
            signIn: canTrust == nil ? nil : "google",
            canTrustSignIn: canTrust
        )
    }

    private actor Client: GatewayPairingApproving {
        let rows: [GatewayPairingApprovalRequest]
        var plain = 0
        var trusted = 0
        init(_ rows: [GatewayPairingApprovalRequest]) {
            self.rows = rows
        }

        func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
            rows
        }

        func decidePairingApproval(requestId: String, approve: Bool) async throws {
            plain += 1
        }

        func decidePairingApproval(requestId: String, approve: Bool, trustSignIn: Bool) async throws {
            trusted += 1
        }
    }

    func testTrustIsSentOnlyWhenChosenAndOffered() async {
        let offered = row(canTrust: true)
        let client = Client([offered])
        let model = GatewayPairingApprovalModel()
        await model.refresh(client: client)
        XCTAssertFalse(model.trustsSignIn(offered))
        model.setTrustSignIn(true, requestId: offered.id)
        XCTAssertTrue(model.trustsSignIn(offered))
        await model.confirmAndApprove(offered, client: client)
        let trusted = await client.trusted, plain = await client.plain
        XCTAssertEqual(trusted, 1)
        XCTAssertEqual(plain, 0)
    }

    func testARequestThatCannotBeTrustedIgnoresTheChoiceAndARejectionNeverTrusts() async {
        let unknown = row(canTrust: nil)
        let client = Client([unknown])
        let model = GatewayPairingApprovalModel()
        await model.refresh(client: client)
        model.setTrustSignIn(true, requestId: unknown.id)
        XCTAssertFalse(model.trustsSignIn(unknown))
        await model.confirmAndApprove(unknown, client: client)
        let plain = await client.plain
        XCTAssertEqual(plain, 1)

        let offered = row(canTrust: true)
        let second = Client([offered])
        let rejecting = GatewayPairingApprovalModel()
        await rejecting.refresh(client: second)
        rejecting.setTrustSignIn(true, requestId: offered.id)
        await rejecting.decide(offered, approve: false, client: second)
        let trusted = await second.trusted, rejected = await second.plain
        XCTAssertEqual(trusted, 0)
        XCTAssertEqual(rejected, 1)
    }

    func testTheNewFieldsDecodeFromTheGatewayRow() throws {
        let row = #"{"requestId":"00000000-0000-4000-8000-000000000961","kind":"ios","name":"Phone","status":"pending","#
            + #""verificationCode":"465 774","expiresAt":5,"signIn":"passkey","canTrustSignIn":false}"#
        let decoded = try JSONDecoder().decode(GatewayPairingApprovalRequest.self, from: Data(row.utf8))
        XCTAssertEqual(decoded.signIn, "passkey")
        XCTAssertEqual(decoded.canTrustSignIn, false)
    }
}
