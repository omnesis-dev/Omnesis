// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class GatewayHintPublicationTests: XCTestCase {
    private let key = String(repeating: "ab", count: 32)
    private let facts = [GatewayDirectCandidate(address: "10.0.0.2", port: 8443)]
    private func pairing(facts: [GatewayDirectCandidate]? = nil) -> Pairing {
        Pairing(
            url: URL(string: "https://gateway.example.test")!,
            token: "broad-device-token",
            pairingGeneration: "generation",
            accountId: "local",
            deviceId: "device",
            gatewayName: "Gateway",
            scopes: ["read", "admin"],
            spkiFingerprint: key,
            directCandidates: facts,
            tlsMode: .pinnedKeyStrict
        )
    }

    func testNarrowCredentialHintsPreserveItsOwnTokenAndRejectOtherAuthorities() throws {
        let store = InMemoryStore()
        let original = NotificationClaimCredentials.StoredCredential(
            url: pairing().url.absoluteString,
            token: "narrow-test-token",
            deviceId: "device",
            tlsMode: "pinned-key-strict",
            fingerprint: nil,
            spkiFingerprint: key
        )
        try NotificationClaimCredentials.commit(original, keychain: store)
        try NotificationClaimCredentialProvisioner.updateDirectCandidates(pairing: pairing(facts: facts), store: store)
        let updated = try XCTUnwrap(NotificationClaimCredentials.stored(keychain: store))
        XCTAssertEqual(updated.token, original.token)
        XCTAssertEqual(updated.directCandidates, facts)
        XCTAssertEqual(updated.url, original.url)
        XCTAssertEqual(updated.deviceId, original.deviceId)
        XCTAssertEqual(updated.spkiFingerprint, original.spkiFingerprint)
        try NotificationClaimCredentialProvisioner.updateDirectCandidates(pairing: pairing(facts: facts), store: store)
        XCTAssertEqual(try NotificationClaimCredentials.stored(keychain: store), updated)
        try NotificationClaimCredentialProvisioner.updateDirectCandidates(pairing: pairing(), store: store)
        XCTAssertEqual(try NotificationClaimCredentials.stored(keychain: store), original)
        let mismatches = [
            credential(url: "https://other.example.test"), credential(device: "other-device"), credential(mode: "system"),
            credential(fingerprint: key), credential(spki: String(repeating: "cd", count: 32)),
        ]
        for credential in mismatches {
            try NotificationClaimCredentials.commit(credential, keychain: store)
            try NotificationClaimCredentialProvisioner.updateDirectCandidates(pairing: pairing(facts: facts), store: store)
            XCTAssertEqual(try NotificationClaimCredentials.stored(keychain: store), credential)
        }
        try NotificationClaimCredentials.commit(original, keychain: store)
        XCTAssertThrowsError(try NotificationClaimCredentialProvisioner.updateDirectCandidates(
            pairing: pairing(facts: [.init(address: "8.8.8.8", port: 443)]), store: store
        ))
        XCTAssertEqual(try NotificationClaimCredentials.stored(keychain: store), original)
        let direct = Pairing(url: pairing().url, token: "direct-token", accountId: "local", deviceId: "device", gatewayName: "Direct")
        try NotificationClaimCredentialProvisioner.updateDirectCandidates(pairing: direct, store: store)
        XCTAssertEqual(try NotificationClaimCredentials.stored(keychain: store), original)
        try store.deleteAll()
        try NotificationClaimCredentialProvisioner.updateDirectCandidates(pairing: pairing(facts: facts), store: store)
        XCTAssertNil(try NotificationClaimCredentials.stored(keychain: store))
    }

    func testKeyPinnedNotificationMintAndHintRefreshNeverReplaceTheNarrowToken() async throws {
        let store = InMemoryStore()
        let original = pairing()
        let provisioner = NotificationClaimCredentialProvisioner(pairing: original, store: store) { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer broad-device-token")
            XCTAssertEqual(request.url?.path, "/admin/tokens")
            let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
            XCTAssertEqual(json["scopes"] as? [String], ["push:claim"])
            return try (
                Data(#"{"deviceId":"device","scopes":["push:claim"],"token":"narrow-test-token"}"#.utf8),
                XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil))
            )
        }
        try await provisioner.ensure()
        let refreshed = NotificationClaimCredentialProvisioner(pairing: pairing(facts: facts), store: store) { _ in
            XCTFail("Hint refresh reminted a token")
            throw NotificationClaimCredentialError.invalidResponse
        }
        try await refreshed.ensure()
        try await refreshed.ensure()
        let saved = try XCTUnwrap(NotificationClaimCredentials.stored(keychain: store))
        XCTAssertEqual(saved.token, "narrow-test-token")
        XCTAssertEqual(saved.spkiFingerprint, key)
        XCTAssertEqual(saved.directCandidates, facts)
        for invalid in [nil, "bad", String(repeating: "AB", count: 32), String(repeating: "ａ", count: 64)] {
            let pairing = Pairing(
                url: original.url,
                token: original.token,
                accountId: original.accountId,
                deviceId: original.deviceId,
                gatewayName: original.gatewayName,
                spkiFingerprint: invalid,
                tlsMode: .pinnedKeyStrict
            )
            do {
                try await NotificationClaimCredentialProvisioner(pairing: pairing, store: InMemoryStore()) { _ in
                    XCTFail("Invalid key released broad token")
                    throw NotificationClaimCredentialError.invalidResponse
                }.ensure()
                XCTFail("Invalid key accepted")
            } catch { XCTAssertEqual(error as? NotificationClaimCredentialError, .insecurePairing) }
        }
    }

    func testCachedHTTPLeaseUpdatesOnlyForItsCurrentAuthorityWithoutResettingUploads() throws {
        let store = InMemoryStore()
        let original = pairing()
        let bundle = PairingCredentialBundle(original, url: original.url, tlsMode: original.tlsMode, fingerprint: nil)
        try store.set(bundle.encoded(), forKey: PairingCredentialBundle.key)
        OmnesisURLSession._setStore(store)
        defer { OmnesisURLSession._setStore(nil)
            OmnesisURLSession.reset()
        }
        let session = OmnesisURLSession.shared
        XCTAssertTrue(session.delegate is PinnedSession)
        try store.set(bundle.replacingDirectCandidates(facts).encoded(), forKey: PairingCredentialBundle.key)
        try OmnesisURLSession.updateDirectCandidates(expected: original, candidates: facts)
        XCTAssertTrue(OmnesisURLSession.shared === session)
        XCTAssertThrowsError(try OmnesisURLSession.updateDirectCandidates(
            expected: original,
            candidates: [.init(address: "127.0.0.1", port: 443)]
        ))
        let replacement = Pairing(
            url: original.url,
            token: "new-token",
            pairingGeneration: "new-generation",
            accountId: original.accountId,
            deviceId: original.deviceId,
            gatewayName: original.gatewayName,
            spkiFingerprint: key,
            tlsMode: .pinnedKeyStrict
        )
        try store.set(
            PairingCredentialBundle(replacement, url: replacement.url, tlsMode: replacement.tlsMode, fingerprint: nil).encoded(),
            forKey: PairingCredentialBundle.key
        )
        // Invalid facts would throw if the obsolete cached authority were allowed to consume them.
        XCTAssertNoThrow(try OmnesisURLSession.updateDirectCandidates(
            expected: original,
            candidates: [.init(address: "8.8.8.8", port: 443)]
        ))
        OmnesisURLSession.reset()
        XCTAssertNoThrow(try OmnesisURLSession.updateDirectCandidates(expected: original, candidates: facts))
    }

    private func credential(
        url: String = "https://gateway.example.test",
        device: String = "device",
        mode: String = "pinned-key-strict",
        fingerprint: String? = nil,
        spki: String? = nil
    )
        -> NotificationClaimCredentials.StoredCredential {
        .init(url: url, token: "narrow-test-token", deviceId: device, tlsMode: mode, fingerprint: fingerprint, spkiFingerprint: spki ?? key)
    }
}
