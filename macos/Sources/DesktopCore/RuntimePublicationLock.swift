// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// The caller validates/owns the descriptor and releases this lock in its critical-section defer.
public enum DesktopRuntimePublicationLock {
    public enum Mode: Sendable {
        case shared, exclusive
        fileprivate var flag: Int32 {
            self == .shared ? LOCK_SH : LOCK_EX
        }
    }

    public static func acquire(_ descriptor: Int32, mode: Mode = .exclusive, timeout: Duration = .seconds(120)) throws {
        try Task.checkCancellation()
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while flock(descriptor, mode.flag | LOCK_NB) != 0 {
            let failure = errno
            try Task.checkCancellation()
            guard [EWOULDBLOCK, EAGAIN, EINTR].contains(failure), clock.now < deadline else {
                throw DesktopRuntimeCache.Failure.lockUnavailable
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        do { try Task.checkCancellation() }
        catch { flock(descriptor, LOCK_UN)
            throw error
        }
    }
}
