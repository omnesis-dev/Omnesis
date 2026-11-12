// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Which gateway holds this install's device key, and when its token last changed.
/// Written only after a sign-in enrollment, so a QR pairing never has one and never rotates.
struct DeviceEnrollmentRecord: Codable, Equatable {
    static let key = "device.enrollment.record.v1"
    let origin: String
    let spkiFingerprint: String
    var rotatedAt: TimeInterval
    var attemptedAt: TimeInterval?

    static func begin(
        origin: URL,
        spkiFingerprint: String,
        store: any PairingStore = DeviceEnrollmentKey.sharedStore(),
        now: TimeInterval = Date().timeIntervalSince1970
    ) {
        Self(origin: origin.absoluteString, spkiFingerprint: spkiFingerprint, rotatedAt: now).save(store)
    }

    static func load(_ store: any PairingStore) -> Self? {
        guard let raw = try? store.get(key) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: Data(raw.utf8))
    }

    func save(_ store: any PairingStore) {
        guard let data = try? JSONEncoder().encode(self), let raw = String(data: data, encoding: .utf8) else { return }
        try? store.set(raw, forKey: Self.key)
    }
}

/// Opportunistic: every failure, including a gateway without these routes, leaves the current token in use.
struct DeviceTokenRotator: Sendable {
    static let interval: TimeInterval = 30 * 24 * 60 * 60
    static let retryInterval: TimeInterval = 24 * 60 * 60

    var enabled = CloudRelayFeature.enabled
    var store: any PairingStore = DeviceEnrollmentKey.sharedStore()
    var deviceKey: @Sendable () throws -> any DeviceEnrollmentSigning = { try DeviceEnrollmentKey.loadOrCreate() }
    var makeTransport: @Sendable (_ spkiFingerprint: String, _ host: String) -> any CloudPairingTransport = { spki, host in
        CloudPairingHTTP(spkiFingerprint: spki, canonicalHost: host)
    }

    let replaceToken: @Sendable (_ token: String, _ tokenId: String?) throws -> Bool
    var now: @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }

    /// True once the new token is stored in place of the old one.
    func rotateIfDue(pairing: Pairing) async -> Bool {
        guard enabled, pairing.tlsMode == .pinnedKeyStrict, let spki = pairing.spkiFingerprint, let host = pairing.url.host,
              var record = DeviceEnrollmentRecord.load(store), record.origin == pairing.url.absoluteString,
              record.spkiFingerprint == spki, isDue(record) else { return false }
        record.attemptedAt = now()
        record.save(store)
        let transport = makeTransport(spki, host)
        defer { transport.close() }
        do {
            let next = try await rotate(pairing: pairing, spkiFingerprint: spki, transport: transport)
            guard try replaceToken(next.token, next.tokenId) else { return false }
            record.rotatedAt = now()
            record.save(store)
            return true
        } catch {
            return false
        }
    }

    private func isDue(_ record: DeviceEnrollmentRecord) -> Bool {
        now() - record.rotatedAt >= Self.interval && now() - (record.attemptedAt ?? 0) >= Self.retryInterval
    }

    private struct NextToken: Decodable {
        let token: String
        let tokenId: String?
    }

    private func rotate(pairing: Pairing, spkiFingerprint: String, transport: any CloudPairingTransport) async throws -> NextToken {
        struct Issued: Decodable { let challenge: String }
        struct Rotate: Encodable { let challenge: String
            let signature: String
        }
        let key = try deviceKey()
        let issued = try await JSONDecoder().decode(Issued.self, from: transport.requestData(
            url: pairing.url.appendingPathComponent("devices/token/challenge"),
            method: "POST",
            body: Data("{}".utf8),
            bearer: pairing.token,
            form: false
        ))
        let transcript = try DeviceEnrollmentContract.tokenRotationTranscript(
            deviceId: pairing.deviceId,
            gatewaySpkiFingerprint: spkiFingerprint,
            challenge: issued.challenge,
            devicePublicKey: key.publicKey
        )
        let next = try await JSONDecoder().decode(NextToken.self, from: transport.requestData(
            url: pairing.url.appendingPathComponent("devices/token/rotate"),
            method: "POST",
            body: JSONEncoder().encode(Rotate(challenge: issued.challenge, signature: key.sign(transcript))),
            bearer: pairing.token,
            form: false
        ))
        guard !next.token.isEmpty, next.token.utf8.count <= 4096 else { throw CloudPairingError.response }
        return next
    }
}

extension PairingService {
    /// One Keychain write, as with every other change to the bundle. Refuses if the
    /// pairing changed while the rotation was in flight.
    func replaceToken(expected: Pairing, token: String, tokenId: String?) throws -> Bool {
        try mutations.serialized {
            guard let current = try current(), current.sameAuthority(as: expected),
                  let raw = try store.get(PairingCredentialBundle.key) else { return false }
            let bundle = try PairingCredentialBundle.decode(raw)
            try commit(PairingCredentialBundle(
                url: bundle.url,
                token: token,
                pairingGeneration: tokenId ?? bundle.pairingGeneration,
                accountId: bundle.accountId,
                deviceId: bundle.deviceId,
                name: bundle.name,
                scopes: bundle.scopes,
                tlsMode: bundle.tlsMode,
                fingerprint: bundle.fingerprint,
                spkiFingerprint: bundle.spkiFingerprint,
                directCandidates: bundle.directCandidates
            ))
            return true
        }
    }
}

#if canImport(UIKit)
@available(iOS 17.0, *)
extension AppStore {
    public func onActiveThenRotateDeviceToken() async {
        await onActive()
        await rotateDeviceTokenIfDue()
    }

    /// Off the cloud build flag this returns before touching the Keychain.
    func rotateDeviceTokenIfDue() async {
        guard CloudRelayFeature.enabled, let pairing else { return }
        let service = pairingCoord.service
        let rotator = DeviceTokenRotator(replaceToken: { token, tokenId in
            try service.replaceToken(expected: pairing, token: token, tokenId: tokenId)
        })
        if await rotator.rotateIfDue(pairing: pairing) { reload() }
    }
}
#endif
