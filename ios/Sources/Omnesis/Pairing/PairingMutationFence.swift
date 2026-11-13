// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Network operations never hold this lock. Only the latest explicit pairing
/// operation may publish credentials; synchronous read-modify-write operations
/// share the same recursive lock so background trust updates cannot lose writes.
final class PairingMutationFence: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private var generation = UUID()

    func begin() -> UUID {
        serialized {
            generation = UUID()
            return generation
        }
    }

    func serialized<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    func replace<T>(_ body: () throws -> T) rethrows -> T {
        try serialized {
            generation = UUID()
            return try body()
        }
    }

    /// Unfenced, a redeemed code is always stored, whatever happened meanwhile.
    func commit<T>(_ operation: UUID, fenced: Bool = true, _ body: () throws -> T) throws -> T {
        try serialized {
            if fenced {
                try Task.checkCancellation()
                guard generation == operation else { throw CancellationError() }
            }
            return try body()
        }
    }
}
