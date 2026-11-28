// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
@testable import OmnesisDesktop
import XCTest

private actor PowerProbeGate {
    private var requests: [CheckedContinuation<DesktopMacServerPowerObservation, Never>?] = []
    private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    var count: Int {
        requests.count
    }

    func probe() async -> DesktopMacServerPowerObservation {
        await withCheckedContinuation { continuation in
            requests.append(continuation)
            let complete = waiters.filter { $0.0 <= requests.count }
            waiters.removeAll { $0.0 <= requests.count }
            for (_, waiter) in complete {
                waiter.resume()
            }
        }
    }

    func waitForCount(_ count: Int) async {
        if requests.count >= count { return }
        await withCheckedContinuation { waiters.append((count, $0)) }
    }

    func finish(_ index: Int, _ status: DesktopMacServerPowerObservation.Status) {
        let continuation = requests[index]
        requests[index] = nil
        continuation?.resume(returning: DesktopMacServerPowerObservation(status: status))
    }
}

@MainActor
final class DesktopMacServerPowerFlowTests: XCTestCase {
    func testLeavingTheLibraryHostRoleStopsChecksAndReturningRequiresFreshEvidence() async {
        let gate = PowerProbeGate()
        let flow = DesktopMacServerPowerFlow(probe: { await gate.probe() })
        let first = Task { await flow.startMonitoring() }
        await gate.waitForCount(1)
        await gate.finish(0, .ready)
        await first.value
        flow.stopMonitoring()
        XCTAssertFalse(flow.ready)
        await flow.refresh()
        let stoppedCount = await gate.count
        XCTAssertEqual(stoppedCount, 1)
        let next = Task { await flow.startMonitoring() }
        await gate.waitForCount(2)
        XCTAssertFalse(flow.ready)
        await gate.finish(1, .sleepEnabled)
        await next.value
        XCTAssertEqual(flow.status, .sleepEnabled)
    }

    func testReturningAfterSleepPolicyChangesRemovesPreviouslyReadySetup() async {
        let gate = PowerProbeGate()
        let flow = DesktopMacServerPowerFlow(probe: { await gate.probe() })
        let first = Task { await flow.refresh() }
        await gate.waitForCount(1)
        await gate.finish(0, .ready)
        await first.value
        XCTAssertTrue(flow.ready)
        let next = Task { await flow.refresh() }
        await gate.waitForCount(2)
        XCTAssertFalse(flow.ready)
        await gate.finish(1, .sleepEnabled)
        await next.value
        XCTAssertEqual(flow.status, .sleepEnabled)
        XCTAssertFalse(flow.ready)
    }

    func testChecksCoalesceAndAnInvalidatedOldSuccessCannotCompleteNewSetup() async {
        let gate = PowerProbeGate()
        let flow = DesktopMacServerPowerFlow(probe: { await gate.probe() })
        let first = Task { await flow.refresh() }
        await gate.waitForCount(1)
        await flow.refresh()
        let count = await gate.count
        XCTAssertEqual(count, 1)
        first.cancel()
        flow.invalidate()
        let next = Task { await flow.refresh() }
        await next.value
        let stillOne = await gate.count
        XCTAssertEqual(stillOne, 1)
        XCTAssertFalse(flow.ready)
        await gate.finish(0, .ready)
        await gate.waitForCount(2)
        XCTAssertEqual(flow.status, .checking)
        XCTAssertFalse(flow.ready)
        await gate.finish(1, .unavailable)
        await first.value
        XCTAssertEqual(flow.status, .unavailable)
    }
}
