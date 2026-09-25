// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The home banner for waiting access requests: which request it opens,
/// when a dismissal keeps it hidden, and how a request opened from it
/// explains itself when it has stopped waiting.
final class AccessPendingRequestBannerTests: XCTestCase {
    private let now: Int64 = 1_800_000_000_000

    private func request(_ id: String, createdAt: Int64, expiresAt: Int64? = nil) -> AccessPendingRequest {
        AccessPendingRequest(
            id: id,
            clientName: "Client \(id)",
            createdAt: createdAt,
            expiresAt: expiresAt ?? now + 600_000
        )
    }

    func testNothingWaitingOffersNothing() {
        XCTAssertNil(AccessPendingRequestBannerState().offer(from: [], nowMillis: now))
    }

    /// The banner opens the request created last, whatever order the list
    /// arrived in, and counts every request still waiting.
    func testTheOfferNamesTheNewestRequestAndCountsTheRest() {
        let older = request("older", createdAt: now - 300_000)
        let newest = request("newest", createdAt: now - 60000)
        let offer = AccessPendingRequestBannerState().offer(from: [older, newest], nowMillis: now)
        XCTAssertEqual(offer, AccessPendingRequestBannerOffer(newest: newest, count: 2))
        XCTAssertEqual(offer?.detail, "Client newest and 1 more")
        XCTAssertEqual(AccessPendingRequestBannerOffer.actionTitle, "Configure & Approve")
        XCTAssertEqual(
            AccessPendingRequestBannerState().offer(from: [newest], nowMillis: now)?.detail,
            "Client newest"
        )
    }

    /// Two requests created in the same millisecond keep the gateway's
    /// order, which lists the newest first.
    func testATieKeepsTheGatewayOrder() {
        let first = request("first", createdAt: now)
        let second = request("second", createdAt: now)
        XCTAssertEqual(accessNewestPendingRequest([first, second])?.id, "first")
    }

    /// A request that ran out since the list was read is not offered, and
    /// does not count.
    func testAnExpiredRequestIsNeitherOfferedNorCounted() {
        let expired = request("expired", createdAt: now - 60000, expiresAt: now)
        let live = request("live", createdAt: now - 120_000)
        let offer = AccessPendingRequestBannerState().offer(from: [expired, live], nowMillis: now)
        XCTAssertEqual(offer, AccessPendingRequestBannerOffer(newest: live, count: 1))
        XCTAssertNil(AccessPendingRequestBannerState().offer(from: [expired], nowMillis: now))
    }

    /// Dismissing hides exactly the set that was waiting. A request arriving
    /// or leaving is a different set, and the banner comes back for it.
    func testDismissHidesTheBannerUntilTheWaitingSetChanges() {
        let first = request("first", createdAt: now - 120_000)
        let second = request("second", createdAt: now - 60000)
        var state = AccessPendingRequestBannerState()
        state.dismiss([first], nowMillis: now)
        XCTAssertNil(state.offer(from: [first], nowMillis: now))

        // A newer request arrives beside the dismissed one.
        XCTAssertEqual(state.offer(from: [first, second], nowMillis: now)?.newest, second)
        state.dismiss([first, second], nowMillis: now)
        XCTAssertNil(state.offer(from: [second, first], nowMillis: now))

        // The dismissed pair shrinks to one: a different set, offered again.
        XCTAssertEqual(state.offer(from: [second], nowMillis: now)?.newest, second)
        // The same pair the owner dismissed, once one of them has run out.
        let firstExpired = request("first", createdAt: now - 120_000, expiresAt: now)
        XCTAssertEqual(state.offer(from: [firstExpired, second], nowMillis: now)?.count, 1)
    }

    /// A dismissal records only what was still waiting, so a request that had
    /// already run out cannot make the live set look different later.
    func testDismissRecordsOnlyTheLiveSet() {
        let expired = request("expired", createdAt: now - 60000, expiresAt: now)
        let live = request("live", createdAt: now - 120_000)
        var state = AccessPendingRequestBannerState()
        state.dismiss([expired, live], nowMillis: now)
        XCTAssertNil(state.offer(from: [live], nowMillis: now))
    }

    /// A request opened from the banner that the gateway no longer lists is
    /// explained as having stopped waiting, and is not retried.
    func testARequestNoLongerPendingIsExplainedAndTerminal() {
        let error = AccessAuthorizationLocalError.noLongerPending
        XCTAssertEqual(
            accessAuthorizationLookupMessage(error),
            "This request is no longer waiting for a decision."
        )
        XCTAssertEqual(accessAuthorizationErrorCode(error), "no-longer-pending")
        XCTAssertTrue(accessAuthorizationIsTerminalError(error))
    }

    /// A gateway that no longer lists an id answers 404. Read by id, that is
    /// the request having stopped waiting; read by a typed code, the same
    /// answer still means the code matched nothing.
    func testANotFoundByIdIsTheRequestNoLongerWaiting() {
        let byId = accessAuthorizationLookupFailure(GatewayClient.Error.notFound, key: .id("request-gone"))
        XCTAssertEqual(
            accessAuthorizationLookupMessage(byId),
            "This request is no longer waiting for a decision."
        )
        XCTAssertTrue(accessAuthorizationIsTerminalError(byId))

        let byCode = accessAuthorizationLookupFailure(GatewayClient.Error.notFound, key: .code("ABCD-EFGH"))
        XCTAssertEqual(
            accessAuthorizationLookupMessage(byCode),
            "No pending authorization matches that code."
        )
    }

    /// Every other failure of a read by id keeps its own meaning: a server
    /// fault still carries its status, and a phone that is offline is still
    /// told so rather than that the request is gone.
    func testOtherLookupFailuresByIdPassThroughUnchanged() {
        let fault = accessAuthorizationLookupFailure(
            GatewayClient.Error.serverError(status: 500, body: ""),
            key: .id("request-example")
        )
        guard case GatewayClient.Error.serverError(let status, _) = fault else {
            return XCTFail("Expected the server fault to pass through, got \(fault)")
        }
        XCTAssertEqual(status, 500)
        XCTAssertFalse(accessAuthorizationIsTerminalError(fault))

        let offline = accessAuthorizationLookupFailure(
            URLError(.notConnectedToInternet),
            key: .id("request-example")
        )
        XCTAssertEqual((offline as? URLError)?.code, .notConnectedToInternet)
        XCTAssertEqual(
            accessAuthorizationLookupMessage(offline),
            "This phone is offline. Reconnect and try again."
        )
    }
}
