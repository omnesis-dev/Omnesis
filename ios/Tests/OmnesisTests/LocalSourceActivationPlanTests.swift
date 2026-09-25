// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Rebuilding the collector waits for any sync already running, so switching a
/// source on must never include it: the page would wait on that sync.
@MainActor
final class LocalSourceActivationPlanTests: XCTestCase {
    @MainActor
    private final class CallLog {
        var calls: [String] = []
    }

    func testSwitchingASourceOnNeverWaitsForTheCollectorRebuild() async {
        let log = CallLog()
        let steps = LocalSourceActivationPlan.steps(
            authorize: {
                log.calls.append("authorize")
                return .granted(.full)
            },
            switchOn: { log.calls.append("switch-on") },
            rebuildCollector: { log.calls.append("rebuild") },
            afterRebuild: { log.calls.append("observers") }
        )

        await steps.activate()
        XCTAssertEqual(log.calls, ["switch-on"], "switching on is only the local switch")

        await steps.afterActivation()
        XCTAssertEqual(log.calls, ["switch-on", "rebuild", "observers"], "the rebuild comes first once the source is on")
    }
}
