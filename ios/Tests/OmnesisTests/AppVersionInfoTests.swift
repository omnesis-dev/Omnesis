// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The About section reads its three numbers out of the bundle and the
/// socket. These cover the reading itself; the shipped values are tied to
/// `project.yml` by `StoreSubmissionConfigurationTests`.
final class AppVersionInfoTests: XCTestCase {
    func testDemoBuildComesFromBundleMetadataForAnyRegisteredIdentifier() {
        XCTAssertTrue(AppBuild.isDemo(infoDictionary: [
            "CFBundleIdentifier": "com.example.myomnesis.demo",
            "OmnesisDemoBuild": true,
        ]))
        XCTAssertFalse(AppBuild.isDemo(infoDictionary: [
            "CFBundleIdentifier": "com.example.myomnesis",
        ]))
        XCTAssertFalse(AppBuild.isDemo(infoDictionary: [
            "CFBundleIdentifier": "dev.omnesis.ios.demo",
            "OmnesisDemoBuild": "true",
        ]))
    }

    func testReadsTheVersionAndBuildTheBundleDeclares() {
        let info: [String: Any] = [
            "CFBundleShortVersionString": "1.2.3",
            "CFBundleVersion": "456",
        ]
        XCTAssertEqual(AppBuild.productVersion(infoDictionary: info), "1.2.3")
        XCTAssertEqual(AppBuild.buildNumber(infoDictionary: info), "456")
    }

    /// The logic lane's host is an xctest runner whose generated plist
    /// carries neither key. Both readings must still yield something
    /// displayable rather than an empty row.
    func testFallsBackWhenTheBundleDeclaresNothing() {
        XCTAssertEqual(AppBuild.productVersion(infoDictionary: nil), "0.0.0")
        XCTAssertEqual(AppBuild.buildNumber(infoDictionary: nil), "0")
        XCTAssertEqual(AppBuild.productVersion(infoDictionary: [:]), "0.0.0")
        XCTAssertEqual(AppBuild.buildNumber(infoDictionary: [:]), "0")
    }

    /// A plist key of the wrong type is as absent as a missing one.
    func testFallsBackWhenTheKeysAreNotStrings() {
        let info: [String: Any] = ["CFBundleShortVersionString": 1, "CFBundleVersion": 2]
        XCTAssertEqual(AppBuild.productVersion(infoDictionary: info), "0.0.0")
        XCTAssertEqual(AppBuild.buildNumber(infoDictionary: info), "0")
    }

    /// So is a blank one: it would otherwise render an empty row, which reads
    /// as a broken screen rather than as a build declaring no version.
    func testFallsBackWhenTheKeysAreEmpty() {
        let info: [String: Any] = ["CFBundleShortVersionString": "", "CFBundleVersion": ""]
        XCTAssertEqual(AppBuild.productVersion(infoDictionary: info), "0.0.0")
        XCTAssertEqual(AppBuild.buildNumber(infoDictionary: info), "0")
    }

    /// The displayed protocol number is the one the socket actually sends. A
    /// hard-coded copy would keep reading `1` after a bump and quietly
    /// misdiagnose the connection failure the bump caused.
    @available(iOS 17.0, *)
    func testVersionInfoCarriesTheProtocolTheSocketSpeaks() {
        XCTAssertEqual(AppBuild.versionInfo.wireProtocol, DeviceSocket.protocolVersion)
    }

    /// The number a phone shows and the number it puts in its hello are one
    /// reading, so an operator comparing the two never sees them disagree.
    @available(iOS 17.0, *)
    func testDisplayedVersionMatchesTheOneReportedOnTheWire() {
        XCTAssertEqual(AppBuild.versionInfo.version, omnesisAppVersion())
    }
}
