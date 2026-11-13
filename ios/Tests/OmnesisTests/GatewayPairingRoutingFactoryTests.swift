// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation
@testable import Omnesis
import Security
import XCTest

@MainActor
final class GatewayPairingRoutingFactoryTests: XCTestCase {
    func testAdminSocketFactoryKeepsTheNegotiatedKeyOrLeafAuthority() throws {
        let peer = try CloudPairingSOCKSPeer()
        defer { peer.stop() }
        let data = try XCTUnwrap(Data(base64Encoded: peer.info.certificateDER))
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, data as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(certificate, SecPolicyCreateBasicX509(), &trust), errSecSuccess)
        let served = try XCTUnwrap(trust)
        for mode in [PairingTlsMode.pinnedKeyStrict, .pinnedLeafStrict] {
            let pairing = try pairing(mode, leaf: peer.info.fingerprint, key: peer.info.spkiFingerprint)
            let owner = try XCTUnwrap(pairing.makeSocketRoutingSession())
            defer { owner.retireRouting() }
            XCTAssertEqual(owner.resolve(served, challengeHost: "gateway.example.test"), .pinned(systemTrusted: false))
            XCTAssertEqual(owner.resolve(served, challengeHost: "different.example.test"), .rejected)
            let bad = try self.pairing(mode, leaf: nil, key: String(repeating: "0", count: 64))
            let refusing = try XCTUnwrap(bad.makeSocketRoutingSession())
            defer { refusing.retireRouting() }
            XCTAssertEqual(refusing.resolve(served, challengeHost: "gateway.example.test"), .rejected)
        }
    }

    func testOrdinaryPairingsAndInvalidHintsDoNotAcquireAnAdminRoutingLease() throws {
        for mode in [PairingTlsMode.legacy, .system, .pinnedLeaf] {
            XCTAssertNil(try pairing(mode).directRoute)
            XCTAssertNil(try pairing(mode).makeSocketRoutingSession())
        }
        let leafWithoutHints = try pairing(.pinnedLeafStrict, hints: nil)
        XCTAssertNil(leafWithoutHints.directRoute)
        XCTAssertNil(leafWithoutHints.makeSocketRoutingSession())
        let emptyKey = try pairing(.pinnedKeyStrict, hints: nil)
        XCTAssertEqual(emptyKey.directRoute?.candidates, [])
        let invalid = try pairing(.pinnedKeyStrict, origin: "https://127.0.0.1")
        XCTAssertNil(invalid.directRoute)
        XCTAssertNil(invalid.makeSocketRoutingSession())
        let invalidFacts = try pairing(.pinnedLeafStrict, hints: [GatewayDirectCandidate(address: "203.0.113.8", port: 443)])
        XCTAssertNil(invalidFacts.directRoute)
    }

    private func pairing(
        _ mode: PairingTlsMode,
        leaf: String? = nil,
        key: String? = nil,
        origin: String = "https://gateway.example.test",
        hints: [GatewayDirectCandidate]? = [GatewayDirectCandidate(address: "10.0.0.2", port: 9443)]
    ) throws
        -> Pairing {
        try Pairing(
            url: XCTUnwrap(URL(string: origin)),
            token: "device-test-token",
            accountId: "local",
            deviceId: "device-test",
            gatewayName: "Test gateway",
            fingerprint: leaf,
            spkiFingerprint: key,
            directCandidates: hints,
            tlsMode: mode
        )
    }
}
#endif
