// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

final class AudioSessionLeaseTests: XCTestCase {
    func testDelayedDictationCompletionCannotReleaseAudioSessionAfterCancellation() {
        var lease = AudioSessionLease()
        lease.begin()
        let recording = lease.generation
        XCTAssertTrue(lease.release())
        // Realtime now owns AVAudioSession. The dictation completion must not deactivate it.
        XCTAssertFalse(lease.owns(recording))
        XCTAssertFalse(lease.release(expectedGeneration: recording))
        XCTAssertFalse(lease.release())
    }

    func testOldRecorderCannotReleaseReplacementRecorder() {
        var lease = AudioSessionLease()
        lease.begin()
        let old = lease.generation
        lease.begin()
        let replacement = lease.generation
        XCTAssertFalse(lease.release(expectedGeneration: old))
        XCTAssertTrue(lease.owns(replacement))
        XCTAssertTrue(lease.release(expectedGeneration: replacement))
    }

    func testIdleRecorderDoesNotOwnSharedAudioSession() {
        var lease = AudioSessionLease()
        XCTAssertFalse(lease.release())
    }
}

final class RealtimeCaptureReadinessTests: XCTestCase {
    func testEngineStartWithoutCapturedFramesIsNotListening() {
        var readiness = RealtimeCaptureReadiness()
        XCTAssertFalse(readiness.isReady)
        XCTAssertFalse(readiness.receivePCMFrame(byteCount: 0))
        XCTAssertFalse(readiness.isReady)
    }

    func testCapturedSilenceIsValidAndStartupTransitionHappensOnce() {
        var readiness = RealtimeCaptureReadiness()
        let silence = Data(repeating: 0, count: 2048)
        XCTAssertTrue(readiness.receivePCMFrame(byteCount: silence.count))
        XCTAssertTrue(readiness.isReady)
        XCTAssertFalse(readiness.receivePCMFrame(byteCount: silence.count))
    }
}
