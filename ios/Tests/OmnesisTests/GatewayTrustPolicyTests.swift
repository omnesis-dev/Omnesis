// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Only a DNS name can carry a publicly trusted certificate, so only a DNS
/// name lets a pinned pairing fall back to the system roots.
final class GatewayTrustPolicyTests: XCTestCase {
    func testDNSNamesQualify() {
        for host in ["gateway.example.com", "Gateway.Example.COM", "gateway.example.com.", "home.gateway.example.org"] {
            XCTAssertTrue(GatewayTrustPolicy.systemTrustQualifies(host: host), host)
        }
    }

    func testIPLiteralsNeverQualify() {
        for host in ["192.0.2.10", "127.0.0.1", "2001:db8::1", "[2001:db8::1]", "::1", "[::1]", "fe80::1%en0"] {
            XCTAssertFalse(GatewayTrustPolicy.systemTrustQualifies(host: host), host)
        }
    }

    func testLocalhostNamesNeverQualify() {
        for host in ["localhost", "LOCALHOST", "localhost.", "gateway.localhost", "app.gateway.localhost"] {
            XCTAssertFalse(GatewayTrustPolicy.systemTrustQualifies(host: host), host)
        }
    }

    func testMissingOrEmptyHostsNeverQualify() {
        XCTAssertFalse(GatewayTrustPolicy.systemTrustQualifies(host: nil))
        XCTAssertFalse(GatewayTrustPolicy.systemTrustQualifies(host: ""))
        XCTAssertFalse(GatewayTrustPolicy.systemTrustQualifies(host: "[]"))
        XCTAssertFalse(GatewayTrustPolicy.systemTrustQualifies(host: "."))
    }

    func testTheHostOfAStoredGatewayURLIsWhatIsJudged() throws {
        let dns = try XCTUnwrap(URL(string: "https://gateway.example.com:7600"))
        let ipv6 = try XCTUnwrap(URL(string: "https://[2001:db8::1]:7600"))
        XCTAssertTrue(GatewayTrustPolicy.systemTrustQualifies(host: dns.host))
        XCTAssertFalse(GatewayTrustPolicy.systemTrustQualifies(host: ipv6.host))
    }
}
