// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
@testable import Omnesis
import XCTest

@MainActor
final class GatewayExtensionTransportTests: XCTestCase {
    func testNotificationFactoryUsesOwnedStrictTransportAndNeverReleasesTheBearerToAReplacementKey() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let url = "https://localhost:\(peer.info.targetPort)"
        let store = InMemoryStore()
        for mode in [PairingTlsMode.pinnedKeyStrict, .pinnedLeafStrict, .pinnedLeaf] {
            try NotificationClaimCredentials.commit(.init(
                url: url,
                token: "claim-test-token",
                deviceId: "device-test",
                tlsMode: mode.rawValue,
                fingerprint: peer.info.fingerprint,
                spkiFingerprint: peer.info.spkiFingerprint
            ), keychain: store)
            let client = try XCTUnwrap(NotificationClaimCredentials.load(store: store))
            let claimed = try await client.claim()
            XCTAssertNil(claimed)
            try await client.confirm(id: "notification-test")
        }
        let before = try requestCount(peer)
        try NotificationClaimCredentials.commit(.init(
            url: url,
            token: "claim-test-token",
            deviceId: "device-test",
            tlsMode: "pinned-key-strict",
            fingerprint: nil,
            spkiFingerprint: String(repeating: "0", count: 64)
        ), keychain: store)
        let wrongKey = try XCTUnwrap(NotificationClaimCredentials.load(store: store))
        do { _ = try await wrongKey.claim()
            XCTFail("Replacement key received a notification bearer")
        } catch {}
        XCTAssertEqual(try requestCount(peer), before)
    }

    func testNotificationFactoryRefusesMissingOrInvalidStrictCredentialAndPreservesOrdinarySystemTrust() throws {
        let store = InMemoryStore()
        XCTAssertNil(NotificationClaimCredentials.load(store: store))
        let pin = String(repeating: "a", count: 64)
        for mode in ["pinned-key-strict", "pinned-leaf-strict", "pinned-leaf"] {
            for invalid in [nil, "short", String(repeating: "z", count: 64)] as [String?] {
                try NotificationClaimCredentials.commit(.init(
                    url: "https://gateway.example.test",
                    token: "claim-test-token",
                    deviceId: "device-test",
                    tlsMode: mode,
                    fingerprint: invalid,
                    spkiFingerprint: invalid
                ), keychain: store)
                XCTAssertNil(NotificationClaimCredentials.load(store: store))
            }
        }
        for mode in ["system", "pinned-key-strict"] {
            try NotificationClaimCredentials.commit(.init(
                url: "http://gateway.example.test",
                token: "claim-test-token",
                deviceId: "device-test",
                tlsMode: mode,
                fingerprint: pin,
                spkiFingerprint: pin
            ), keychain: store)
            XCTAssertNil(NotificationClaimCredentials.load(store: store))
        }
        for mode in ["system", "pinned-key-strict", "pinned-leaf-strict"] {
            try NotificationClaimCredentials.commit(.init(
                url: "https://gateway.example.test",
                token: "claim-test-token",
                deviceId: "device-test",
                tlsMode: mode,
                fingerprint: pin,
                spkiFingerprint: pin,
                directCandidates: []
            ), keychain: store)
            XCTAssertNotNil(NotificationClaimCredentials.load(store: store))
        }
        try NotificationClaimCredentials.commit(.init(
            url: "https://gateway.example.test",
            token: "",
            deviceId: "device-test",
            tlsMode: "pinned-key-strict",
            fingerprint: nil,
            spkiFingerprint: pin
        ), keychain: store)
        XCTAssertNil(NotificationClaimCredentials.load(store: store))
    }

    func testWidgetProductionClientUsesTheNegotiatedKeyAndSameBearerAcrossItsRequests() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let url = try XCTUnwrap(URL(string: "https://localhost:\(peer.info.targetPort)"))
        for mode in ["pinned-key-strict", "pinned-leaf-strict", "pinned-leaf"] {
            let credential = TaskWidgetCredential(
                url: url,
                token: "widget-test-token",
                deviceId: "widget-device",
                tlsMode: mode,
                fingerprint: peer.info.fingerprint,
                spkiFingerprint: peer.info.spkiFingerprint
            )
            let client = TaskWidgetClient(credential: credential)
            let snapshot = try await client.fetch()
            XCTAssertTrue(snapshot.tasks.isEmpty)
            try await client.complete(id: "task-test")
        }
        let before = try requestCount(peer)
        let wrong = TaskWidgetClient(credential: .init(
            url: url,
            token: "widget-test-token",
            deviceId: "widget-device",
            tlsMode: "pinned-key-strict",
            spkiFingerprint: String(repeating: "0", count: 64)
        ))
        do { _ = try await wrong.fetch()
            XCTFail("Replacement key received a widget bearer")
        } catch {}
        XCTAssertEqual(try requestCount(peer), before)
    }

    func testWidgetMissingKeyCannotReleaseCredentialsThroughTheOrdinarySessionFallback() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let url = try XCTUnwrap(URL(string: "https://localhost:\(peer.info.targetPort)"))
        let before = try requestCount(peer)
        for mode in ["pinned-key-strict", "pinned-leaf-strict"] {
            let client = TaskWidgetClient(credential: .init(
                url: url,
                token: "widget-test-token",
                deviceId: "widget-device",
                tlsMode: mode
            ))
            do { _ = try await client.fetch()
                XCTFail("Missing negotiated pin released a widget bearer")
            } catch { XCTAssertEqual(error as? TaskWidgetClientError, .insecureCredential) }
        }
        let system = TaskWidgetClient(credential: .init(
            url: url,
            token: "widget-test-token",
            deviceId: "widget-device",
            tlsMode: "system"
        ))
        do { _ = try await system.fetch()
            XCTFail("Untrusted system TLS released a widget bearer")
        } catch {}
        XCTAssertEqual(try requestCount(peer), before)
    }

    func testNotificationProvisionerPreservesStrictTrustWhenMintingItsSeparateNarrowCredential() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let url = try XCTUnwrap(URL(string: "https://localhost:\(peer.info.targetPort)"))
        for mode in [PairingTlsMode.pinnedKeyStrict, .pinnedLeafStrict] {
            let key = mode == .pinnedKeyStrict ? peer.info.spkiFingerprint : nil
            let pin = PinnedSession(
                fingerprintHex: peer.info.fingerprint,
                spkiFingerprint: key,
                host: "localhost",
                requireCertificateValidity: true
            )
            let session = pin.session
            defer { session.invalidateAndCancel() }
            let pairing = Pairing(
                url: url,
                token: "device-test-token",
                accountId: "local",
                deviceId: "device-test",
                gatewayName: "Test gateway",
                fingerprint: peer.info.fingerprint,
                spkiFingerprint: key,
                tlsMode: mode
            )
            let store = InMemoryStore()
            try await NotificationClaimCredentialProvisioner(pairing: pairing, store: store, session: session).ensure()
            let stored = try XCTUnwrap(NotificationClaimCredentials.stored(keychain: store))
            XCTAssertEqual(stored.token, "claim-test-token")
            XCTAssertNotEqual(stored.token, pairing.token)
            XCTAssertEqual(stored.tlsMode, mode.rawValue)
            XCTAssertEqual(stored.spkiFingerprint, key)
        }
    }

    private func requestCount(_ peer: CloudPairingSOCKSPeer) throws -> Int {
        let data = try Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))
        return try XCTUnwrap(JSONDecoder().decode([String: Int].self, from: data)["requests"])
    }
}
#endif
