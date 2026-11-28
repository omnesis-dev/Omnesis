// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class ProcessAuthorityManifestTests: XCTestCase {
    func testOnlyTheRequiredExplicitProcessAuthorityCanBeAdmittedForExecution() throws {
        try DesktopProcessAuthorityManifest.require(Data(#"{"format":1,"processAuthorityProtocol":3,"inventory":[]}"#.utf8))
        for value in [
            #"{"format":1}"#, #"{"format":1,"processAuthorityProtocol":1}"#,
            #"{"format":1,"processAuthorityProtocol":2}"#, #"{"format":1,"processAuthorityProtocol":4}"#,
            #"{"format":2,"processAuthorityProtocol":3}"#,
            #"{"format":1,"processAuthorityProtocol":"3"}"#, #"{"format":1,"processAuthorityProtocol":true}"#,
            "null", "[]", "malformed",
        ] {
            XCTAssertThrowsError(try DesktopProcessAuthorityManifest.require(Data(value.utf8)))
        }
    }
}
