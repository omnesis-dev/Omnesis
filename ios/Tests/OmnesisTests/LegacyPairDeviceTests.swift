// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The pair sheet of a build with the cloud build flag off (`LegacyPairDeviceView`): it lists
/// the gateway's network identities and swaps the chosen host into the gateway's origin.
final class LegacyPairDeviceTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var responder: ((URLRequest) -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            guard let responder else {
                throw GatewayClient.Error.invalidResponse
            }
            return responder(request)
        }
    }

    private let base = URL(string: "http://mac.local:7600")!

    private func makeResponse(status: Int, body: String, url: URL) -> (Data, URLResponse) {
        let data = Data(body.utf8)
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (data, response)
    }

    private let identities = """
    {"items":[
      {"address":"192.0.2.42","label":"LAN","kind":"lan","offLan":false},
      {"address":"198.51.100.7","label":"Tailscale","kind":"tailscale","offLan":true}
    ],
     "pageInfo":{"hasMore":false,"limit":2}}
    """

    func testListNetworkIdentitiesDecodesPageItems() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 200, body: self!.identities, url: req.url!)
        }
        let client = AdminClient(baseURL: base, token: "omn_t", session: session)
        let identities = try await client.listNetworkIdentities()
        XCTAssertEqual(identities.count, 2)
        XCTAssertEqual(identities[0].address, "192.0.2.42")
        XCTAssertEqual(identities[1].offLan, true)
        XCTAssertEqual(session.requests[0].url?.absoluteString, "http://mac.local:7600/admin/network-identities")
    }

    /// The sheet's requests in order: the identities when it opens, then the QR for the
    /// chosen identity's host in the gateway's own origin. It never asks for an address plan.
    func testThePickedIdentityIsSwappedIntoTheQrGatewayUrl() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            let body = req.url?.path == "/admin/network-identities" ? self!.identities : #"{"qrPayload":"payload"}"#
            return self!.makeResponse(status: 200, body: body, url: req.url!)
        }
        let origin = try XCTUnwrap(URL(string: "https://mac.local:17600"))
        let client = AdminClient(baseURL: origin, token: "omn_t", session: session)
        let picked = try await client.listNetworkIdentities()[1]
        let payload = try await client.buildPairQr(pairingCode: "7K3M-9QX2", gatewayUrl: swapHost(into: origin, host: picked.address))

        XCTAssertEqual(payload, "payload")
        XCTAssertEqual(session.requests.map(\.httpMethod), ["GET", "POST"])
        XCTAssertEqual(session.requests.map { $0.url?.path }, ["/admin/network-identities", "/admin/devices/pair-qr"])
        let sent = try JSONSerialization.jsonObject(with: session.requests[1].httpBody ?? Data()) as? [String: Any]
        XCTAssertEqual(sent?["gatewayUrl"] as? String, "https://198.51.100.7:17600")
        XCTAssertEqual(sent?["pairingCode"] as? String, "7K3M-9QX2")
    }

    func testSwapHostPreservesSchemeAndPort() throws {
        // The portal swaps only the host, keeping the gateway's real scheme/port.
        XCTAssertEqual(
            try swapHost(into: XCTUnwrap(URL(string: "https://mac.local:7600")), host: "198.51.100.7"),
            "https://198.51.100.7:7600"
        )
        // Non-default port is preserved (the bug this guards against was a
        // hardcoded :7600).
        XCTAssertEqual(
            try swapHost(into: XCTUnwrap(URL(string: "https://mac.local:17600")), host: "192.0.2.42"),
            "https://192.0.2.42:17600"
        )
        // Plain HTTP origin keeps its scheme (no port → none added).
        XCTAssertEqual(
            try swapHost(into: XCTUnwrap(URL(string: "http://mac.local")), host: "192.0.2.42"),
            "http://192.0.2.42"
        )
        // No origin → https fallback, no port assumed.
        XCTAssertEqual(swapHost(into: nil, host: "192.0.2.42"), "https://192.0.2.42")
    }
}
