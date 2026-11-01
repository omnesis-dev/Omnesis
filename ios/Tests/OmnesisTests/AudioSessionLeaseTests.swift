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

final class SpeechPermissionRequestTests: XCTestCase {
    func testPermissionPromptCanStartItsCurrentCapture() {
        var request = SpeechPermissionRequest()
        let generation = request.begin()
        XCTAssertTrue(request.owns(generation))
    }

    func testDismissalBeforeSpeechPermissionReplyPreventsRecording() {
        var request = SpeechPermissionRequest()
        let generation = request.begin()
        request.cancel()
        XCTAssertFalse(request.owns(generation))
    }

    func testDismissalBetweenSpeechAndMicrophoneRepliesPreventsRecording() {
        var request = SpeechPermissionRequest()
        let generation = request.begin()
        XCTAssertTrue(request.owns(generation), "Speech authorization may request microphone access")
        request.cancel()
        XCTAssertFalse(request.owns(generation), "A late microphone grant must not start a dismissed capture")
    }

    func testNewCaptureCannotBeStartedOrDeniedByAnEarlierPrompt() {
        var request = SpeechPermissionRequest()
        let first = request.begin()
        let second = request.begin()
        XCTAssertFalse(request.owns(first))
        XCTAssertTrue(request.owns(second))
        request.cancel()
        XCTAssertFalse(request.owns(second))
    }
}
