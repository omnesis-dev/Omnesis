// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public protocol GatewayDirectHintRefreshing: Sendable {
    @discardableResult
    func refresh(apply: @escaping @Sendable ([GatewayDirectCandidate]) throws -> Void) async throws -> Bool
}

/// Always uses a fresh canonical key-pinned metadata channel, independently of
/// stale LAN addresses. Persistence and live updates share the pairing fence.
public struct GatewayPairedHintRefresher: GatewayDirectHintRefreshing {
    private let expected: Pairing
    private let service: PairingService
    private let discovery: any GatewayDirectDiscovering
    private let onUpdated: @MainActor @Sendable (Pairing) throws -> Void

    public init(
        expected: Pairing,
        service: PairingService,
        discovery: any GatewayDirectDiscovering = GatewayDirectDiscovery(),
        onUpdated: @escaping @MainActor @Sendable (Pairing) throws -> Void = { _ in }
    ) {
        self.expected = expected
        self.service = service
        self.discovery = discovery
        self.onUpdated = onUpdated
    }

    public func refresh(apply: @escaping @Sendable ([GatewayDirectCandidate]) throws -> Void) async throws -> Bool {
        guard expected.tlsMode == .pinnedKeyStrict, let key = expected.spkiFingerprint else { throw CloudPairingError.configuration }
        let candidates: [GatewayDirectCandidate]
        do { candidates = try await discovery.fetch(origin: expected.url, token: expected.token, spkiFingerprint: key) } catch {
            if GatewayDirectDiscovery.isTemporary(error) { return false }
            throw error
        }
        try Task.checkCancellation()
        return try await MainActor.run {
            try service.updateDirectCandidates(expected: expected, candidates: candidates) {
                try Task.checkCancellation()
                try apply(candidates)
                let normalized = candidates.isEmpty ? nil : candidates
                let current = Pairing(
                    url: expected.url,
                    token: expected.token,
                    pairingGeneration: expected.pairingGeneration,
                    accountId: expected.accountId,
                    deviceId: expected.deviceId,
                    gatewayName: expected.gatewayName,
                    scopes: expected.scopes,
                    fingerprint: expected.fingerprint,
                    spkiFingerprint: key,
                    directCandidates: normalized,
                    tlsMode: expected.tlsMode
                )
                try onUpdated(current)
            }
        }
    }
}
