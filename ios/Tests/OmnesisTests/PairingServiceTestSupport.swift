// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis

final class StubExchange: PairingExchangeHTTP, @unchecked Sendable {
    var lastGatewayUrl: URL?
    var lastPairingCode: String?
    var lastCapabilities: PairingCapabilities?
    var response: Result<DevicePairResponse, Error> = .failure(
        GatewayClient.Error.serverError(status: 500, body: "unstubbed")
    )

    func exchange(
        gatewayUrl: URL,
        pairingCode: String,
        capabilities: PairingCapabilities
    ) async throws
        -> DevicePairResponse {
        lastGatewayUrl = gatewayUrl
        lastPairingCode = pairingCode
        lastCapabilities = capabilities
        switch response {
        case .success(let response): return response
        case .failure(let error): throw error
        }
    }
}

final class InterruptingStore: PairingStore, @unchecked Sendable {
    enum Failure: Error { case interrupted }

    let base: InMemoryStore
    var failNextBundleWrite = false
    var deleteBundleBeforeFailure = false
    var failingDeleteKey: String?

    init(base: InMemoryStore) {
        self.base = base
    }

    func set(_ value: String, forKey key: String) throws {
        if key == PairingCredentialBundle.key, failNextBundleWrite {
            failNextBundleWrite = false
            if deleteBundleBeforeFailure { try base.delete(key) }
            throw Failure.interrupted
        }
        try base.set(value, forKey: key)
    }

    func get(_ key: String) throws -> String? {
        try base.get(key)
    }

    func getLegacySynchronizable(_ key: String) throws -> String? {
        try base.getLegacySynchronizable(key)
    }

    func hasLegacySynchronizableValues() throws -> Bool {
        try base.hasLegacySynchronizableValues()
    }

    func deleteLegacySynchronizableValues() throws {
        try base.deleteLegacySynchronizableValues()
    }

    func delete(_ key: String) throws {
        if key == failingDeleteKey { throw Failure.interrupted }
        try base.delete(key)
    }

    func deleteAll() throws {
        try base.deleteAll()
    }
}
