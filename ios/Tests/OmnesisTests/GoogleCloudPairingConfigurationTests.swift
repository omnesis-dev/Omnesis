// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class GoogleCloudPairingConfigurationTests: XCTestCase {
    func testConfigurationValidatesTheClientAndItsRegisteredCallbackScheme() throws {
        let id = "fixture-ios.apps.googleusercontent.com"
        let scheme = "com.googleusercontent.apps.fixture-ios"
        let valid: [String: Any] = [
            "OmnesisGoogleClientID": id,
            "CFBundleURLTypes": [["CFBundleURLSchemes": ["unrelated"]], ["CFBundleURLSchemes": [scheme]]],
        ]
        var cases: [[String: Any]] = []
        for field in ["OmnesisGoogleClientID", "CFBundleURLTypes"] {
            var invalid = valid
            invalid.removeValue(forKey: field)
            cases.append(invalid)
        }
        for value: Any in [false, "", "invalid", "$(MISSING).apps.googleusercontent.com"] {
            var invalid = valid
            invalid["OmnesisGoogleClientID"] = value
            cases.append(invalid)
        }
        for callbacks: Any in [[], [["CFBundleURLSchemes": "wrong-type"]], [["CFBundleURLSchemes": ["unrelated"]]]] {
            var invalid = valid
            invalid["CFBundleURLTypes"] = callbacks
            cases.append(invalid)
        }
        for info in cases {
            XCTAssertNil(try GoogleCloudPairingConfiguration.configured(bundle: configurationBundle(info)))
        }
        let accepted = try XCTUnwrap(GoogleCloudPairingConfiguration.configured(bundle: configurationBundle(valid)))
        XCTAssertEqual(accepted.clientId, id)
    }

    private func configurationBundle(_ info: [String: Any]) throws -> Bundle {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("bundle")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: folder.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(Bundle(url: folder))
    }
}
