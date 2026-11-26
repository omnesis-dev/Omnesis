// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Darwin
import DesktopCore
@testable import OmnesisDesktop
import XCTest

@MainActor
final class DesktopStartupTests: XCTestCase {
    func testStdoutEOFOfALiveOwnedHelperFailsTheConnectionAndDrainsItsInput() async throws {
        let selected = FileManager.default.temporaryDirectory.appendingPathComponent("omnesis-eof-fixture-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: selected, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let base = try URL(fileURLWithPath: DesktopCanonicalPath.resolve(selected.path), isDirectory: true)
        let cache = base.appendingPathComponent("runtime")
        try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let manifest = Data(
            #"{"format":1,"codeUsageProtocol":1,"processAuthorityProtocol":3,"runtimeLauncher":"runtime-exec","inventory":[{"path":"node","executable":true},{"path":"runtime-exec","executable":true}]}"#
                .utf8
        )
        let epoch = SHA256.hash(data: manifest).map { String(format: "%02x", $0) }.joined()
        let runtime = cache.appendingPathComponent(epoch)
        let script = runtime.appendingPathComponent("packages/cli/dist/index.js")
        try FileManager.default.createDirectory(at: script.deletingLastPathComponent(), withIntermediateDirectories: true)
        try manifest.write(to: runtime.appendingPathComponent("desktop-runtime.json"))
        try Data("inert fixture entry".utf8).write(to: script)
        let helper = runtime.appendingPathComponent("runtime-exec")
        // Keeps its own stdin open after closing stdout. No gateway or network is involved.
        try Data("#!/bin/sh\nprintf '%s\\n' \"$$\" > \"$2.pid\"\nexec 1>&-\nwhile IFS= read -r ignored; do :; done\n".utf8)
            .write(to: helper)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        let bridge = RuntimeBridge(preparation: { _ in
            try (runtime, DesktopRuntimeUsageLease.acquire(runtime: runtime))
        })
        defer { bridge.disconnect() }
        var failed = false
        bridge.onFailure = { _ in failed = true }
        try await bridge.start()
        let deadline = ContinuousClock().now.advanced(by: .seconds(5))
        while !failed, ContinuousClock().now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(failed, "A live helper's closed output must refuse an awaited response")
        bridge.disconnect()
        let pidText = try String(contentsOf: URL(fileURLWithPath: script.path + ".pid"), encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let pid = try XCTUnwrap(Int32(pidText))
        let drained = ContinuousClock().now.advanced(by: .seconds(5))
        while Darwin.kill(pid, 0) == 0, ContinuousClock().now < drained {
            try await Task.sleep(for: .milliseconds(10))
        }
        guard Darwin.kill(pid, 0) != 0, errno == ESRCH else {
            XCTFail("Owned fixture has not drained; retain its files")
            return
        }
        try FileManager.default.removeItem(at: base)
    }

    func testPendingPreparationIsVisibleCannotOpenLibraryAndCanBeCancelled() async {
        let bridge = RuntimeBridge(preparation: { _ in
            try await Task.sleep(for: .seconds(30))
            throw CancellationError()
        })
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge)
        store.start()
        XCTAssertTrue(store.launchingRuntime)
        XCTAssertTrue(store.busy)
        XCTAssertFalse(store.state.canOpenLibrary)
        await Task.yield()
        let clock = ContinuousClock()
        let start = clock.now
        await store.cancelStartup()
        XCTAssertLessThan(start.duration(to: clock.now), .seconds(5))
        XCTAssertFalse(store.launchingRuntime)
        XCTAssertFalse(store.busy)
        XCTAssertTrue(store.startupCancelled)
        XCTAssertFalse(store.state.canOpenLibrary)
    }

    func testLostBridgeNeverLeavesPresentationConnected() throws {
        let bridge = RuntimeBridge()
        let store = DesktopStore(startRuntime: false, runtimeBridge: bridge)
        store.state = try JSONDecoder().decode(
            DesktopState.self,
            from: Data(
                #"{"phase":"ready","mode":"joined","encrypted":true,"connection":{"url":"https://localhost:17601","token":"fixture-token"}}"#
                    .utf8
            )
        )
        XCTAssertTrue(store.state.canOpenLibrary)
        bridge.onFailure?("Fictional connection closed")
        XCTAssertFalse(store.state.canOpenLibrary)
        XCTAssertNil(store.api)
        XCTAssertEqual(store.state.phase, .waiting)
    }
}
