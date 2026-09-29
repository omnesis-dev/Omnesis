// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AVFoundation
@testable import Omnesis
import XCTest

/// The gateway-dictation recorder, fed synthetic microphone buffers: it
/// produces a readable AAC `.m4a`, stops at the byte budget exactly once, and
/// leaves nothing behind when discarded or when nothing was recorded.
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
        let recorder = try DictationAudioRecorder(format: input, maxAudioBytes: 25 * 1024 * 1024, directory: directory) {}
        for _ in 0 ..< 10 {
            recorder.append(buffer(format: input))
        }
        let url = try XCTUnwrap(recorder.finish())
        let file = try AVAudioFile(forReading: url)
        return (file.fileFormat, Double(file.length) / file.fileFormat.sampleRate)
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        var value: Int {
            lock.lock()
            defer { lock.unlock() }
            return count
        }

        func bump() {
            lock.lock()
            count += 1
            lock.unlock()
        }
    }

    func testFinishHandsOverAReadableRecording() throws {
        let recorder = try DictationAudioRecorder(
            format: format,
            maxAudioBytes: 25 * 1024 * 1024,
            directory: directory
        ) {}
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

    func testBudgetStopsTheRecordingOnce() throws {
        let exhausted = Counter()
        // 0.9 s of audio at 64 kbps.
        let recorder = try DictationAudioRecorder(
            format: format,
            maxAudioBytes: 8000,
            directory: directory
        ) {
            exhausted.bump()
        }
        for _ in 0 ..< 30 {
            recorder.append(buffer())
        }

        XCTAssertEqual(exhausted.value, 1)
        let url = try XCTUnwrap(recorder.finish())
        let seconds = try Double(AVAudioFile(forReading: url).length) / format.sampleRate
        XCTAssertLessThan(seconds, 1.5, "buffers after the budget are not written")
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

    func testNothingRecordedLeavesNothingBehind() throws {
        let recorder = try DictationAudioRecorder(format: format, maxAudioBytes: 1_000_000, directory: directory) {}

        XCTAssertNil(recorder.finish())
        XCTAssertFalse(FileManager.default.fileExists(atPath: recorder.url.path))
    }

    func testDiscardDeletesTheFile() throws {
        let recorder = try DictationAudioRecorder(format: format, maxAudioBytes: 1_000_000, directory: directory) {}
        recorder.append(buffer())

        recorder.discard()

        XCTAssertFalse(FileManager.default.fileExists(atPath: recorder.url.path))
    }
}
