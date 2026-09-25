// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import XCTest

final class StoreSubmissionConfigurationTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    func testShippingInfoPlistsRequireHTTPSAndUseReleaseVersion() throws {
        let project = try String(
            contentsOf: iosRoot.appendingPathComponent("project.yml"), encoding: .utf8
        )
        let releaseVersion = try projectSetting("MARKETING_VERSION", in: project)
        let buildVersion = try projectSetting("CURRENT_PROJECT_VERSION", in: project)

        for name in ["Info.plist", "Info-Demo.plist"] {
            let plist = try dictionary(at: iosRoot.appendingPathComponent(name))
            XCTAssertNil(plist["NSAppTransportSecurity"], "\(name) must not weaken ATS")
            XCTAssertEqual(plist["CFBundleShortVersionString"] as? String, releaseVersion)
            XCTAssertEqual(plist["CFBundleVersion"] as? String, buildVersion)

            for key in [
                "NSHealthShareUsageDescription",
                "NSLocationAlwaysAndWhenInUseUsageDescription",
                "NSLocationWhenInUseUsageDescription",
                "NSMotionUsageDescription",
            ] {
                let copy = try XCTUnwrap(plist[key] as? String)
                XCTAssertTrue(copy.contains("paired gateway"), "\(name) \(key) must explain transfer")
                XCTAssertFalse(copy.contains("never leaves"), "\(name) \(key) overstates locality")
            }
        }
    }

    func testEveryShippingExecutableHasAPrivacyManifest() throws {
        let paths = [
            "Resources/AppPrivacy/PrivacyInfo.xcprivacy",
            "Sources/OmnesisNotificationService/PrivacyInfo.xcprivacy",
            "Sources/OmnesisWidgets/PrivacyInfo.xcprivacy",
            "Sources/OmnesisWatch/PrivacyInfo.xcprivacy",
        ]
        for path in paths {
            let plist = try dictionary(at: iosRoot.appendingPathComponent(path))
            XCTAssertEqual(plist["NSPrivacyTracking"] as? Bool, false, path)
        }

        let project = try String(
            contentsOf: iosRoot.appendingPathComponent("project.yml"), encoding: .utf8
        )
        XCTAssertEqual(
            project.components(separatedBy: "Resources/AppPrivacy/PrivacyInfo.xcprivacy").count - 1,
            2,
            "production and demo apps must each bundle the app privacy manifest"
        )
        let extensionManifests = [
            "OmnesisNotificationService": "Sources/OmnesisNotificationService/PrivacyInfo.xcprivacy",
            "OmnesisWidgets": "Sources/OmnesisWidgets/PrivacyInfo.xcprivacy",
            "OmnesisWatch": "Sources/OmnesisWatch/PrivacyInfo.xcprivacy",
        ]
        for (target, path) in extensionManifests {
            let block = try targetBlock(named: target, in: project)
            XCTAssertTrue(block.contains("- path: \(path)"), "\(target) must explicitly bundle its privacy manifest")
            XCTAssertEqual(project.components(separatedBy: path).count - 1, 1, path)
        }
    }

    func testAppPrivacyManifestDeclaresExactRequiredReasonAPIs() throws {
        let manifest = try dictionary(
            at: iosRoot.appendingPathComponent("Resources/AppPrivacy/PrivacyInfo.xcprivacy")
        )
        let entries = try XCTUnwrap(manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        let reasons = try Dictionary(uniqueKeysWithValues: entries.map { entry in
            try (
                XCTUnwrap(entry["NSPrivacyAccessedAPIType"] as? String),
                XCTUnwrap(entry["NSPrivacyAccessedAPITypeReasons"] as? [String])
            )
        })
        XCTAssertEqual(reasons["NSPrivacyAccessedAPICategoryUserDefaults"], ["CA92.1"])
        XCTAssertEqual(reasons["NSPrivacyAccessedAPICategoryFileTimestamp"], ["C617.1"])
        XCTAssertEqual(reasons.count, 2)

        let collection = try XCTUnwrap(
            manifest["NSPrivacyCollectedDataTypes"] as? [[String: Any]]
        )
        XCTAssertEqual(collection.count, 1)
        XCTAssertEqual(
            collection.first?["NSPrivacyCollectedDataType"] as? String,
            "NSPrivacyCollectedDataTypeDeviceID"
        )
        XCTAssertEqual(collection.first?["NSPrivacyCollectedDataTypeLinked"] as? Bool, true)
        XCTAssertEqual(collection.first?["NSPrivacyCollectedDataTypeTracking"] as? Bool, false)
        XCTAssertEqual(
            collection.first?["NSPrivacyCollectedDataTypePurposes"] as? [String],
            ["NSPrivacyCollectedDataTypePurposeAppFunctionality"]
        )
    }

    private func dictionary(at url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )
    }

    private func targetBlock(named target: String, in project: String) throws -> String {
        let marker = "  \(target):\n"
        let start = try XCTUnwrap(project.range(of: marker)?.upperBound)
        let suffix = project[start...]
        let nextTargetPattern = #"\n  [A-Za-z][A-Za-z0-9_-]*:\n    type:"#
        let end = suffix.range(of: nextTargetPattern, options: .regularExpression)?.lowerBound
            ?? project.endIndex
        return String(project[start ..< end])
    }

    private func projectSetting(_ name: String, in project: String) throws -> String {
        let prefix = "\(name):"
        let line = try XCTUnwrap(
            project.components(separatedBy: .newlines)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .first { $0.hasPrefix(prefix) }
        )
        return line.dropFirst(prefix.count)
            .trimmingCharacters(in: CharacterSet(charactersIn: " \""))
    }
}
