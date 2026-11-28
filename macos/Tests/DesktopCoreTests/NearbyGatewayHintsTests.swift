// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import Foundation
import XCTest

final class NearbyGatewayHintsTests: XCTestCase {
    typealias Hints = DesktopNearbyGatewayHints

    func testOnlyNumericPrivateAddressesWithCanonicalEncoding() throws {
        for address in ["10.23.4.5", "172.16.1.2", "172.31.255.254", "192.168.42.3", "fd12::4", "fc00::8"] {
            let candidate = try Hints.Candidate(address: address, port: 443, remainingMs: 30000)
            let snapshot = try Hints.Snapshot(state: .ready, candidates: [candidate])
            XCTAssertEqual(try Hints.decode(JSONEncoder().encode(snapshot)), snapshot)
        }
        XCTAssertEqual(try Hints.Candidate(address: "FD12:0:0:0:0:0:0:4", port: 443, remainingMs: 1).address, "fd12::4")
        for address in [
            "127.0.0.1",
            "169.254.1.1",
            "172.32.1.1",
            "192.0.2.1",
            "8.8.8.8",
            "::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:10.1.2.3",
            "fd12::1%en0",
            "gateway.local.",
            "010.1.2.3", "10.23.4.5\0suffix", "fd12::4\0suffix",
        ] {
            XCTAssertThrowsError(
                try Hints.Candidate(address: address, port: 443, remainingMs: 1),
                "Must reject \(address.debugDescription)"
            )
        }
        for (port, ttl) in [(0, 1), (65536, 1), (443, -1), (443, 0), (443, 30001)] {
            XCTAssertThrowsError(try Hints.Candidate(address: "10.23.4.5", port: port, remainingMs: ttl))
        }
    }

    func testStrictWireRejectsExtraFieldsTypesDuplicatesAndUnsafeSequences() throws {
        let candidate: [String: Any] = ["address": "10.23.4.5", "port": 443, "remainingMs": 1000]
        let base: [String: Any] = ["format": 1, "generation": UUID().uuidString, "sequence": 0, "state": "ready", "candidates": [candidate]]
        func rejects(_ mutate: (inout [String: Any]) -> Void) throws {
            var object = base
            mutate(&object)
            XCTAssertThrowsError(try Hints.decode(JSONSerialization.data(withJSONObject: object)))
        }
        try rejects { $0["fingerprint"] = "untrusted" }
        try rejects { $0["format"] = 2 }
        try rejects { $0["format"] = true }
        try rejects { $0["sequence"] = -1 }
        try rejects { $0["sequence"] = 9_007_199_254_740_992 as Int64 }
        try rejects { $0["generation"] = "not-a-uuid" }
        try rejects { $0["state"] = "future" }
        try rejects { $0["candidates"] = [candidate, candidate] }
        try rejects { var extra = candidate
            extra["hostname"] = "gateway.local."
            $0["candidates"] = [extra]
        }
        try rejects { var extra = candidate
            extra["port"] = true
            $0["candidates"] = [extra]
        }
        for state in ["denied", "unavailable"] {
            try rejects { $0["state"] = state }
        }
        XCTAssertThrowsError(try Hints.decode(Data(repeating: 32, count: 4097)))
        XCTAssertThrowsError(try Hints.Snapshot(state: .ready, candidates: (1 ... 9).map {
            try Hints.Candidate(address: "10.23.4.\($0)", port: 443, remainingMs: 1000)
        }))
        XCTAssertEqual(Hints.Snapshot.unavailable.state, .unavailable)
        XCTAssertTrue(Hints.Snapshot.unavailable.candidates.isEmpty)
    }

    func testBonjourCompatibilityDoesNotPromoteFingerprintsOrResolveOutsideLocal() {
        func txt(_ fields: [String]) -> [UInt8] {
            fields.flatMap { [UInt8($0.utf8.count)] + Array($0.utf8) }
        }
        XCTAssertTrue(SystemNearbyGatewayDNS.acceptsService(type: "_omnesis._tcp.", domain: "local."))
        XCTAssertFalse(SystemNearbyGatewayDNS.acceptsService(type: "_other._tcp.", domain: "local."))
        XCTAssertFalse(SystemNearbyGatewayDNS.acceptsService(type: "_omnesis._tcp.", domain: "example.test."))
        XCTAssertTrue(SystemNearbyGatewayDNS.compatibleTXT(txt(["v=1", "scheme=https", "fp=not-trusted"])))
        for fields in [["v=2", "scheme=https"], ["v=1", "scheme=http"], ["scheme=https"], ["v=1", "v=1", "scheme=https"]] {
            XCTAssertFalse(SystemNearbyGatewayDNS.compatibleTXT(txt(fields)))
        }
        XCTAssertFalse(SystemNearbyGatewayDNS.compatibleTXT([6, 1]))
        XCTAssertFalse(SystemNearbyGatewayDNS.compatibleTXT(Array(repeating: 1, count: 1025)))
        for host in ["gateway.local.", "GATEWAY.LOCAL.", "one.two.local."] {
            XCTAssertTrue(DesktopNearbyGatewayBrowser.localHost(host))
        }
        for host in [
            "gateway.example.test.",
            "local.",
            "gateway.local",
            "a..local.",
            "a-.local.",
            "a_local.local.",
            "fd00::1",
            "gateway.local.%en0",
        ] {
            XCTAssertFalse(DesktopNearbyGatewayBrowser.localHost(host))
        }
    }
}
