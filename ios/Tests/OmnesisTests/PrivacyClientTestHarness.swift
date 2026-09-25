// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The mocked HTTP layer both privacy client suites drive. `PrivacyClient` is
/// one type covering two distinct surfaces — the answer boundary and the watch
/// registry — so the suites are split by surface and share the transport.
class PrivacyClientTestCase: XCTestCase {
    final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var responder: ((URLRequest) -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            guard let responder else { throw GatewayClient.Error.invalidResponse }
            return responder(request)
        }
    }

    let baseURL = URL(string: "http://gateway.example:7600")!

    func response(_ request: URLRequest, status: Int = 200, body: String) -> (Data, URLResponse) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (Data(body.utf8), response)
    }

    func queryItems(_ request: URLRequest) -> [String: String] {
        Dictionary(
            uniqueKeysWithValues: (
                URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            ).compactMap { item in
                item.value.map { (item.name, $0) }
            }
        )
    }
}
