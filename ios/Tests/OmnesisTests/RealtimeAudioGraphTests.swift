// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(AVFoundation)
import AVFoundation
import Foundation
@testable import Omnesis
import XCTest

final class RealtimeAudioGraphTests: XCTestCase {
    func testCaptureBranchIsRenderedWithoutEchoingMicrophoneToSpeaker() throws {
        let engine = AVAudioEngine()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1))
        let microphone = constantSource(value: 0.25)
        let assistant = constantSource(value: 0.5)
        engine.attach(microphone)
        engine.attach(assistant)
        let playbackFormat = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1))
        // A stale output client format must be replaced with the microphone's format.
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: playbackFormat)
        XCTAssertFalse(engine.outputNode.inputFormat(forBus: 0).isEqual(format))
        let capture = RealtimeAudioGraph.connect(
            input: microphone, inputFormat: format, playback: assistant, playbackFormat: playbackFormat, engine: engine
        )
        XCTAssertTrue(engine.outputNode.inputFormat(forBus: 0).isEqual(microphone.outputFormat(forBus: 0)))
        let captured = expectation(description: "Microphone branch delivers samples while output renders")
        captured.assertForOverFulfill = false
        microphone.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            guard let samples = buffer.floatChannelData, buffer.frameLength > 0,
                  abs(samples[0][0] - 0.25) < 0.001 else { return }
            captured.fulfill()
        }
        defer { microphone.removeTap(onBus: 0)
            engine.stop()
        }
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)
        try engine.start()
        let output = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096))
        for _ in 0 ..< 8 {
            XCTAssertEqual(try engine.renderOffline(4096, to: output), .success)
        }
        wait(for: [captured], timeout: 2)
        XCTAssertEqual(capture.outputVolume, 0)
        let samples = try XCTUnwrap(output.floatChannelData)
        // The assistant remains audible; the captured microphone isn't mixed back into it.
        XCTAssertEqual(samples[0][Int(output.frameLength) - 1], 0.5, accuracy: 0.001)
    }

    func testHardwareFloatPCMIsConvertedToNonemptyMono24kPCM16() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2))
        let encoder = try RealtimePCMEncoder(inputFormat: format)
        let input = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800))
        input.frameLength = 4800
        let samples = try XCTUnwrap(input.floatChannelData)
        for channel in 0 ..< 2 {
            for frame in 0 ..< 4800 {
                samples[channel][frame] = 0.25
            }
        }
        let data = try XCTUnwrap(encoder.encode(input))
        XCTAssertGreaterThan(data.count, 4000)
        XCTAssertLessThanOrEqual(data.count, 4802)
        XCTAssertTrue(data.count.isMultiple(of: 2))
        let sample = data.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: data.count - 2, as: Int16.self) }
        XCTAssertEqual(Int16(littleEndian: sample), 8192, accuracy: 2)
    }

    func testEmptyHardwareBufferNeverProducesAnEmptyGatewayFrame() throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1))
        let encoder = try RealtimePCMEncoder(inputFormat: format)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024))
        XCTAssertNil(try encoder.encode(buffer))
    }

    private func constantSource(value: Float) -> AVAudioSourceNode {
        AVAudioSourceNode { _, _, frames, list in
            for buffer in UnsafeMutableAudioBufferListPointer(list) {
                guard let data = buffer.mData else { continue }
                let samples = data.assumingMemoryBound(to: Float.self)
                for frame in 0 ..< Int(frames) {
                    samples[frame] = value
                }
            }
            return noErr
        }
    }
}
#endif
