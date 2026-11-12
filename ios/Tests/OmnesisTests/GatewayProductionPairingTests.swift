// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
@testable import Omnesis
import XCTest

@MainActor
final class GatewayProductionPairingTests: XCTestCase {
    func testDefaultKeyPairingAndMetadataCompositionUsesRealLocalTLSWithoutGoogleOrRelay() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop()
            OmnesisURLSession.reset()
        }
        let store = InMemoryStore()
        let service = PairingService(store: store, cloudRelayEnabled: true)
        let payload = PairingPayload.V4(
            gatewayUrl: "https://localhost:\(peer.info.targetPort)",
            pairingCode: "SYNTHETIC-CODE",
            tls: .pinnedKeyStrict(spkiFingerprint: peer.info.spkiFingerprint)
        )
        let raw = try XCTUnwrap(String(bytes: JSONEncoder().encode(payload), encoding: .utf8))
        let paired = try await service.pairAsync(raw: raw)
        XCTAssertEqual(paired.tlsMode, .pinnedKeyStrict)
        XCTAssertEqual(paired.spkiFingerprint, peer.info.spkiFingerprint)
        XCTAssertNil(paired.fingerprint)
        XCTAssertNil(paired.directRoute)
        XCTAssertNil(paired.directCandidates)
        XCTAssertEqual(paired.token, "device-test-token")
        XCTAssertEqual(paired.pairingGeneration, "00000000-0000-4000-8000-000000000902")
        XCTAssertEqual(try service.current(), paired)
        XCTAssertFalse(try service.upgradeTrustToSystem(verifiedHost: "localhost", pinnedFingerprint: peer.info.fingerprint))
    }

    func testConventionalExactLeafPairingStillWorksThroughBothDefaultBuildersWithoutGoogleOrRelay() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop()
            OmnesisURLSession.reset()
        }
        let url = "https://localhost:\(peer.info.targetPort)"
        let payloads: [(String, PairingTlsMode)] = try [
            (json(["v": 3, "gatewayUrl": url, "pairingCode": "SYNTHETIC", "fingerprint": peer.info.fingerprint]), .pinnedLeaf),
            (
                json([
                    "v": 4,
                    "gatewayUrl": url,
                    "pairingCode": "SYNTHETIC",
                    "tls": ["mode": "pinned-leaf-strict", "fingerprint": peer.info.fingerprint],
                ]),
                .pinnedLeafStrict
            ),
        ]
        for (raw, mode) in payloads {
            let service = PairingService(store: InMemoryStore(), cloudRelayEnabled: true)
            let paired = try await service.pairAsync(raw: raw)
            XCTAssertEqual(paired.tlsMode, mode)
            XCTAssertEqual(paired.fingerprint, peer.info.fingerprint)
            XCTAssertNil(paired.spkiFingerprint)
            XCTAssertNil(paired.directCandidates)
            XCTAssertEqual(try service.current(), paired)
        }
    }

    func testDefaultKeyBuilderCannotUseAValidLeafFingerprintToReplaceTheRequiredKeyPin() async throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop()
            OmnesisURLSession.reset()
        }
        let service = PairingService(store: InMemoryStore(), cloudRelayEnabled: true)
        let raw = try json([
            "v": 4,
            "gatewayUrl": "https://localhost:\(peer.info.targetPort)",
            "pairingCode": "SYNTHETIC",
            "tls": [
                "mode": "pinned-key-strict",
                "fingerprint": peer.info.fingerprint,
                "spkiFingerprint": String(repeating: "0", count: 64),
            ],
        ])
        do { _ = try await service.pairAsync(raw: raw)
            XCTFail("Key pin fell back to a different TLS authority")
        } catch { XCTAssertNil(try service.current()) }
    }

    private func json(_ value: [String: Any]) throws -> String {
        try XCTUnwrap(String(bytes: JSONSerialization.data(withJSONObject: value), encoding: .utf8))
    }
}
#endif
