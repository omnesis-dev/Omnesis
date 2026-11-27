// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Test bootstrap allowance, separate from command/refusal/drain/cleanup deadlines.
enum FixtureReadiness {
    enum Budget {
        case postStart, nodeStartup, twoNodeBootstrap

        var duration: Duration {
            switch self {
            case .postStart: .seconds(5)
            // Cold activation of a freshly staged Node can precede protocol startup.
            // Match existing SDK initialization and positive snapshot startup allowances.
            case .nodeStartup: .seconds(10)
            case .twoNodeBootstrap: .seconds(20)
            }
        }
    }

    enum Failure: Error, Equatable { case expired, stopped }

    static func wait(
        budget: Budget = .postStart,
        now: () -> ContinuousClock.Instant = { .now },
        pause: () async throws -> Void = { try await Task.sleep(for: .milliseconds(10)) },
        isRunning: () -> Bool,
        isReady: () throws -> Bool,
        diagnose: (Failure) async throws -> Void
    ) async throws {
        let deadline = now().advanced(by: budget.duration)
        var failure = Failure.expired
        while now() < deadline {
            try Task.checkCancellation()
            guard isRunning() else { failure = .stopped
                break
            }
            if try isReady() {
                guard isRunning() else { failure = .stopped
                    break
                }
                // Even a slow observation cannot admit readiness after the deadline.
                if now() < deadline { return }
                break
            }
            try await pause()
        }
        // Failure is latched. Diagnostics may observe a late marker but cannot pass it.
        try await diagnose(failure)
        throw failure
    }
}
