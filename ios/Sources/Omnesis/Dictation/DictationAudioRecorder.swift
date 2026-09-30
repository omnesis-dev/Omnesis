// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How a Tell Omnesis recording is encoded for gateway transcription: mono
/// AAC in an MPEG-4 container at a fixed bit rate, which makes its size
/// predictable enough to stay under the gateway's byte limit.
public enum DictationRecordingFormat {
    public static let contentType = "audio/mp4"
    public static let fileExtension = "m4a"
    /// Ample for speech.
    static let preferredBitRate = 64000
    /// The longest recording kept for the gateway. A longer capture is saved
    /// with the phone's transcript alone.
    public static let maxRecordingDuration: TimeInterval = 5 * 60
    /// Share of the byte limit a recording may fill. The rest covers the
    /// container and the encoder's drift from its nominal rate.
    static let budgetShare = 0.9

    /// The bit rate for a mono recording, from the rates the AAC encoder
    /// offers at the input's sample rate: the preferred rate or the highest
    /// below it. Narrowband inputs, such as an 8 kHz Bluetooth headset, top
    /// out far lower. Nil when the encoder offers none.
    public static func bitRate(choosingFrom applicable: [Int]) -> Int? {
        applicable.filter { $0 <= preferredBitRate }.max() ?? applicable.min()
    }

    /// The longest recording that stays under `maxAudioBytes` at `bitRate`,
    /// and under `maxRecordingDuration`.
    public static func maxDuration(forMaxAudioBytes maxAudioBytes: Int, bitRate: Int) -> TimeInterval {
        guard maxAudioBytes > 0, bitRate > 0 else { return 0 }
        return min(maxRecordingDuration, Double(maxAudioBytes) * budgetShare / (Double(bitRate) / 8))
    }
}

#if canImport(AVFoundation)
import AVFoundation

/// Receives the microphone's buffers alongside the on-device recognizer.
protocol DictationAudioSink: AnyObject, Sendable {
    func append(_ buffer: AVAudioPCMBuffer)
}

/// Records what is dictated in one Tell Omnesis capture to a temporary mono
/// AAC `.m4a`, for the gateway to transcribe once the note is saved. Every
/// dictation run in the capture appends to the same file, so the recording
/// covers the whole note.
///
/// The file is set up from the first buffer's format. Whatever the input — a
/// stereo or multichannel interface, an 8 kHz Bluetooth headset — the file is
/// mono at that sample rate, at a bit rate the encoder offers for it. A
/// recording that cannot be written, changes format between runs, or grows
/// past the gateway's limit is unusable: the note is then saved with the
/// phone's transcript alone, never with audio that covers only part of it.
///
/// `append` runs on the audio engine's tap thread; `finish` and `discard` run
/// on the main thread. A lock serializes them.
final class DictationAudioRecorder: DictationAudioSink, @unchecked Sendable {
    let url: URL
    private let maxAudioBytes: Int
    private let lock = NSLock()
    private var file: AVAudioFile?
    /// Downmixes (and converts the sample format) when the input is not
    /// already mono deinterleaved float.
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private var monoFormat: AVAudioFormat?
    private var maxFrames: AVAudioFramePosition = 0
    private var framesWritten: AVAudioFramePosition = 0
    private var unusable = false

    enum SetupError: Error {
        case unsupportedFormat
    }

    init(maxAudioBytes: Int, directory: URL = FileManager.default.temporaryDirectory) {
        self.maxAudioBytes = maxAudioBytes
        url = directory.appendingPathComponent(
            "omnesis-dictation-\(UUID().uuidString).\(DictationRecordingFormat.fileExtension)"
        )
    }

    /// Tap thread. Writes one buffer, setting the file up on the first.
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard !unusable else { return }
        do {
            if file == nil { try open(for: buffer.format) }
            guard let file, buffer.format == inputFormat else { throw SetupError.unsupportedFormat }
            let mono = try monoBuffer(from: buffer)
            try file.write(from: mono)
            framesWritten += AVAudioFramePosition(mono.frameLength)
            if framesWritten > maxFrames { unusable = true }
        } catch {
            unusable = true
        }
    }

    /// Closes the file and hands it over, or deletes it and returns nil when
    /// the recording is unusable or empty.
    func finish() -> URL? {
        lock.lock()
        let usable = file != nil && !unusable && framesWritten > 0
        closeFile()
        lock.unlock()
        guard usable else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }
        return url
    }

    /// Closes and deletes the file.
    func discard() {
        lock.lock()
        closeFile()
        lock.unlock()
        try? FileManager.default.removeItem(at: url)
    }

    /// Called with the lock held.
    private func open(for format: AVAudioFormat) throws {
        guard format.sampleRate > 0,
              let mono = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: format.sampleRate,
                  channels: 1,
                  interleaved: false
              ),
              let bitRate = DictationRecordingFormat.bitRate(
                  choosingFrom: Self.encoderBitRates(sampleRate: format.sampleRate)
              )
        else {
            throw SetupError.unsupportedFormat
        }
        if format != mono {
            guard let converter = AVAudioConverter(from: format, to: mono) else { throw SetupError.unsupportedFormat }
            converter.downmix = true
            self.converter = converter
        }
        file = try AVAudioFile(
            forWriting: url,
            settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: format.sampleRate,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: bitRate,
            ],
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )
        inputFormat = format
        monoFormat = mono
        maxFrames = AVAudioFramePosition(
            DictationRecordingFormat.maxDuration(forMaxAudioBytes: maxAudioBytes, bitRate: bitRate) * format.sampleRate
        )
    }

    private func monoBuffer(from buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        guard let converter else { return buffer }
        guard let monoFormat,
              let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: buffer.frameLength)
        else { throw SetupError.unsupportedFormat }
        try converter.convert(to: mono, from: buffer)
        return mono
    }

    /// The bit rates the system's AAC encoder accepts for mono audio at
    /// `sampleRate`.
    private static func encoderBitRates(sampleRate: Double) -> [Int] {
        var description = AudioStreamBasicDescription(
            mSampleRate: sampleRate,
            mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 1024,
            mBytesPerFrame: 0,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 0,
            mReserved: 0
        )
        guard let pcm = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1),
              let aac = AVAudioFormat(streamDescription: &description),
              let encoder = AVAudioConverter(from: pcm, to: aac)
        else { return [] }
        return encoder.applicableEncodeBitRates?.map(\.intValue) ?? []
    }

    /// Flushes the encoder and releases the file. Called with the lock held.
    /// Releasing the last reference closes it on systems without `close()`.
    private func closeFile() {
        if #available(iOS 18.0, macOS 15.0, *) {
            file?.close()
        }
        file = nil
    }
}
#endif
