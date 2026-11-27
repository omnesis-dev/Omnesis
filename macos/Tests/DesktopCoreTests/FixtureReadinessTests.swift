// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import XCTest

final class FixtureReadinessTests: XCTestCase {
    /// A per-test, single-task clock: no global clock or real wall-clock sleeps.
    private final class Scenario {
        let origin = ContinuousClock.now
        var elapsed = Duration.zero
        var ready = false
        var running = true
        var pauses = 0
        var diagnosed: [FixtureReadiness.Failure] = []

        var now: ContinuousClock.Instant {
            origin.advanced(by: elapsed)
        }
    }

    func testActivationAllowanceDoesNotExtendCommandBudget() async throws {
        let startup = Scenario()
        try await FixtureReadiness.wait(
            budget: .nodeStartup,
            now: { startup.now },
            pause: {
                startup.elapsed = .seconds(6)
                startup.ready = true
                startup.pauses += 1
                await Task.yield()
            },
            isRunning: { startup.running }, isReady: { startup.ready },
            diagnose: { startup.diagnosed.append($0) }
        )
        XCTAssertEqual(startup.pauses, 1)
        XCTAssertTrue(startup.diagnosed.isEmpty)

        let command = Scenario()
        do {
            try await FixtureReadiness.wait(
                now: { command.now },
                pause: {
                    command.elapsed = .seconds(6)
                    command.ready = true
                    command.pauses += 1
                    await Task.yield()
                },
                isRunning: { command.running }, isReady: { command.ready },
                diagnose: { command.diagnosed.append($0) }
            )
            XCTFail("An already-running command cannot borrow the Node startup allowance")
        } catch { XCTAssertEqual(error as? FixtureReadiness.Failure, .expired) }
        XCTAssertTrue(command.ready)
        XCTAssertEqual(command.diagnosed, [.expired])
    }

    func testTimeoutDiagnosticsCannotTurnLateReadinessIntoSuccess() async throws {
        let state = Scenario()
        do {
            try await FixtureReadiness.wait(
                budget: .nodeStartup,
                now: { state.now },
                pause: { state.elapsed = .seconds(10)
                    await Task.yield()
                },
                isRunning: { state.running }, isReady: { state.ready },
                diagnose: { reason in
                    state.diagnosed.append(reason)
                    state.ready = true
                    await Task.yield()
                }
            )
            XCTFail("A diagnostic callback cannot clear the original timeout")
        } catch { XCTAssertEqual(error as? FixtureReadiness.Failure, .expired) }
        XCTAssertTrue(state.ready)
        XCTAssertEqual(state.diagnosed, [.expired])
    }

    func testTwoNodeBootstrapExpiresAtOneFixedDeadlineDespiteProgress() async throws {
        let state = Scenario()
        var firstNodeInitialized = false
        do {
            try await FixtureReadiness.wait(
                budget: .twoNodeBootstrap,
                now: { state.now },
                pause: {
                    state.elapsed += .seconds(5)
                    state.pauses += 1
                    firstNodeInitialized = true
                    if state.elapsed == .seconds(20) { state.ready = true }
                    await Task.yield()
                },
                isRunning: { state.running }, isReady: { state.ready },
                diagnose: { state.diagnosed.append($0) }
            )
            XCTFail("Progress and readiness at the deadline cannot renew a bootstrap")
        } catch { XCTAssertEqual(error as? FixtureReadiness.Failure, .expired) }
        XCTAssertTrue(firstNodeInitialized)
        XCTAssertTrue(state.ready)
        XCTAssertEqual(state.pauses, 4)
        XCTAssertEqual(state.diagnosed, [.expired])
    }

    func testStoppedFixtureCannotClaimCachedReadiness() async throws {
        let state = Scenario()
        state.running = false
        state.ready = true
        do {
            try await FixtureReadiness.wait(
                budget: .nodeStartup, now: { state.now },
                pause: { state.pauses += 1 },
                isRunning: { state.running }, isReady: { state.ready },
                diagnose: { state.diagnosed.append($0) }
            )
            XCTFail("A stopped fixture cannot claim a cached ready marker")
        } catch { XCTAssertEqual(error as? FixtureReadiness.Failure, .stopped) }
        XCTAssertEqual(state.pauses, 0)
        XCTAssertEqual(state.diagnosed, [.stopped])

        let stopsDuringObservation = Scenario()
        do {
            try await FixtureReadiness.wait(
                budget: .nodeStartup, now: { stopsDuringObservation.now },
                pause: { stopsDuringObservation.pauses += 1 },
                isRunning: { stopsDuringObservation.running },
                isReady: {
                    stopsDuringObservation.running = false
                    return true
                },
                diagnose: { stopsDuringObservation.diagnosed.append($0) }
            )
            XCTFail("A fixture stopping during readiness observation cannot be accepted")
        } catch { XCTAssertEqual(error as? FixtureReadiness.Failure, .stopped) }
        XCTAssertEqual(stopsDuringObservation.pauses, 0)
        XCTAssertEqual(stopsDuringObservation.diagnosed, [.stopped])
    }
}
