// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
@testable import DesktopCore
import Foundation
import XCTest

final class CanonicalPathTests: XCTestCase {
    func testTemporaryPathMatchesPosixIdentityAndAllowsOnlyMissingChildren() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-canonical-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let pointer = try XCTUnwrap(root.path.withCString { Darwin.realpath($0, nil) })
        defer { free(pointer) }
        let expected = String(cString: pointer)
        XCTAssertEqual(try DesktopCanonicalPath.resolve(root.path), expected)
        XCTAssertEqual(try DesktopCanonicalPath.resolve(expected), expected)
        XCTAssertEqual(try DesktopCanonicalPath.resolve(expected + "/missing/child", allowMissing: true), expected + "/missing/child")
        XCTAssertThrowsError(try DesktopCanonicalPath.resolve(expected + "/missing"))
        try FileManager.default.createSymbolicLink(atPath: expected + "/alias", withDestinationPath: expected + "/missing")
        XCTAssertThrowsError(try DesktopCanonicalPath.resolve(expected + "/alias", allowMissing: true))
        // On macOS /var is an OS alias; the shared identity must retain POSIX /private/var.
        XCTAssertEqual(try DesktopCanonicalPath.resolve("/var"), "/private/var")
    }
}
