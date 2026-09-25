// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@available(iOS 17.0, *)
final class PushRegistrarTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var bodies: [Data] = []
        var responder: ((URLRequest) -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            bodies.append(request.httpBody ?? Data())
            guard let responder else {
                throw GatewayClient.Error.invalidResponse
            }
            return responder(request)
        }
    }

    private let base = URL(string: "http://mac.local:7600")!

    private func ok(url: URL) -> (Data, URLResponse) {
        let resp = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data("{\"ok\":true}".utf8), resp)
    }

    func testHexEncodeMatchesAPNsFormat() {
        // 0xde 0xad 0xbe 0xef → "deadbeef"
        let data = Data([0xDE, 0xAD, 0xBE, 0xEF])
        XCTAssertEqual(PushRegistrar.hexEncode(data), "deadbeef")
    }

    func testHexEncodePadsSingleHexDigitBytes() {
        // 0x00 0x0f 0x10 → "000f10" (each byte pads to two hex chars)
        let data = Data([0x00, 0x0F, 0x10])
        XCTAssertEqual(PushRegistrar.hexEncode(data), "000f10")
    }

    func testReportPostsCorrectPathAndHeaders() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in self!.ok(url: req.url!) }
        let registrar = PushRegistrar(
            baseURL: base,
            token: "omn_t",
            deviceId: "11111111-1111-1111-1111-111111111111",
            bundleId: "dev.omnesis.ios",
            session: session
        )
        try await registrar.report(
            tokenHex: "abcdef".repeating(11) + "ab",
            environment: "production"
        )
        let req = session.requests[0]
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(
            req.url?.absoluteString,
            "http://mac.local:7600/admin/devices/11111111-1111-1111-1111-111111111111/apns-token"
        )
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func testReportEncodesBody() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in self!.ok(url: req.url!) }
        let registrar = PushRegistrar(
            baseURL: base,
            token: "omn_t",
            deviceId: "22222222-2222-2222-2222-222222222222",
            bundleId: "dev.omnesis.ios",
            session: session
        )
        try await registrar.report(tokenHex: "deadbeef", environment: "sandbox")
        let body = try JSONSerialization.jsonObject(with: session.bodies[0]) as? [String: Any]
        XCTAssertEqual(body?["deviceToken"] as? String, "deadbeef")
        XCTAssertEqual(body?["environment"] as? String, "sandbox")
        XCTAssertEqual(body?["bundleId"] as? String, "dev.omnesis.ios")
    }

    func testReportThrowsOnNon2xx() async {
        let session = MockSession()
        session.responder = { req in
            let resp = HTTPURLResponse(
                url: req.url!, statusCode: 400, httpVersion: "HTTP/1.1",
                headerFields: nil
            )!
            return (Data("{\"error\":\"bad\"}".utf8), resp)
        }
        let registrar = PushRegistrar(
            baseURL: base,
            token: "omn_t",
            deviceId: "33333333-3333-3333-3333-333333333333",
            bundleId: "dev.omnesis.ios",
            session: session
        )
        do {
            try await registrar.report(tokenHex: "deadbeef", environment: "production")
            XCTFail("expected error")
        } catch PushRegistrarError.serverError(let status, let body) {
            XCTAssertEqual(status, 400)
            XCTAssertTrue(body.contains("bad"))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}

extension String {
    /// Tiny helper used to build oversized hex strings without the
    /// boilerplate of `Array(repeating:)`.
    fileprivate func repeating(_ count: Int) -> String {
        String(repeating: self, count: count)
    }
}
