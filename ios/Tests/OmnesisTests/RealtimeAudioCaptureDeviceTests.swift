// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(UIKit)
import AVFoundation
import Foundation
@testable import Omnesis
import SwiftUI
import UIKit
import XCTest

/// Hardware-backed capture; no model inference and no audio content is retained or printed.
@MainActor
final class RealtimeAudioCaptureDeviceTests: XCTestCase {
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
        try session.receiveForTesting(["type": "session.ready", "conversationId": "capture-test"])
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
        try session.receiveForTesting(["type": "session.ready", "conversationId": "capture-restart-test", "clientAudioDiagnostics": true])
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
        let renderer = ImageRenderer(content: RealtimeCallView(pairing: nil, session: session).frame(width: 393, height: 852))
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
