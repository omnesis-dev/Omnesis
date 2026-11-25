// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
@testable import OmnesisDesktop
import XCTest

@MainActor
final class DesktopStartupTests: XCTestCase {
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
