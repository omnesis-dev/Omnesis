// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation
import XCTest

/// Additional diagnosis only; it does not replace any of the five product UI tests.
@MainActor
final class DesktopExternalAXControlUITests: XCTestCase {
    private enum Phase: String {
        case preflightPassed, controlLaunchEnter, controlLaunchReturned, controlQueryEnter, controlQueryReturned
        case controlTerminateEnter, controlTerminateReturned, omnesisLaunchEnter, omnesisLaunchReturned
        case omnesisQueryEnter, omnesisQueryReturned, omnesisTerminateEnter, omnesisTerminateReturned, completed
    }

    private enum Refusal: Error { case unsafeFixture }

    private func phase(_ phase: Phase, runner: pid_t) {
        let line = "external-ax-control phase=" + phase.rawValue + " sameRunner=" + String(getpid() == runner) + "\n"
        _ = Array(line.utf8).withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
    }

    private func owned(_ url: URL, directory: Bool) throws {
        guard url.standardizedFileURL == url.resolvingSymlinksInPath().standardizedFileURL else { throw Refusal.unsafeFixture }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == (directory ? .typeDirectory : .typeRegular),
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let permissions = attributes[.posixPermissions] as? NSNumber, permissions.intValue & 0o022 == 0 else {
            throw Refusal.unsafeFixture
        }
        if !directory {
            guard (attributes[.referenceCount] as? NSNumber)?.intValue == 1 else { throw Refusal.unsafeFixture }
        }
    }

    private func bundle(_ url: URL, identifier: String, executable: String, packageType: String) throws {
        try owned(url, directory: true)
        let contents = url.appendingPathComponent("Contents", isDirectory: true)
        try owned(contents, directory: true)
        let info = contents.appendingPathComponent("Info.plist")
        try owned(info, directory: false)
        let size = try FileManager.default.attributesOfItem(atPath: info.path)[.size] as? NSNumber
        guard let size, size.intValue > 0, size.intValue <= 65536 else { throw Refusal.unsafeFixture }
        let metadata = try PropertyListSerialization.propertyList(from: Data(contentsOf: info), format: nil) as? [String: Any]
        guard metadata?["CFBundleIdentifier"] as? String == identifier,
              metadata?["CFBundleExecutable"] as? String == executable,
              metadata?["CFBundlePackageType"] as? String == packageType else { throw Refusal.unsafeFixture }
        let binaries = contents.appendingPathComponent("MacOS", isDirectory: true)
        try owned(binaries, directory: true)
        let binary = binaries.appendingPathComponent(executable)
        try owned(binary, directory: false)
        guard FileManager.default.isExecutableFile(atPath: binary.path) else { throw Refusal.unsafeFixture }
    }

    private func verifiedProducts() throws -> (control: URL, omnesis: URL) {
        var checkout = URL(fileURLWithPath: #filePath)
        for _ in 0 ..< 3 {
            checkout.deleteLastPathComponent()
        }
        try owned(checkout, directory: true)
        var products = checkout
        for part in ["macos", "build", "Build", "Products", "Debug"] {
            products.appendPathComponent(part, isDirectory: true)
            try owned(products, directory: true)
        }
        let runner = products.appendingPathComponent("OmnesisDesktopUITests-Runner.app", isDirectory: true)
        guard Bundle.main.bundleURL.standardizedFileURL == runner else { throw Refusal.unsafeFixture }
        try bundle(
            runner,
            identifier: "dev.omnesis.desktop.uitests.xctrunner",
            executable: "OmnesisDesktopUITests-Runner",
            packageType: "APPL"
        )
        let plugins = runner.appendingPathComponent("Contents/PlugIns", isDirectory: true)
        try owned(plugins, directory: true)
        let tests = plugins.appendingPathComponent("OmnesisDesktopUITests.xctest", isDirectory: true)
        guard Bundle(for: Self.self).bundleURL.standardizedFileURL == tests else { throw Refusal.unsafeFixture }
        try bundle(tests, identifier: "dev.omnesis.desktop.uitests", executable: "OmnesisDesktopUITests", packageType: "BNDL")
        let control = products.appendingPathComponent("OmnesisAXControlFixture.app", isDirectory: true)
        try bundle(
            control,
            identifier: "dev.omnesis.desktop.ax-control-fixture",
            executable: "OmnesisAXControlFixture",
            packageType: "APPL"
        )
        let omnesis = products.appendingPathComponent("Omnesis.app", isDirectory: true)
        try bundle(omnesis, identifier: "dev.omnesis.desktop", executable: "Omnesis", packageType: "APPL")
        guard ProcessInfo.processInfo.environment["OMNESIS_DESKTOP_RUNTIME_DIR"] == nil,
              !FileManager.default.fileExists(atPath: omnesis.appendingPathComponent("Contents/Resources/runtime").path) else {
            throw Refusal.unsafeFixture
        }
        return (control, omnesis)
    }

    func testStandardAppKitThenOwnedOmnesisCanBeQueriedInOneRunnerMethod() throws {
        guard ProcessInfo.processInfo.environment["OMNESIS_EXTERNAL_AX_CONTROL_DIAGNOSTIC"] == "1" else {
            throw XCTSkip("The additional external AX diagnostic requires explicit runner-only opt-in")
        }
        let runner = getpid()
        let products: (control: URL, omnesis: URL)
        do { products = try verifiedProducts() }
        catch { return XCTFail("The diagnostic requires this runner's exact owned Debug test products and incomplete runtime fixture") }
        phase(.preflightPassed, runner: runner)
        // macOS-only public URL initializer avoids any bundle-ID Launch Services fallback.
        let control = XCUIApplication(url: products.control)
        phase(.controlLaunchEnter, runner: runner)
        control.launch()
        phase(.controlLaunchReturned, runner: runner)
        var controlNeedsTermination = true
        defer {
            if controlNeedsTermination {
                phase(.controlTerminateEnter, runner: runner)
                control.terminate()
                phase(.controlTerminateReturned, runner: runner)
            }
        }
        phase(.controlQueryEnter, runner: runner)
        let label = control.staticTexts["external-ax-control-label"]
        guard label.waitForExistence(timeout: 10)
        else { return XCTFail("The standard AppKit control query failed; the Omnesis comparison is unavailable") }
        let text = label.value as? String ?? label.label
        let frame = label.frame
        guard text == "Fictional AppKit control is ready",
              [frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite),
              frame.width > 0, frame.height > 0, label.isHittable else {
            return XCTFail("The standard AppKit control did not expose its expected visible label; the Omnesis comparison is unavailable")
        }
        XCTAssertTrue(getpid() == runner, "Both queries must continue in the same runner process")
        phase(.controlQueryReturned, runner: runner)
        phase(.controlTerminateEnter, runner: runner)
        control.terminate()
        controlNeedsTermination = false
        phase(.controlTerminateReturned, runner: runner)
        let omnesis = XCUIApplication(url: products.omnesis)
        phase(.omnesisLaunchEnter, runner: runner)
        omnesis.launch()
        phase(.omnesisLaunchReturned, runner: runner)
        var omnesisNeedsTermination = true
        defer {
            if omnesisNeedsTermination {
                phase(.omnesisTerminateEnter, runner: runner)
                omnesis.terminate()
                phase(.omnesisTerminateReturned, runner: runner)
            }
        }
        phase(.omnesisQueryEnter, runner: runner)
        let banner = omnesis.descendants(matching: .any).matching(identifier: "runtime-error").firstMatch
        guard banner.waitForExistence(timeout: 10)
        else { return XCTFail("The owned Omnesis external query failed after the control query") }
        XCTAssertTrue(getpid() == runner, "Both queries must continue in the same runner process")
        phase(.omnesisQueryReturned, runner: runner)
        phase(.omnesisTerminateEnter, runner: runner)
        omnesis.terminate()
        omnesisNeedsTermination = false
        phase(.omnesisTerminateReturned, runner: runner)
        phase(.completed, runner: runner)
    }
}
