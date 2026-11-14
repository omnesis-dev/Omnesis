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
        XCTAssertEqual(PairingRequestBannerOffer(count: 1).text, "A new device is waiting for your OK.")
        XCTAssertEqual(PairingRequestBannerOffer(count: 3).text, "3 new devices are waiting for your OK.")
        XCTAssertEqual(PairingRequestBannerOffer.actionTitle, "Review")
        XCTAssertEqual(PairingApprovalPresentation.headline("Maya's MacBook"), "Maya's MacBook wants to connect")
        XCTAssertEqual(PairingApprovalPresentation.question(kind: "ios"), "Does the iPhone show this code?")
        XCTAssertEqual(PairingApprovalPresentation.question(kind: "portal"), "Does the browser show this code?")
        XCTAssertEqual(PairingApprovalPresentation.question(kind: "cli"), "Does the computer show this code?")
        XCTAssertEqual(PairingApprovalPresentation.remember(signIn: "google"), "Remember this Google account")
        XCTAssertEqual(PairingApprovalPresentation.remember(signIn: "passkey"), "Remember this passkey")
        XCTAssertEqual(PairingApprovalPresentation.approve, "Yes, approve")
        XCTAssertEqual(PairingApprovalPresentation.deny, "No, deny")
        XCTAssertEqual(PairingApprovalPresentation.title, "Waiting for your OK")
        let screens = [
            PairingRequestBannerOffer(count: 2).text, PairingApprovalPresentation.waitingDevice, PairingApprovalPresentation.title,
            PairingApprovalPresentation.empty, PairingApprovalPresentation.revoked, PairingApprovalPresentation.rememberDetail,
            PairingWaitingPresentation.fromAnotherDevice, PairingWaitingPresentation.withFaceID, PairingWaitingPresentation.compare,
        ] + PairingWaitingPresentation.places
        for text in screens {
            XCTAssertFalse(text.contains("—"), text)
            // The review's vocabulary: no mechanism words on these screens.
            for word in ["trusted device", "held", "relay", "pairing request", "other device"] {
                XCTAssertFalse(text.lowercased().contains(word), "\(word) in \(text)")
            }
        }
    }

    /// The waiting screen counts down in minutes and seconds, and says so when time is up.
    func testTheWaitingScreenCountsDown() {
        XCTAssertEqual(PairingWaitingPresentation.expiry(remaining: 272.9), "Expires in 4:32")
        XCTAssertEqual(PairingWaitingPresentation.expiry(remaining: 61), "Expires in 1:01")
        XCTAssertEqual(PairingWaitingPresentation.expiry(remaining: 9), "Expires in 0:09")
        XCTAssertEqual(PairingWaitingPresentation.expiry(remaining: 0.4), "Expired. Cancel and sign in again.")
        XCTAssertEqual(PairingWaitingPresentation.expiry(remaining: -30), "Expired. Cancel and sign in again.")
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
        XCTAssertEqual(PushTarget.fromUserInfo(payload, cloudRelayEnabled: true), .pairingRequests(requestId: nil))
        XCTAssertTrue(PushTarget.pairingRequests().opensDevices)
        XCTAssertNil(PushTarget.fromUserInfo(payload, cloudRelayEnabled: false))
    }
}
