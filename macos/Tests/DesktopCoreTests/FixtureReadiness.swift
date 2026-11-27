// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Test bootstrap allowance, separate from command/refusal/drain/cleanup deadlines.
enum FixtureReadiness {
    enum Budget {
        case postStart, rawOrphanBootstrap

        var duration: Duration {
            switch self {
            case .postStart: .seconds(5)
            // Excluded raw orphan protocol retains its existing twenty-second guard.
            case .rawOrphanBootstrap: .seconds(20)
            }
        }
    }

    /// Functional test policy aligned with owned native start's ninety-second envelope,
    /// not a cold-launch performance SLA. Capture before the first launch; never renew.
    static func bootstrapDeadline(now: ContinuousClock.Instant = .now) -> ContinuousClock.Instant {
        now.advanced(by: .seconds(90))
    }

    enum Failure: Error, Equatable { case expired, stopped }

    static func wait(
        budget: Budget = .postStart,
        until: ContinuousClock.Instant? = nil,
        now: () -> ContinuousClock.Instant = { .now },
        pause: () async throws -> Void = { try await Task.sleep(for: .milliseconds(10)) },
        isRunning: () -> Bool,
        isReady: () throws -> Bool,
        diagnose: (Failure) async throws -> Void
    ) async throws {
        let deadline = until ?? now().advanced(by: budget.duration)
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
