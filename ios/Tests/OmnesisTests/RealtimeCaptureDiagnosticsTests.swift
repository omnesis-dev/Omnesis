// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class RealtimeCaptureDiagnosticsTests: XCTestCase {
    func testRawInputConversionAndSenderStagesAreCountedSeparately() {
        let diagnostics = RealtimeCaptureDiagnostics()
        XCTAssertTrue(diagnostics.input(frames: 2048).isFirst)
        diagnostics.converted(hasData: false, status: "input-ran-dry")
        let waiting = diagnostics.snapshot
        XCTAssertEqual(waiting.inputBuffers, 1)
        XCTAssertEqual(waiting.inputFrames, 2048)
        XCTAssertEqual(waiting.convertedPackets, 0)
        XCTAssertEqual(waiting.emptyConversions, 1)
        XCTAssertEqual(waiting.conversionStatus, "input-ran-dry")
        XCTAssertFalse(diagnostics.input(frames: 2048).isFirst)
        diagnostics.converted(hasData: true, status: "have-data")
        XCTAssertEqual(diagnostics.snapshot.convertedPackets, 1)
        XCTAssertEqual(diagnostics.snapshot.sentPackets, 0)
        diagnostics.sent()
        diagnostics.configurationChanged()
        diagnostics.restarted()
        let ready = diagnostics.snapshot
        XCTAssertEqual(ready.sentPackets, 1)
        XCTAssertEqual(ready.configurationChanges, 1)
        XCTAssertEqual(ready.restarts, 1)
    }

    func testQueuedOldFramesCannotSatisfyReadinessAfterAnEngineRestart() {
        let diagnostics = RealtimeCaptureDiagnostics()
        let beforeRestart = diagnostics.input(frames: 2048)
        XCTAssertTrue(diagnostics.isCurrent(beforeRestart))
        diagnostics.advanceEpoch()
        XCTAssertFalse(diagnostics.isCurrent(beforeRestart))
        let afterRestart = diagnostics.input(frames: 2048)
        XCTAssertTrue(diagnostics.isCurrent(afterRestart))
        XCTAssertEqual(diagnostics.snapshot.inputBuffers, 2)
    }
}
