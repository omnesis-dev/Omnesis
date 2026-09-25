// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// A 404 from the permission-health route means the gateway doesn't host the
/// source for this device. Refreshes that follow must not repeat the request.
@MainActor
final class PermissionHealthNotFoundTests: XCTestCase {
    private actor Attempts {
        private(set) var count = 0

        func add() {
            count += 1
        }
    }

    private let snapshot = PhotosPermissionHealth.report(
        access: .denied,
        backgroundRefresh: .available,
        checkedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )

    private func refresh(
        _ coordinator: PermissionHealthCoordinator,
        failingWith error: Error,
        attempts: Attempts
    ) async {
        let snapshot = snapshot
        await coordinator.refresh(
            evaluate: { [snapshot] },
            report: { _ in
                await attempts.add()
                throw error
            }
        )
    }

    func testASourceTheGatewayDoesNotHostIsReportedOncePerForeground() async {
        let coordinator = PermissionHealthCoordinator()
        let attempts = Attempts()

        for _ in 0 ..< 7 {
            await refresh(coordinator, failingWith: GatewayClient.Error.notFound, attempts: attempts)
        }
        let afterBurst = await attempts.count
        XCTAssertEqual(afterBurst, 1, "refreshes in a burst send one request")

        coordinator.allowReportingAgain()
        await refresh(coordinator, failingWith: GatewayClient.Error.notFound, attempts: attempts)
        let afterForeground = await attempts.count
        XCTAssertEqual(afterForeground, 2, "the next foreground tries once more")
    }

    func testRegisteringTheSourceLetsItReportAgain() async {
        let coordinator = PermissionHealthCoordinator()
        let attempts = Attempts()
        await refresh(coordinator, failingWith: GatewayClient.Error.notFound, attempts: attempts)

        coordinator.allowReportingAgain(for: snapshot.sourceId)
        await refresh(coordinator, failingWith: GatewayClient.Error.notFound, attempts: attempts)

        let count = await attempts.count
        XCTAssertEqual(count, 2)
    }

    func testOtherFailuresStillRetryOnTheNextRefresh() async {
        let coordinator = PermissionHealthCoordinator()
        let attempts = Attempts()
        let unavailable = GatewayClient.Error.serverError(status: 503, body: "")

        await refresh(coordinator, failingWith: unavailable, attempts: attempts)
        await refresh(coordinator, failingWith: unavailable, attempts: attempts)

        let count = await attempts.count
        XCTAssertEqual(count, 2)
    }
}
