// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The home banner for devices that signed in and wait for approval: what it says, when it
/// shows, who asks the gateway, and how a notification tap opens Pairing requests once.
@MainActor
final class PendingPairingRequestsTests: XCTestCase {
    private let now: Double = 1_800_000_000_000

    private func request(_ suffix: Int, status: String = "pending", expiresAt: Double? = nil) -> GatewayPairingApprovalRequest {
        GatewayPairingApprovalRequest(
            requestId: "00000000-0000-4000-8000-00000000000\(suffix)",
            kind: "ios",
            name: "Phone \(suffix)",
            status: status,
            verificationCode: "465 774",
            expiresAt: expiresAt ?? now + 600_000
        )
    }

    private struct Client: GatewayPairingApproving {
        let rows: [GatewayPairingApprovalRequest]
        var fails = false
        func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
            if fails { throw URLError(.timedOut) }
            return rows
        }

        func decidePairingApproval(requestId _: String, approve _: Bool) async throws {}
    }

    func testTheWordsMatchTheOtherApps() {
        XCTAssertEqual(
            PairingRequestBannerOffer(count: 1).text,
            "A device is waiting for your approval to pair to this gateway."
        )
        XCTAssertEqual(
            PairingRequestBannerOffer(count: 3).text,
            "3 devices are waiting for your approval to pair to this gateway."
        )
        XCTAssertEqual(PairingRequestBannerOffer.actionTitle, "Review")
        XCTAssertEqual(
            PairingApprovalPresentation.explanation,
            "A device signed in to your Omnesis account and is waiting for your approval to pair to this gateway. "
                + "Approve if the code below matches the code shown on the device."
        )
        XCTAssertEqual(PairingApprovalPresentation.approve, "Approve")
        XCTAssertEqual(PairingApprovalPresentation.deny, "Deny")
        XCTAssertEqual(PairingApprovalPresentation.title, "Pairing requests")
        for text in [PairingRequestBannerOffer(count: 2).text, PairingApprovalPresentation.explanation] {
            XCTAssertFalse(text.contains("—"), text)
        }
    }

    /// Leaving the account is "unlink" on the button, the confirmation and while it runs.
    func testLeavingTheAccountIsCalledUnlinking() {
        XCTAssertEqual(CloudRelayPresentation.unlink, "Unlink this gateway")
        XCTAssertEqual(CloudRelayPresentation.unlinkTitle, "Unlink this gateway from your Omnesis account?")
        XCTAssertEqual(CloudRelayPresentation.unlinkConfirm, "Unlink")
        XCTAssertEqual(CloudRelayPresentation.unlinking, "Unlinking…")
        XCTAssertTrue(CloudRelayPresentation.unlinkMessage.hasPrefix("This gateway leaves your Omnesis account."))
    }

    func testNothingWaitingOffersNothing() {
        XCTAssertNil(PairingRequestBannerState().offer(from: [], nowMillis: now))
    }

    /// One row however many wait, and only requests that can still be decided count.
    func testOneBannerCountsWhatIsStillWaiting() {
        let expired = request(1, expiresAt: now)
        let decided = request(2, status: "approved")
        let state = PairingRequestBannerState()
        XCTAssertEqual(state.offer(from: [request(3)], nowMillis: now), PairingRequestBannerOffer(count: 1))
        XCTAssertEqual(
            state.offer(from: [expired, decided, request(3), request(4)], nowMillis: now),
            PairingRequestBannerOffer(count: 2)
        )
        XCTAssertNil(state.offer(from: [expired, decided], nowMillis: now))
    }

    /// Dismissing hides exactly the set that was waiting; a new request brings the banner back.
    func testADismissalLastsUntilTheWaitingSetChanges() {
        var state = PairingRequestBannerState()
        state.dismiss([request(1)], nowMillis: now)
        XCTAssertNil(state.offer(from: [request(1)], nowMillis: now))
        XCTAssertEqual(state.offer(from: [request(1), request(2)], nowMillis: now), PairingRequestBannerOffer(count: 2))
        XCTAssertEqual(state.offer(from: [request(2)], nowMillis: now), PairingRequestBannerOffer(count: 1))
        XCTAssertNil(state.offer(from: [], nowMillis: now))
    }

    func testOnlyAnAdministratorInACloudBuildAsks() {
        XCTAssertTrue(PendingPairingRequests.eligible(cloudRelayEnabled: true, scopes: ["read", "admin"]))
        XCTAssertFalse(PendingPairingRequests.eligible(cloudRelayEnabled: true, scopes: ["read"]))
        XCTAssertFalse(PendingPairingRequests.eligible(cloudRelayEnabled: true, scopes: nil))
        XCTAssertFalse(PendingPairingRequests.eligible(cloudRelayEnabled: false, scopes: ["read", "admin"]))
    }

    /// The banner disappears when none are pending, when a read fails and when there is no gateway to ask.
    func testAReadReplacesTheListAndAFailureEmptiesIt() async {
        let pending = PendingPairingRequests()
        await pending.refresh(client: Client(rows: [request(1), request(2)]))
        XCTAssertEqual(pending.requests.count, 2)
        await pending.refresh(client: Client(rows: []))
        XCTAssertEqual(pending.requests, [])
        await pending.refresh(client: Client(rows: [request(1)]))
        await pending.refresh(client: Client(rows: [], fails: true))
        XCTAssertEqual(pending.requests, [])
        await pending.refresh(client: Client(rows: [request(1)]))
        await pending.refresh(client: nil)
        XCTAssertEqual(pending.requests, [])
        await pending.refresh(client: Client(rows: [request(1)]))
        pending.clear()
        XCTAssertEqual(pending.requests, [])
    }

    /// A tap opens Pairing requests once; Devices appearing again later does not reopen it.
    func testARequestToOpenIsUsedOnce() {
        let pending = PendingPairingRequests()
        XCTAssertFalse(pending.consumeOpen())
        pending.requestOpen()
        XCTAssertTrue(pending.consumeOpen())
        XCTAssertFalse(pending.consumeOpen())
        pending.requestOpen()
        pending.clear()
        XCTAssertFalse(pending.consumeOpen(), "An unpaired phone forgets a request it never showed")
        let before = pending.refreshRequests
        pending.requestRefresh()
        XCTAssertNotEqual(pending.refreshRequests, before)
    }

    /// A pairing request notification, tapped, asks for the Pairing requests list.
    func testThePairingNotificationRoutesToPairingRequests() {
        let payload: [AnyHashable: Any] = ["omnesis": ["kind": "device-pairing", "targetId": "pairing"]]
        XCTAssertEqual(PushTarget.fromUserInfo(payload, cloudRelayEnabled: true), .pairingRequests)
        XCTAssertTrue(PushTarget.pairingRequests.opensDevices)
        XCTAssertNil(PushTarget.fromUserInfo(payload, cloudRelayEnabled: false))
    }
}
