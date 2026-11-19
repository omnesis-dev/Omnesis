// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
@testable import Omnesis
import XCTest

@MainActor
final class GatewayStoredTrustContractTests: XCTestCase {
    func testMalformedKeyContractCannotUseTheLeafPinOrOrdinaryTrustInstead() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let url = try XCTUnwrap(URL(string: "https://localhost:\(peer.info.targetPort)/probe"))
        let invalid: [(String?, String?)] = [
            (nil, peer.info.spkiFingerprint), ("", peer.info.spkiFingerprint),
            ("localhost", nil), ("localhost", "short"), ("localhost", String(repeating: "z", count: 64)),
        ]
        for (host, key) in invalid {
            let session = OmnesisURLSession.resolveSession(
                tlsMode: "pinned-key-strict",
                fingerprint: peer.info.fingerprint,
                host: host,
                spkiFingerprint: key
            )
            defer { session.invalidateAndCancel() }
            XCTAssertTrue(session.delegate is RejectingTrustSession)
            var request = URLRequest(url: url)
            request.setValue("Bearer contract-test-token", forHTTPHeaderField: "Authorization")
            do { _ = try await session.data(for: request)
                XCTFail("Malformed key contract released an application request")
            } catch { XCTAssertTrue(error is URLError) }
        }
        XCTAssertEqual(try requestCount(peer), 0)
    }

    func testCorruptStrictURLBundleRejectsTheRequestBeforeAnyCredentialIsReleased() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop()
            OmnesisURLSession._setStore(nil)
            OmnesisURLSession.reset()
        }
        let target = try XCTUnwrap(URL(string: "https://localhost:\(peer.info.targetPort)/probe"))
        for origin in ["http://gateway.example.test", "https:/missing-host"] {
            let store = InMemoryStore()
            let bundle = PairingCredentialBundle(
                url: origin,
                token: "contract-test-token",
                accountId: "local",
                deviceId: "device-test",
                name: "Test gateway",
                scopes: ["read"],
                tlsMode: "pinned-key-strict",
                fingerprint: nil,
                spkiFingerprint: peer.info.spkiFingerprint
            )
            try store.set(bundle.encoded(), forKey: PairingCredentialBundle.key)
            OmnesisURLSession._setStore(store)
            let session = OmnesisURLSession.shared
            var request = URLRequest(url: target)
            request.setValue("Bearer contract-test-token", forHTTPHeaderField: "Authorization")
            do { _ = try await session.data(for: request)
                XCTFail("Corrupt strict URL became live authority")
            } catch { XCTAssertTrue(error is URLError) }
            session.invalidateAndCancel()
        }
        XCTAssertEqual(try requestCount(peer), 0)
    }

    func testSplitLegacyItemsCannotBeReinterpretedAsAStableKeyPairing() throws {
        let store = InMemoryStore()
        for (key, value) in [
            "gateway.url": "https://gateway.example.test",
            "gateway.token": "contract-test-token",
            "gateway.accountId": "local",
            "gateway.deviceId": "device-test",
            "gateway.name": "Test gateway",
            "gateway.tlsMode": "pinned-key-strict",
            "gateway.fingerprint": String(repeating: "a", count: 64),
        ] {
            try store.set(value, forKey: key)
        }
        XCTAssertNil(try PairingService(store: store).current())
        XCTAssertNil(try store.get(PairingCredentialBundle.key))
    }

    func testAuthenticatedMetadataRefusalCannotCommitTheNewDeviceCredential() async throws {
        let peer = try CloudPairingSOCKSPeer(refuseDirectDiscovery: true)
        defer { peer.stop()
            OmnesisURLSession.reset()
        }
        let origin = "https://localhost:\(peer.info.targetPort)"
        let store = InMemoryStore()
        let service = PairingService(store: store)
        let previous = try service.pair(raw: """
        {"v":1,"url":"\(origin)","token":"old-device-token","accountId":"old-device","name":"Test gateway"}
        """)
        let before = try store.get(PairingCredentialBundle.key)
        let payload = PairingPayload.V4(
            gatewayUrl: origin,
            pairingCode: "SYNTHETIC-CODE",
            tls: .pinnedKeyStrict(spkiFingerprint: peer.info.spkiFingerprint)
        )
        let raw = try XCTUnwrap(String(data: JSONEncoder().encode(payload), encoding: .utf8))
        do { _ = try await service.pairAsync(raw: raw)
            XCTFail("Refused metadata committed a new authority")
        } catch { XCTAssertFalse(GatewayDirectDiscovery.isTemporary(error)) }
        XCTAssertEqual(try service.current(), previous)
        XCTAssertEqual(try store.get(PairingCredentialBundle.key), before)
        XCTAssertEqual(try requestCount(peer), 2)
    }

    func testStrictLeafBundleWithExplicitEmptyFactsKeepsItsExactHTTPSAuthority() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop()
            OmnesisURLSession._setStore(nil)
            OmnesisURLSession.reset()
        }
        let origin = "https://localhost:\(peer.info.targetPort)"
        let store = InMemoryStore()
        let bundle = PairingCredentialBundle(
            url: origin,
            token: "contract-test-token",
            accountId: "local",
            deviceId: "device-test",
            name: "Test gateway",
            scopes: ["read"],
            tlsMode: "pinned-leaf-strict",
            fingerprint: peer.info.fingerprint,
            directCandidates: []
        )
        try store.set(bundle.encoded(), forKey: PairingCredentialBundle.key)
        OmnesisURLSession._setStore(store)
        let session = OmnesisURLSession.shared
        defer { session.invalidateAndCancel() }
        var request = try URLRequest(url: XCTUnwrap(URL(string: origin + "/probe")))
        request.setValue("Bearer contract-test-token", forHTTPHeaderField: "Authorization")
        let (data, _) = try await session.data(for: request)
        let reply = try JSONDecoder().decode([String: String].self, from: data)
        XCTAssertEqual(reply["authorization"], "Bearer contract-test-token")
        XCTAssertEqual(try requestCount(peer), 1)
    }

    private func requestCount(_ peer: CloudPairingSOCKSPeer) throws -> Int {
        let data = try Data(contentsOf: URL(fileURLWithPath: peer.info.statsPath))
        return try XCTUnwrap(JSONDecoder().decode([String: Int].self, from: data)["requests"])
    }
}
#endif
