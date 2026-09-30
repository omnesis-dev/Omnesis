// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The operator's gateway dictation opt-in, written as a partial config.
final class DictationClientTests: XCTestCase {
    private let base = URL(string: "https://gateway.example.com:7600")!

    func testOptInPatchesTheGatewayConfig() throws {
        let request = try DictationClient.optInRequest(baseURL: base, token: "omn_t", enabled: true)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/admin/config")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let inference = try XCTUnwrap(json["inference"] as? [String: Any])
        let dictation = try XCTUnwrap(inference["dictation"] as? [String: Any])
        XCTAssertEqual(dictation["transcribeOnGateway"] as? Bool, true)
        XCTAssertEqual(json.count, 1)
        XCTAssertEqual(inference.count, 1)

        let off = try DictationClient.optInRequest(baseURL: base, token: "omn_t", enabled: false)
        let offJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(off.httpBody)) as? [String: Any])
        let offFlag = ((offJSON["inference"] as? [String: Any])?["dictation"] as? [String: Any])?["transcribeOnGateway"]
        XCTAssertEqual(offFlag as? Bool, false)
    }
}
