// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import Foundation
import XCTest

final class PermissionGuidanceTests: XCTestCase {
    @MainActor
    func testSettingsNavigationIsAllowlistedAndNeverReportsAuthorization() {
        var requests: [URL] = []
        let result = DesktopPermissionSettings.navigate(.fullDiskAccess) { requests.append($0)
            return true
        }
        XCTAssertEqual(result, .requestedCategoryOpened)
        XCTAssertEqual(requests.map(\.absoluteString), [
            "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
        ])
        XCTAssertNil(DesktopPermissionSettings.Category(rawValue: "https://example.com"))
        XCTAssertNil(DesktopPermissionSettings.Category(rawValue: "camera"))
    }

    @MainActor
    func testFailedCategoryFallsBackOnlyToPrivacySettings() {
        var requests: [URL] = []
        let result = DesktopPermissionSettings.navigate(.fullDiskAccess) {
            requests.append($0)
            return requests.count == 2
        }
        XCTAssertEqual(result, .privacySettingsOpened)
        XCTAssertEqual(requests.last?.absoluteString, "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension")
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(DesktopPermissionSettings.navigate(.fullDiskAccess, open: { _ in false }), .unavailable)
        var count = 0
        XCTAssertEqual(DesktopPermissionSettings.navigate(.privacySecurity, open: { _ in count += 1
            return false
        }), .unavailable)
        XCTAssertEqual(count, 1)
    }

    func testMainAndEmbeddedHelperResolveSameVerifiedProductButUnverifiedReader() throws {
        let app = try fixture()
        defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
        var checked: [URL] = []
        var refusals: [DesktopPermissionApplication.Refusal] = []
        let direct = DesktopPermissionApplication.resolve(
            bundleURL: app,
            identifier: "dev.omnesis.desktop",
            onRefusal: { refusals.append($0) }
        ) { checked.append($0) }
        let helper = app.appendingPathComponent("Contents/Library/LoginItems/OmnesisBackground.app")
        let background = DesktopPermissionApplication
            .resolve(bundleURL: helper, identifier: "dev.omnesis.desktop.background", onRefusal: { refusals.append($0) }) {
                checked.append($0)
            }
        XCTAssertNotNil(direct, "Refused stages: \(refusals.map(\.rawValue))")
        XCTAssertTrue(refusals.isEmpty, "Refused stages: \(refusals.map(\.rawValue))")
        XCTAssertEqual(direct, background)
        XCTAssertEqual(direct?.displayName, "Omnesis")
        XCTAssertEqual(direct?.applicationURL.path, app.path)
        XCTAssertEqual(direct?.readerAttribution, .unverified)
        XCTAssertEqual(checked.map(\.path), [app.path, app.path])
    }

    func testSigningFailureUnknownProcessAndMisplacedHelperNeverProvideGrantTarget() throws {
        let app = try fixture()
        defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
        XCTAssertNil(DesktopPermissionApplication.resolve(bundleURL: app, identifier: "dev.omnesis.desktop") { _ in
            throw CocoaError(.fileReadNoPermission)
        })
        var verified = false
        XCTAssertNil(DesktopPermissionApplication.resolve(bundleURL: app, identifier: "dev.omnesis.desktop.runtime-exec") { _ in
            verified = true
        })
        XCTAssertNil(DesktopPermissionApplication.resolve(bundleURL: app, identifier: "dev.omnesis.desktop.background") { _ in
            verified = true
        })
        XCTAssertFalse(verified)
        // An invented unsigned bundle must fail the actual production verifier.
        XCTAssertNil(DesktopPermissionApplication.resolve(
            bundleURL: app,
            identifier: "dev.omnesis.desktop",
            validate: DesktopRuntimeBootstrap.validateApplication
        ))
    }

    func testBundleAliasIsRefusedBeforeSigning() throws {
        let app = try fixture()
        defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
        let alias = app.deletingLastPathComponent().appendingPathComponent("Alias.app")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: app)
        var verified = false
        XCTAssertNil(DesktopPermissionApplication.resolve(bundleURL: alias, identifier: "dev.omnesis.desktop") { _ in verified = true })
        XCTAssertFalse(verified)
    }

    func testMissingEmbeddedHelperIsRefusedBeforeSigning() throws {
        let app = try fixture()
        defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
        let helper = app.appendingPathComponent("Contents/Library/LoginItems/OmnesisBackground.app")
        try FileManager.default.removeItem(at: helper)
        var checked = false
        XCTAssertNil(DesktopPermissionApplication.resolve(bundleURL: helper, identifier: "dev.omnesis.desktop.background") { _ in
            checked = true
        })
        XCTAssertFalse(checked)
    }

    func testExecutableAliasIsRefusedBeforeSigning() throws {
        let app = try fixture()
        defer { try? FileManager.default.removeItem(at: app.deletingLastPathComponent()) }
        let executable = app.appendingPathComponent("Contents/MacOS/Omnesis")
        let outside = app.deletingLastPathComponent().appendingPathComponent("other-executable")
        try FileManager.default.moveItem(at: executable, to: outside)
        try FileManager.default.createSymbolicLink(at: executable, withDestinationURL: outside)
        var refusal: DesktopPermissionApplication.Refusal?
        var checked = false
        XCTAssertNil(DesktopPermissionApplication
            .resolve(bundleURL: app, identifier: "dev.omnesis.desktop", onRefusal: { refusal = $0 }) { _ in checked = true })
        XCTAssertEqual(refusal, .executable)
        XCTAssertFalse(checked)
    }

    private func fixture() throws -> URL {
        let allocated = FileManager.default.temporaryDirectory.appendingPathComponent("permission-product-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: allocated, withIntermediateDirectories: true)
        // Use POSIX realpath after creation, matching the production trust guard.
        // Foundation URL normalization may rewrite /private/var back to /var.
        let root = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(allocated.path), isDirectory: true)
        let app = root.appendingPathComponent("Omnesis.app", isDirectory: true)
        for (bundleURL, identifier, executable) in [
            (app, "dev.omnesis.desktop", "Omnesis"),
            (
                app.appendingPathComponent("Contents/Library/LoginItems/OmnesisBackground.app", isDirectory: true),
                "dev.omnesis.desktop.background",
                "OmnesisBackground"
            ),
        ] {
            let contents = bundleURL.appendingPathComponent("Contents", isDirectory: true)
            try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
            let info: [String: String] = [
                "CFBundleIdentifier": identifier, "CFBundleDisplayName": "Omnesis",
                "CFBundlePackageType": "APPL", "CFBundleExecutable": executable,
            ]
            try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
                .write(to: contents.appendingPathComponent("Info.plist"))
            let binary = contents.appendingPathComponent("MacOS/\(executable)")
            try Data().write(to: binary)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: binary.path)
        }
        return try URL(fileURLWithPath: DesktopCanonicalPath.resolve(app.path), isDirectory: true)
    }
}
