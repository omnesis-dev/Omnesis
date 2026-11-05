// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class GatewayDirectRouteTests: XCTestCase {
    private let origin = URL(string: "https://gateway.example.test")!
    private let candidate = GatewayDirectCandidate(address: "192.168.1.20", port: 7600)

    func testEmptyHintsKeepTheOrdinaryTransportAndValidRoutesPreserveCanonicalIdentity() throws {
        XCTAssertNil(try GatewayDirectRoute(origin: origin, candidates: []))
        let route = try XCTUnwrap(GatewayDirectRoute(origin: origin, candidates: [candidate]))
        XCTAssertEqual(route.origin, origin)
        XCTAssertEqual(route.host, "gateway.example.test")
        XCTAssertEqual(route.port, 443)
        XCTAssertEqual(route.candidates, [candidate])
        XCTAssertEqual(try JSONDecoder().decode(GatewayDirectCandidate.self, from: JSONEncoder().encode(candidate)), candidate)
        XCTAssertEqual(
            try GatewayDirectRoute(origin: XCTUnwrap(URL(string: "https://GATEWAY.example.test:7443/")), candidates: [candidate])?.port,
            7443
        )
    }

    func testOnlyPrivateLiteralEndpointsCanBeHints() {
        for address in ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.20", "fc00::1", "FD12::abc"] {
            XCTAssertTrue(GatewayDirectRoute.privateAddress(address), address)
        }
        for address in [
            "127.0.0.1",
            "192.169.1.1",
            "172.15.1.1",
            "172.32.1.1",
            "169.254.169.254",
            "8.8.8.8",
            "0.0.0.0",
            "::",
            "::1",
            "fe80::1",
            "2001:db8::1",
            "::ffff:192.168.1.20",
            "fd00::1%en0",
            "gateway.local",
            "192.168.1",
            "192..1.1",
            "192.168.1.256",
            "192.168.01.1",
            "192.168.+1.1",
        ] {
            XCTAssertFalse(GatewayDirectRoute.privateAddress(address), address)
        }
        XCTAssertTrue(GatewayDirectRoute.privateAddress("127.0.0.1", allowLoopbackForTesting: true))
    }

    func testMaintainedEmptyRoutesRetainOnlyTheValidatedCanonicalIdentity() throws {
        let route = try GatewayDirectRoute.maintained(origin: origin, candidates: [])
        XCTAssertEqual(route.origin, origin)
        XCTAssertEqual(route.host, "gateway.example.test")
        XCTAssertEqual(route.port, 443)
        XCTAssertTrue(route.candidates.isEmpty)
        XCTAssertNil(try GatewayDirectRoute(origin: origin, candidates: []), "Ordinary empty-route behavior remains unchanged")
        let ordinary = try XCTUnwrap(GatewayDirectRoute(origin: origin, candidates: [candidate]))
        XCTAssertEqual(try GatewayDirectRoute.maintained(origin: origin, candidates: [candidate]), ordinary)
        XCTAssertThrowsError(try GatewayDirectRoute.maintained(
            origin: XCTUnwrap(URL(string: "http://gateway.example.test")),
            candidates: []
        ))
        XCTAssertThrowsError(try GatewayDirectRoute.maintained(origin: XCTUnwrap(URL(string: "https://127.0.0.1")), candidates: []))
        XCTAssertThrowsError(try GatewayDirectRoute.maintained(origin: origin, candidates: [
            GatewayDirectCandidate(address: "127.0.0.1", port: 443),
        ]))
        XCTAssertThrowsError(try GatewayDirectRoute.maintained(origin: origin, candidates: [candidate, candidate]))
    }

    func testMalformedOriginsAndCandidateCollectionsCannotOverrideTrustOrScanPublicHosts() {
        for address in [
            "http://gateway.example.test",
            "https://user@gateway.example.test",
            "https://user:pass@gateway.example.test",
            "https://gateway.example.test/path",
            "https://gateway.example.test/?q=1",
            "https://gateway.example.test/#f",
            "https:/path",
            "https://127.0.0.1",
            "https://[::1]",
            "https://localhost",
            "https://gateway..test",
            "https://-gateway.example.test",
            "https://gateway-.example.test",
            "https://gateway_example.test",
            "https://" + String(repeating: "a", count: 64) + ".test",
            "https://gateway.example.test:0",
            "https://gateway.example.test:65536",
            "https://" + Array(repeating: String(repeating: "a", count: 60), count: 5).joined(separator: "."),
        ] {
            if let url = URL(string: address) {
                XCTAssertThrowsError(try GatewayDirectRoute(origin: url, candidates: [candidate]), address)
            }
        }
        for candidates in [
            [candidate, candidate],
            [GatewayDirectCandidate(address: "8.8.8.8", port: 443)],
            [GatewayDirectCandidate(address: "10.0.0.1", port: 0)],
            [GatewayDirectCandidate(
                address: "10.0.0.1",
                port: 65536
            )],
            (1 ... 9).map { GatewayDirectCandidate(address: "10.0.0.\($0)", port: 443) },
        ] {
            XCTAssertThrowsError(try GatewayDirectRoute(origin: origin, candidates: candidates))
        }
    }
}
