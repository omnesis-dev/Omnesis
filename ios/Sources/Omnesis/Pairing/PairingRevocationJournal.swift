// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Durable FIFO of device credentials awaiting gateway revocation.
///
/// The journal survives clearing the active pairing. Entries are settled by
/// gateway, device, and pairing generation so an older network response cannot
/// erase a newly staged revocation for the same durable device.
final class PairingRevocationJournal: Sendable {
    private static let key = "gateway.pendingRevocation.v1"

    private let store: PairingStore

    init(store: PairingStore) {
        self.store = store
    }

    func enqueue(_ pairing: Pairing) throws {
        let credential = credential(for: pairing)
        var pending = try load()
        if !pending.contains(credential) { pending.append(credential) }
        try persist(pending)
    }

    func firstPending(excluding active: Pairing?) throws -> PairingCredentialBundle? {
        let activeCredential = active.map(credential(for:))
        return try load().first { $0 != activeCredential }
    }

    func settle(_ pairing: Pairing) throws {
        let credential = credential(for: pairing)
        var pending = try load()
        guard let index = pending.firstIndex(where: {
            $0.url == credential.url &&
                $0.deviceId == credential.deviceId &&
                $0.pairingGeneration == credential.pairingGeneration
        }) else { return }
        pending.remove(at: index)
        try persist(pending)
    }

    private func load() throws -> [PairingCredentialBundle] {
        guard let raw = try store.get(Self.key) else { return [] }
        if let data = raw.data(using: .utf8),
           let encoded = try? JSONDecoder().decode([String].self, from: data) {
            return encoded.compactMap { try? PairingCredentialBundle.decode($0) }
        }
        // Migration from the original single-entry journal.
        return (try? PairingCredentialBundle.decode(raw)).map { [$0] } ?? []
    }

    private func persist(_ pending: [PairingCredentialBundle]) throws {
        guard !pending.isEmpty else {
            try store.delete(Self.key)
            return
        }
        let encoded = try pending.map { try $0.encoded() }
        let data = try JSONEncoder().encode(encoded)
        guard let raw = String(data: data, encoding: .utf8) else {
            throw EncodingError.invalidValue(
                encoded,
                .init(codingPath: [], debugDescription: "Revocation outbox is not UTF-8")
            )
        }
        try store.set(raw, forKey: Self.key)
    }

    private func credential(for pairing: Pairing) -> PairingCredentialBundle {
        PairingCredentialBundle(
            url: pairing.url.absoluteString,
            token: pairing.token,
            pairingGeneration: pairing.pairingGeneration,
            accountId: pairing.accountId,
            deviceId: pairing.deviceId,
            name: pairing.gatewayName,
            scopes: pairing.scopes,
            tlsMode: pairing.tlsMode.rawValue,
            fingerprint: pairing.fingerprint
        )
    }
}
