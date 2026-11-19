// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Waiting for your OK gathers every device waiting for the owner, whether it signed in with
/// the Omnesis account or reached the gateway through Tailscale. Each kind has its own
/// opt-in; with both off nothing is offered and the gateway is never asked.
@MainActor
final class DeviceApprovalsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private var nowMillis: Double {
        now.timeIntervalSince1970 * 1000
    }

    private func signedIn(_ suffix: Int) -> GatewayPairingApprovalRequest {
        GatewayPairingApprovalRequest(
            requestId: "00000000-0000-4000-8000-00000000000\(suffix)",
            kind: "ios",
            name: "Phone \(suffix)",
            status: "pending",
            verificationCode: "465 774",
            expiresAt: nowMillis + 600_000
        )
    }

    private func joining(_ id: String, expiresIn seconds: TimeInterval = 600) -> TailscaleJoinRequest {
        TailscaleJoinRequest(
            id: id,
            name: "studio-mac",
            kind: "collector",
            machine: "studio-mac",
            os: "macOS",
            login: "maya@example.com",
            requestedAt: now.addingTimeInterval(-60),
            expiresAt: now.addingTimeInterval(seconds)
        )
    }

    // MARK: - Which kinds this phone reviews

    func testEachKindFollowsItsOwnOptInAndNeedsTheAdminScope() {
        let admin = ["read", "admin"]
        XCTAssertEqual(DeviceApprovalKinds(cloudRelayEnabled: false, tailscaleEmbed: false, scopes: admin), .neither)
        XCTAssertFalse(DeviceApprovalKinds.neither.any)
        XCTAssertEqual(
            DeviceApprovalKinds(cloudRelayEnabled: true, tailscaleEmbed: false, scopes: admin),
            DeviceApprovalKinds(cloud: true, tailscale: false)
        )
        XCTAssertEqual(
            DeviceApprovalKinds(cloudRelayEnabled: false, tailscaleEmbed: true, scopes: admin),
            DeviceApprovalKinds(cloud: false, tailscale: true)
        )
        XCTAssertTrue(DeviceApprovalKinds(cloudRelayEnabled: true, tailscaleEmbed: true, scopes: admin).any)
        for scopes: [String]? in [nil, [], ["read"], ["read", "write:web"]] {
            XCTAssertEqual(DeviceApprovalKinds(cloudRelayEnabled: true, tailscaleEmbed: true, scopes: scopes), .neither, "\(scopes ?? [])")
        }
    }

    /// The gateway's status says whether it runs its own Tailscale device; a gateway without the
    /// opt-in omits the field, and an unreadable value reads as off.
    func testTheStatusFlagIsOffUnlessTheGatewaySaysSo() throws {
        func decode(_ extra: String) throws -> StatusSnapshot {
            let json = #"{"documents":{"total":0,"bySource":{}}"# + extra + "}"
            return try JSONDecoder().decode(StatusSnapshot.self, from: Data(json.utf8))
        }
        XCTAssertFalse(try decode("").tailscaleEmbed)
        XCTAssertFalse(try decode(#","tailscaleEmbed":false"#).tailscaleEmbed)
        XCTAssertFalse(try decode(#","tailscaleEmbed":"yes""#).tailscaleEmbed)
        XCTAssertTrue(try decode(#","tailscaleEmbed":true"#).tailscaleEmbed)
        let documents = StatusSnapshot.Documents(total: 0, bySource: [:], unitCountBySource: nil)
        XCTAssertFalse(StatusSnapshot(documents: documents, dbSizeBytes: nil, latestActivityBySource: nil).tailscaleEmbed)
    }

    // MARK: - The banner's reads

    /// Only the kinds this phone reviews are asked: with both opt-ins off the gateway hears
    /// nothing, and without the Tailscale kind its route is never read.
    func testOnlyTheOfferedKindsAreAsked() async {
        let gateway = RecordingGateway(signedIn: [signedIn(1)], joining: [joining("tsj-1")])
        let pending = PendingPairingRequests()

        await pending.refresh(kinds: .neither, client: gateway)
        XCTAssertEqual(gateway.reads, [])
        XCTAssertEqual(pending.requests, [])
        XCTAssertEqual(pending.tailscaleRequests, [])

        await pending.refresh(kinds: DeviceApprovalKinds(cloud: true, tailscale: false), client: gateway)
        XCTAssertEqual(gateway.reads, ["cloud"])
        XCTAssertEqual(pending.requests.count, 1)
        XCTAssertEqual(pending.tailscaleRequests, [])

        await pending.refresh(kinds: DeviceApprovalKinds(cloud: false, tailscale: true), client: gateway)
        XCTAssertEqual(gateway.reads, ["cloud", "tailscale"])
        XCTAssertEqual(pending.requests, [])
        XCTAssertEqual(pending.tailscaleRequests.map(\.id), ["tsj-1"])

        await pending.refresh(kinds: DeviceApprovalKinds(cloud: true, tailscale: true), client: nil)
        XCTAssertEqual(pending.requests, [])
        XCTAssertEqual(pending.tailscaleRequests, [])
    }

    func testOneReadListsBothKindsAndAFailureEmptiesOnlyItsOwn() async {
        let pending = PendingPairingRequests()
        await pending.refresh(cloud: SignedIn(rows: [signedIn(1)]), tailscale: ServedJoins(rows: [joining("tsj-1"), joining("tsj-2")]))
        XCTAssertEqual(pending.requests.count, 1)
        XCTAssertEqual(pending.tailscaleRequests.map(\.id), ["tsj-1", "tsj-2"])

        await pending.refresh(cloud: SignedIn(rows: [signedIn(1)]), tailscale: ServedJoins(rows: [], error: URLError(.timedOut)))
        XCTAssertEqual(pending.requests.count, 1)
        XCTAssertEqual(pending.tailscaleRequests, [])

        await pending.refresh(cloud: nil, tailscale: ServedJoins(rows: [], error: GatewayClient.Error.notFound))
        XCTAssertEqual(pending.tailscaleRequests, [], "A gateway without the list has nothing waiting")

        await pending.refresh(cloud: nil, tailscale: ServedJoins(rows: [joining("tsj-1")]))
        pending.clear()
        XCTAssertEqual(pending.tailscaleRequests, [])
    }

    /// One banner counts every device still waiting, however it asked; a run-out Tailscale
    /// request no longer counts.
    func testTheBannerCountsBothKinds() {
        let state = PairingRequestBannerState()
        XCTAssertEqual(state.offer(from: [], tailscale: [joining("tsj-1")], nowMillis: nowMillis), PairingRequestBannerOffer(count: 1))
        XCTAssertEqual(
            state.offer(from: [signedIn(1)], tailscale: [joining("tsj-1"), joining("tsj-2")], nowMillis: nowMillis),
            PairingRequestBannerOffer(count: 3)
        )
        XCTAssertNil(state.offer(from: [], tailscale: [joining("tsj-1", expiresIn: 0)], nowMillis: nowMillis))
        XCTAssertEqual(
            state.offer(from: [signedIn(1)], tailscale: [joining(signedIn(1).id)], nowMillis: nowMillis),
            PairingRequestBannerOffer(count: 2),
            "A request of each kind with the same id is two devices"
        )
    }

    /// Dismissing hides exactly the set waiting across both kinds; a new one of either brings it back.
    func testADismissalCoversBothKinds() {
        var state = PairingRequestBannerState()
        state.dismiss([signedIn(1)], tailscale: [joining("tsj-1")], nowMillis: nowMillis)
        XCTAssertNil(state.offer(from: [signedIn(1)], tailscale: [joining("tsj-1")], nowMillis: nowMillis))
        XCTAssertEqual(
            state.offer(from: [signedIn(1)], tailscale: [joining("tsj-1"), joining("tsj-2")], nowMillis: nowMillis),
            PairingRequestBannerOffer(count: 3)
        )
        XCTAssertEqual(state.offer(from: [signedIn(1)], tailscale: [], nowMillis: nowMillis), PairingRequestBannerOffer(count: 1))
    }

    // MARK: - Opening from a notification

    /// A `tailscale-join` tap opens the same Waiting for your OK as a sign-in request, saying
    /// it came from the Tailscale side; it is taken once.
    func testATailscaleJoinTapOpensTheSameListOnce() {
        let pending = PendingPairingRequests()
        pending.requestOpen(tailscale: true)
        XCTAssertEqual(pending.consumeOpen(), PairingRequestsOpen(tailscale: true))
        XCTAssertNil(pending.consumeOpen())
        XCTAssertNil(pending.focusedRequestId)
        pending.requestOpen(focus: signedIn(1).id)
        XCTAssertEqual(pending.consumeOpen(), PairingRequestsOpen(tailscale: false))
        XCTAssertEqual(pending.focusedRequestId, signedIn(1).id)
    }
}

private struct SignedIn: GatewayPairingApproving {
    let rows: [GatewayPairingApprovalRequest]
    func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
        rows
    }

    func decidePairingApproval(requestId _: String, approve _: Bool) async throws {}
}

/// One gateway serving both kinds, recording which list each read asked for.
private final class RecordingGateway: GatewayPairingApproving, TailscaleJoinDeciding, @unchecked Sendable {
    private let signedIn: [GatewayPairingApprovalRequest]
    private let joining: [TailscaleJoinRequest]
    private(set) var reads: [String] = []

    init(signedIn: [GatewayPairingApprovalRequest], joining: [TailscaleJoinRequest]) {
        self.signedIn = signedIn
        self.joining = joining
    }

    func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
        reads.append("cloud")
        return signedIn
    }

    func decidePairingApproval(requestId _: String, approve _: Bool) async throws {}

    func tailscaleJoinRequests() async throws -> [TailscaleJoinRequest] {
        reads.append("tailscale")
        return joining
    }

    func decideTailscaleJoin(requestId _: String, approve: Bool) async throws -> TailscaleJoinDecision {
        approve ? .approved : .denied
    }
}

private struct ServedJoins: TailscaleJoinDeciding {
    var rows: [TailscaleJoinRequest]
    var error: (any Error & Sendable)?

    func tailscaleJoinRequests() async throws -> [TailscaleJoinRequest] {
        if let error { throw error }
        return rows
    }

    func decideTailscaleJoin(requestId _: String, approve: Bool) async throws -> TailscaleJoinDecision {
        approve ? .approved : .denied
    }
}
