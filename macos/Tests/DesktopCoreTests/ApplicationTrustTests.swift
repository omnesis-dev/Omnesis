// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class ApplicationTrustTests: XCTestCase {
    func testIncompleteApplicationReportsActionableRefusalBeforeCacheOrTrustWork() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-incomplete-app-\(UUID().uuidString)")
        XCTAssertThrowsError(try DesktopRuntimeBootstrap.prepare(appBundle: root, environment: [:])) { error in
            XCTAssertTrue(error.localizedDescription.contains("missing its background service"))
        }
    }

    func testPublicTrustMethodNeverAdmitsUnsignedApplicationIncludingDebugBuilds() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-untrusted-app-\(UUID().uuidString)")
        let app = root.appendingPathComponent("Omnesis.app")
        let contents = app.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let info: [String: String] = ["CFBundleIdentifier": "dev.omnesis.desktop", "CFBundleExecutable": "missing"]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        XCTAssertThrowsError(try DesktopRuntimeBootstrap.validateApplication(app))
    }

    func testInstallerContainerTrustRejectsUnsignedBytesAndNonImagePaths() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-untrusted-image-\(UUID().uuidString)")
            .resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let image = root.appendingPathComponent("unsigned.dmg")
        try Data("inert unsigned fixture".utf8).write(to: image)
        XCTAssertThrowsError(try DesktopRuntimeBootstrap.validateInstallerContainer(image))
        XCTAssertThrowsError(try DesktopRuntimeBootstrap.validateInstallerContainer(root.appendingPathComponent("other.app")))
    }
}
