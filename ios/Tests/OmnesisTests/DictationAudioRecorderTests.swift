// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AVFoundation
@testable import Omnesis
import XCTest

/// The Tell Omnesis capture recorder, fed synthetic microphone buffers: it
/// produces a readable mono AAC `.m4a` from any input, keeps nothing that
/// would cover only part of the note, and leaves nothing behind when
/// discarded or when nothing was recorded.
final class DictationAudioRecorderTests: XCTestCase {
    private let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("dictation-recorder-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// 0.1 s of a quiet tone on every channel, the shape the input tap
    /// delivers.
    private func buffer(seconds: Double = 0.1, format: AVAudioFormat? = nil) -> AVAudioPCMBuffer {
        let format = format ?? self.format
        let frames = AVAudioFrameCount(format.sampleRate * seconds)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        for channel in 0 ..< Int(format.channelCount) {
            let samples = buffer.floatChannelData![channel]
            for frame in 0 ..< Int(frames) {
                samples[frame] = 0.1 * sin(Float(frame) * 2 * .pi * 440 / Float(format.sampleRate))
            }
        }
        return buffer
    }

    /// Records one second from `input` and returns the file's format and
    /// duration.
    private func recordOneSecond(from input: AVAudioFormat) throws -> (AVAudioFormat, Double) {
        let recorder = DictationAudioRecorder(maxAudioBytes: 25 * 1024 * 1024, directory: directory)
        for _ in 0 ..< 10 {
            recorder.append(buffer(format: input))
        }
        let url = try XCTUnwrap(recorder.finish())
        let file = try AVAudioFile(forReading: url)
        return (file.fileFormat, Double(file.length) / file.fileFormat.sampleRate)
    }

    func testFinishHandsOverAReadableRecording() throws {
        let recorder = DictationAudioRecorder(maxAudioBytes: 25 * 1024 * 1024, directory: directory)
        for _ in 0 ..< 10 {
            recorder.append(buffer())
        }

        let url = try XCTUnwrap(recorder.finish())

        XCTAssertEqual(url.pathExtension, "m4a")
        let size = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int)
        XCTAssertGreaterThan(size, 0)
        let file = try AVAudioFile(forReading: url)
        XCTAssertEqual(file.fileFormat.settings[AVFormatIDKey] as? UInt32, kAudioFormatMPEG4AAC)
        XCTAssertGreaterThan(Double(file.length) / file.fileFormat.sampleRate, 0.5)
    }

    /// A recording past the gateway's limit would cover only part of the
    /// note, so it is not kept at all.
    func testARecordingOverTheLimitIsNotKept() {
        // 0.9 s of audio at 64 kbps.
        let recorder = DictationAudioRecorder(maxAudioBytes: 8000, directory: directory)
        for _ in 0 ..< 30 {
            recorder.append(buffer())
        }

        XCTAssertNil(recorder.finish())
        XCTAssertFalse(FileManager.default.fileExists(atPath: recorder.url.path))
    }

    /// Every dictation run in a capture adds to one recording.
    func testRunsAddToOneRecording() throws {
        let recorder = DictationAudioRecorder(maxAudioBytes: 25 * 1024 * 1024, directory: directory)
        for _ in 0 ..< 5 {
            recorder.append(buffer())
        }
        for _ in 0 ..< 5 {
            recorder.append(buffer())
        }

        let url = try XCTUnwrap(recorder.finish())
        let seconds = try Double(AVAudioFile(forReading: url).length) / format.sampleRate
        XCTAssertGreaterThan(seconds, 0.8)
    }

    /// An input that changes format between runs (a headset connected
    /// mid-capture) leaves a recording that no longer matches the note.
    func testAFormatChangeMakesTheRecordingUnusable() throws {
        let recorder = DictationAudioRecorder(maxAudioBytes: 25 * 1024 * 1024, directory: directory)
        recorder.append(buffer())
        let headset = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 8000, channels: 1))
        recorder.append(buffer(format: headset))

        XCTAssertNil(recorder.finish())
    }

    /// A Bluetooth headset's narrowband input.
    func testNarrowbandInputIsRecordable() throws {
        let input = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 8000, channels: 1))
        let (fileFormat, seconds) = try recordOneSecond(from: input)
        XCTAssertEqual(fileFormat.sampleRate, 8000)
        XCTAssertEqual(fileFormat.channelCount, 1)
        XCTAssertGreaterThan(seconds, 0.5)
    }

    func testElevenKilohertzInputIsRecordable() throws {
        let input = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 11025, channels: 1))
        let (fileFormat, seconds) = try recordOneSecond(from: input)
        XCTAssertEqual(fileFormat.channelCount, 1)
        XCTAssertGreaterThan(seconds, 0.5)
    }

    func testStereoInputIsRecordedMono() throws {
        let input = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2))
        let (fileFormat, seconds) = try recordOneSecond(from: input)
        XCTAssertEqual(fileFormat.channelCount, 1)
        XCTAssertGreaterThan(seconds, 0.5)
    }

    func testMultichannelInputIsRecordedMono() throws {
        let layout = try XCTUnwrap(AVAudioChannelLayout(layoutTag: kAudioChannelLayoutTag_DiscreteInOrder | 4))
        let input = AVAudioFormat(standardFormatWithSampleRate: 48000, channelLayout: layout)
        let (fileFormat, seconds) = try recordOneSecond(from: input)
        XCTAssertEqual(fileFormat.channelCount, 1)
        XCTAssertGreaterThan(seconds, 0.5)
    }

    func testNothingRecordedLeavesNothingBehind() {
        let recorder = DictationAudioRecorder(maxAudioBytes: 1_000_000, directory: directory)

        XCTAssertNil(recorder.finish())
        XCTAssertFalse(FileManager.default.fileExists(atPath: recorder.url.path))
    }

    func testDiscardDeletesTheFile() {
        let recorder = DictationAudioRecorder(maxAudioBytes: 1_000_000, directory: directory)
        recorder.append(buffer())

        recorder.discard()

        XCTAssertFalse(FileManager.default.fileExists(atPath: recorder.url.path))
    }

    // MARK: - Format

    /// The encoder's offer decides: the preferred rate when it is there, the
    /// highest below it for a narrowband input.
    func testBitRateComesFromTheEncodersOffer() {
        XCTAssertEqual(DictationRecordingFormat.bitRate(choosingFrom: [32000, 48000, 64000, 96000]), 64000)
        XCTAssertEqual(DictationRecordingFormat.bitRate(choosingFrom: [8000, 12000, 16000, 20000, 24000]), 24000)
        XCTAssertEqual(DictationRecordingFormat.bitRate(choosingFrom: [96000, 128_000]), 96000)
        XCTAssertNil(DictationRecordingFormat.bitRate(choosingFrom: []))
    }

    func testRecordingsStopAtTheDurationCapOrUnderTheLimit() {
        XCTAssertEqual(
            DictationRecordingFormat.maxDuration(forMaxAudioBytes: 25 * 1024 * 1024, bitRate: 64000),
            DictationRecordingFormat.maxRecordingDuration
        )
        let seconds = DictationRecordingFormat.maxDuration(forMaxAudioBytes: 1_000_000, bitRate: 64000)
        XCTAssertLessThan(seconds * 64000 / 8, 1_000_000)
        XCTAssertEqual(DictationRecordingFormat.maxDuration(forMaxAudioBytes: 0, bitRate: 64000), 0)
    }
}
