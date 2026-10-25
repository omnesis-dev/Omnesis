// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Content-free counters distinguish hardware delivery, conversion, and sender readiness.
final class RealtimeCaptureDiagnostics: @unchecked Sendable {
    struct Snapshot {
        var inputBuffers = 0
        var inputFrames = 0
        var convertedPackets = 0
        var sentPackets = 0
        var emptyConversions = 0
        var conversionFailures = 0
        var discardedPackets = 0
        var configurationChanges = 0
        var restarts = 0
        var conversionStatus = "not-run"

        var summary: String {
            "inputBuffers=\(inputBuffers) inputFrames=\(inputFrames) packets=\(convertedPackets) " +
                "sent=\(sentPackets) empty=\(emptyConversions) failures=\(conversionFailures) dropped=\(discardedPackets) " +
                "changes=\(configurationChanges) restarts=\(restarts) conversion=\(conversionStatus)"
        }
    }

    struct InputStamp {
        let isFirst: Bool
        fileprivate let epoch: UUID
    }

    private let lock = NSLock()
    private var epoch = UUID()
    private var counters = Snapshot()

    var snapshot: Snapshot {
        lock.withLock { counters }
    }

    func input(frames: Int) -> InputStamp {
        lock.withLock {
            counters.inputBuffers += 1
            counters.inputFrames += frames
            return InputStamp(isFirst: counters.inputBuffers == 1, epoch: epoch)
        }
    }

    func advanceEpoch() {
        lock.withLock { epoch = UUID() }
    }

    func isCurrent(_ stamp: InputStamp) -> Bool {
        lock.withLock { stamp.epoch == epoch }
    }

    func converted(hasData: Bool, status: String) {
        lock.withLock {
            counters.conversionStatus = status
            if hasData { counters.convertedPackets += 1 } else { counters.emptyConversions += 1 }
        }
    }

    func failedConversion() {
        lock.withLock { counters.conversionFailures += 1 }
    }

    func sent() {
        lock.withLock { counters.sentPackets += 1 }
    }

    func discarded() {
        lock.withLock { counters.discardedPackets += 1 }
    }

    func configurationChanged() {
        lock.withLock { counters.configurationChanges += 1 }
    }

    func restarted() {
        lock.withLock { counters.restarts += 1 }
    }
}
