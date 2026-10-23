// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(UIKit)
import AVFoundation
import Foundation
@testable import Omnesis
import SwiftUI
import UIKit
import XCTest
#if canImport(WebRTC)
@preconcurrency import WebRTC
#endif

/// Hardware-backed capture; no model inference and no audio content is retained or printed.
@MainActor
final class RealtimeAudioCaptureDeviceTests: XCTestCase {
    #if canImport(WebRTC)
    func testLiveWebRTCMicrophoneProducesCapturedSamples() async throws {
        try await assertWebRTCCapture(unownedCleanup: false)
    }

    func testLiveWebRTCMicrophoneSurvivesUnownedCleanup() async throws {
        try await assertWebRTCCapture(unownedCleanup: true)
    }

    func testLiveWebRTCMicrophoneReopensAfterOwnedTeardown() async throws {
        try await assertWebRTCCapture(unownedCleanup: false)
        XCTAssertTrue(RTCAudioSession.sharedInstance().useManualAudio)
        XCTAssertFalse(RTCAudioSession.sharedInstance().isAudioEnabled)
        try await assertWebRTCCapture(unownedCleanup: false)
    }

    func testLiveWebRTCMicrophoneStartsAfterCancelledNegotiation() async throws {
        try requireHardwareProbeOptIn()
        let granted = await AVAudioApplication.requestRecordPermission()
        XCTAssertTrue(granted)
        guard granted else { return }
        let cancelled = LiveWebRTCMedia()
        let prepared = expectation(description: "Real factory and input request prepared")
        var resumeOffer: CheckedContinuation<Void, Never>?
        cancelled.beforeOfferForTesting = {
            await withCheckedContinuation { continuation in
                resumeOffer = continuation
                prepared.fulfill()
            }
        }
        let offering = Task { try await cancelled.offer() }
        await fulfillment(of: [prepared], timeout: 5)
        let released = expectation(description: "Cancelled input initialization ownership released")
        cancelled.onReleasedForTesting = { released.fulfill() }
        cancelled.close()
        let prematureReplacement = LiveWebRTCMedia()
        do {
            _ = try await prematureReplacement.offer()
            XCTFail("A replacement must not acquire global input before old factory teardown")
        } catch {
            XCTAssertEqual((error as? RealtimeCallFailure)?.code, "session_busy")
        }
        prematureReplacement.close()
        resumeOffer?.resume()
        do {
            _ = try await offering.value
            XCTFail("A cancelled offer must not continue negotiating")
        } catch { XCTAssertTrue(error is CancellationError) }
        await fulfillment(of: [released], timeout: 5)
        try await assertWebRTCCapture(unownedCleanup: false)
    }

    private func assertWebRTCCapture(unownedCleanup: Bool) async throws {
        try requireHardwareProbeOptIn()
        let granted = await AVAudioApplication.requestRecordPermission()
        XCTAssertTrue(granted, "Grant microphone access before this explicit hardware test")
        guard granted else { return }
        let media = LiveWebRTCMedia()
        let remote = LiveWebRTCLoopback()
        let session = RealtimeCallSession()
        session.isLive = true
        session.status = "Starting microphone…"
        defer {
            try? renderProof(session, name: unownedCleanup ? "live-webrtc-microphone-cleanup" : "live-webrtc-microphone")
            media.onLevels = nil
            media.onFailure = nil
            media.close()
            remote.close()
        }
        let frames = expectation(description: "Production WebRTC captures real input samples, including silence")
        frames.assertForOverFulfill = false
        var failure: Error?
        media.onFailure = {
            failure = $0
            FileHandle.standardError.write(Data("Live SDK capture diagnostics: \(media.captureStatsSummaryForTesting)\n".utf8))
            session.error = RealtimeCallFailure.local($0)
            session.status = "Call interrupted"
            frames.fulfill()
        }
        var previousDuration = 0.0
        media.onLevels = { _, _ in
            let duration = media.capturedDurationForTesting
            if previousDuration > 0, duration > previousDuration { frames.fulfill() }
            previousDuration = duration
        }
        do {
            FileHandle.standardError.write(Data("Live microphone probe: offer\n".utf8))
            let offer = try await media.offer()
            FileHandle.standardError.write(Data("Live microphone probe: remote answer\n".utf8))
            let answer = try await remote.answer(offer: offer)
            FileHandle.standardError.write(Data("Live microphone probe: connect\n".utf8))
            try await media.connect(answer: answer)
            FileHandle.standardError.write(Data("Live microphone probe: enable input\n".utf8))
            try await media.startMicrophone()
        } catch {
            failure = failure ?? error
            session.error = RealtimeCallFailure.local(error)
            session.status = "Call interrupted"
            frames.fulfill()
        }
        await fulfillment(of: [frames], timeout: 10)
        XCTAssertNil(failure)
        XCTAssertGreaterThan(media.capturedDurationForTesting, 0, media.captureStatsSummaryForTesting)
        FileHandle.standardError.write(Data("Live SDK capture successful: \(media.captureStatsSummaryForTesting)\n".utf8))
        if unownedCleanup {
            let continued = expectation(description: "Real capture continues after unrelated cleanup")
            continued.assertForOverFulfill = false
            let beforeCleanup = media.capturedDurationForTesting
            media.onLevels = { _, _ in
                if media.capturedDurationForTesting > beforeCleanup + 0.3 { continued.fulfill() }
            }
            let unusedFacade = RealtimeCallSession()
            unusedFacade.stop()
            unusedFacade.stop()
            let unusedMedia = LiveWebRTCMedia()
            unusedMedia.close()
            unusedMedia.close()
            await fulfillment(of: [continued], timeout: 3)
            XCTAssertGreaterThan(media.capturedDurationForTesting, beforeCleanup + 0.3)
        }
        session.connected = media.capturedDurationForTesting > 0 && failure == nil
        session.status = session.connected ? "Listening" : "Call interrupted"
        if !session.connected { session.error = RealtimeCallFailure(code: "microphone_failed", fatal: true, retryable: true) }
        let released = expectation(description: "Owned audio teardown completes before replacement capture")
        media.onReleasedForTesting = { released.fulfill() }
        media.close()
        await fulfillment(of: [released], timeout: 5)
    }
    #endif

    func testLiveMicrophoneReachesSerializedGatewayAudioFrames() async throws {
        try await assertLiveCapture(voiceProcessing: true, name: "realtime-live-microphone")
    }

    func testPlainRemoteIOControlReachesSerializedGatewayAudioFrames() async throws {
        try await assertLiveCapture(voiceProcessing: false, name: "realtime-live-remote-io")
    }

    private func assertLiveCapture(voiceProcessing: Bool, name: String) async throws {
        try requireHardwareProbeOptIn()
        let session = RealtimeCallSession()
        session.setupStageForTesting = { stage in
            FileHandle.standardError.write(Data("Realtime capture setup: \(stage)\n".utf8))
        }
        session.configurationRecoveryEnabledForTesting = false
        session.voiceProcessingEnabledForTesting = voiceProcessing
        defer { session.stop() }
        defer { try? renderProof(session, name: name) }
        let granted = await AVAudioApplication.requestRecordPermission()
        XCTAssertTrue(granted, "Grant microphone access to the owned test simulator before running this test")
        guard granted else { return }
        let sent = expectation(description: "Production microphone pipeline emits a gateway PCM message")
        sent.assertForOverFulfill = false
        var packets = 0
        var diagnostics = 0
        session.outgoingMessageForTesting = { message in
            if RealtimeProtocol.event(Data(message.utf8))?["type"] as? String == "client.audio_diagnostics" {
                diagnostics += 1
            }
            guard Self.audioBytes(message) > 0 else { return }
            packets += 1
            sent.fulfill()
        }
        try session.receiveForTesting(["type": "session.ready", "conversationId": "capture-test", "protocolVersion": 2])
        await fulfillment(of: [sent], timeout: 10)
        XCTAssertGreaterThan(packets, 0, session.microphoneStartupDiagnostic)
        XCTAssertEqual(session.status, "Listening", session.microphoneStartupDiagnostic)
        XCTAssertNil(session.error, session.microphoneStartupDiagnostic)
        XCTAssertEqual(diagnostics, 0, "Older gateways must not receive optional diagnostic events")
    }

    func testEngineConfigurationChangeRecoversActualMicrophoneFrames() async throws {
        try requireHardwareProbeOptIn()
        let session = RealtimeCallSession()
        session.setupStageForTesting = { stage in
            FileHandle.standardError.write(Data("Realtime capture setup: \(stage)\n".utf8))
        }
        defer { session.stop() }
        defer { try? renderProof(session, name: "realtime-live-microphone-recovery") }
        let granted = await AVAudioApplication.requestRecordPermission()
        XCTAssertTrue(granted)
        guard granted else { return }
        let initial = expectation(description: "Initial microphone frames")
        initial.assertForOverFulfill = false
        var packets = 0
        session.outgoingMessageForTesting = { message in
            guard Self.audioBytes(message) > 0 else { return }
            packets += 1
            initial.fulfill()
        }
        try session.receiveForTesting([
            "type": "session.ready", "conversationId": "capture-restart-test", "clientAudioDiagnostics": true, "protocolVersion": 2,
        ])
        await fulfillment(of: [initial], timeout: 10)
        guard packets > 0 else { XCTFail(session.microphoneStartupDiagnostic)
            return
        }
        let initialRestarts = session.captureCountersForTesting.restarts
        session.configurationRecoveryEnabledForTesting = false
        session.stopEngineForConfigurationTest()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(session.engineRunningForTesting, "The build-320 control stays stopped without configuration recovery")
        session.configurationRecoveryEnabledForTesting = true
        let resumed = expectation(description: "Microphone frames resume after configuration stops the engine")
        resumed.assertForOverFulfill = false
        session.outgoingMessageForTesting = { message in
            guard Self.audioBytes(message) > 0 else { return }
            resumed.fulfill()
        }
        session.stopEngineForConfigurationTest()
        await fulfillment(of: [resumed], timeout: 10)
        XCTAssertNil(session.error, session.microphoneStartupDiagnostic)
        XCTAssertEqual(session.captureCountersForTesting.restarts, initialRestarts + 1, session.microphoneStartupDiagnostic)
    }

    private func requireHardwareProbeOptIn() throws {
        struct Configuration: Decodable { let enabled: Bool }
        let file = URL(fileURLWithPath: "/tmp/omnesis-ios-audio-capture-test.json")
        guard let data = try? Data(contentsOf: file),
              let configuration = try? JSONDecoder().decode(Configuration.self, from: data), configuration.enabled else {
            throw XCTSkip("Live microphone tests require the explicit local audio-capture test fixture")
        }
    }

    private func renderProof(_ session: RealtimeCallSession, name: String) throws {
        let view = RealtimeCallView(pairing: nil, session: session)
            .environment(AppStore.preview())
            .frame(width: 393, height: 852)
        let renderer = ImageRenderer(content: view)
        let image = try XCTUnwrap(renderer.uiImage)
        let data = try XCTUnwrap(image.pngData())
        let directory = URL(fileURLWithPath: "/tmp/omnesis-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: directory.appendingPathComponent("\(name).png"))
    }

    private static func audioBytes(_ message: String) -> Int {
        guard let event = RealtimeProtocol.event(Data(message.utf8)),
              event["type"] as? String == "input_audio_buffer.append",
              let encoded = event["audio"] as? String,
              let data = Data(base64Encoded: encoded), data.count.isMultiple(of: 2) else { return 0 }
        return data.count
    }
}
#endif
