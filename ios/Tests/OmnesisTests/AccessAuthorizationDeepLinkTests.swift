// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessAuthorizationDeepLinkTests: XCTestCase {
    func testParsesTheVersionedCodeOnlyPayload() throws {
        let url = try XCTUnwrap(URL(string: "omnesis://access-authorization?v=1&code=ABCD-EFGH"))

        XCTAssertEqual(AccessAuthorizationDeepLink(url: url)?.code, "ABCD-EFGH")
    }

    func testRejectsNonCanonicalCodesAndTheWrongAlphabet() throws {
        let values = [
            "omnesis://access-authorization?code=abcd-efgh&v=1",
            "omnesis://access-authorization?code=ABCDEFGH&v=1",
            "omnesis://access-authorization?code=%20ABCD-EFGH%20&v=1",
            "omnesis://access-authorization?code=ABCI-EF01&v=1",
        ]

        for value in values {
            let url = try XCTUnwrap(URL(string: value))
            XCTAssertNil(AccessAuthorizationDeepLink(url: url))
        }
    }

    func testRejectsAnotherRouteOrScheme() throws {
        let capture = try XCTUnwrap(URL(string: "omnesis://capture?surface=ios-control"))
        let web = try XCTUnwrap(URL(
            string: "https://access-authorization?v=1&code=ABCD-EFGH"
        ))
        let demo = try XCTUnwrap(URL(
            string: "omnesis-demo://access-authorization?v=1&code=ABCD-EFGH"
        ))

        XCTAssertNil(AccessAuthorizationDeepLink(url: capture))
        XCTAssertNil(AccessAuthorizationDeepLink(url: web))
        XCTAssertNil(AccessAuthorizationDeepLink(url: demo))
    }

    func testRejectsMissingDuplicateOrUnsupportedFields() throws {
        let values = [
            "omnesis://access-authorization?code=ABCD-EFGH",
            "omnesis://access-authorization?v=2&code=ABCD-EFGH",
            "omnesis://access-authorization?v=1",
            "omnesis://access-authorization?v=1&v=1&code=ABCD-EFGH",
            "omnesis://access-authorization?v=1&code=ABCD-EFGH&code=JKLM-NPQR",
        ]

        for value in values {
            let url = try XCTUnwrap(URL(string: value))
            XCTAssertNil(AccessAuthorizationDeepLink(url: url))
        }
    }

    func testRejectsGatewayOrAuthorityInjection() throws {
        let values = [
            "omnesis://access-authorization?v=1&code=ABCD-EFGH&gateway=https%3A%2F%2Fevil.example",
            "omnesis://access-authorization?v=1&code=ABCD-EFGH&token=secret",
            "omnesis://user@example.com/access-authorization?v=1&code=ABCD-EFGH",
            "omnesis://access-authorization:443?v=1&code=ABCD-EFGH",
            "omnesis://access-authorization/path?v=1&code=ABCD-EFGH",
            "omnesis://access-authorization?v=1&code=ABCD-EFGH#request-id",
        ]

        for value in values {
            let url = try XCTUnwrap(URL(string: value))
            XCTAssertNil(AccessAuthorizationDeepLink(url: url))
        }
    }
}

@MainActor
final class AccessAuthorizationDeepLinkRouterTests: XCTestCase {
    private let pairing = AccessAuthorizationPairingKey(
        gatewayURL: "https://gateway.example",
        deviceId: "device-example",
        generation: "generation-example"
    )

    func testBuffersAndConsumesAColdLaunchRequestOnce() {
        let router = AccessAuthorizationDeepLinkRouter()

        router.request(code: "ABCD-EFGH", pairingKey: pairing)

        XCTAssertEqual(router.requestCount, 1)
        XCTAssertEqual(router.consume(pairingKey: pairing), "ABCD-EFGH")
        XCTAssertNil(router.consume(pairingKey: pairing))
    }

    func testDropsARequestAfterThePhoneChangesPairing() {
        let router = AccessAuthorizationDeepLinkRouter()
        router.request(code: "ABCD-EFGH", pairingKey: pairing)
        let replacement = AccessAuthorizationPairingKey(
            gatewayURL: "https://another-gateway.example",
            deviceId: "another-device",
            generation: "another-generation"
        )

        XCTAssertNil(router.consume(pairingKey: replacement))
        XCTAssertNil(router.consume(pairingKey: pairing))
    }

    func testNewestRequestReplacesAnUnconsumedCode() {
        let router = AccessAuthorizationDeepLinkRouter()
        router.request(code: "ABCD-EFGH", pairingKey: pairing)
        router.request(code: "JKLM-NPQR", pairingKey: pairing)

        XCTAssertEqual(router.requestCount, 2)
        XCTAssertEqual(router.consume(pairingKey: pairing), "JKLM-NPQR")
    }
}
