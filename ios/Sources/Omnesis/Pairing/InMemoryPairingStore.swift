// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// In-memory `PairingStore` used exclusively by tests.
public final class InMemoryStore: PairingStore, @unchecked Sendable {
    private var values: [String: String] = [:]
    private var legacySynchronizableValues: [String: String] = [:]
    private let lock = NSLock()

    public init() {}

    public func set(_ value: String, forKey key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        values[key] = value
    }

    public func get(_ key: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[key]
    }

    public func getLegacySynchronizable(_ key: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return legacySynchronizableValues[key]
    }

    public func hasLegacySynchronizableValues() throws -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !legacySynchronizableValues.isEmpty
    }

    public func deleteLegacySynchronizableValues() throws {
        lock.lock()
        defer { lock.unlock() }
        legacySynchronizableValues.removeAll()
    }

    public func delete(_ key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        values.removeValue(forKey: key)
    }

    public func deleteAll() throws {
        lock.lock()
        defer { lock.unlock() }
        values.removeAll()
        legacySynchronizableValues.removeAll()
    }

    /// Test-only seam for recreating records written by older releases.
    public func setLegacySynchronizable(_ value: String, forKey key: String) {
        lock.lock()
        defer { lock.unlock() }
        legacySynchronizableValues[key] = value
    }
}
