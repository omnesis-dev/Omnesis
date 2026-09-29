// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(AVFoundation)
import AVFoundation

/// Writes the microphone's buffers to a temporary mono AAC `.m4a` for
/// gateway dictation, alongside the on-device recognizer that reads the same
/// buffers.
///
/// Whatever the input — a stereo or multichannel interface, an 8 kHz
/// Bluetooth headset — the file is mono at the input's sample rate, at a bit
/// rate the encoder offers for that rate: speech needs one channel, and
/// asking the encoder instead of assuming a rate keeps every input
/// recordable.
///
/// `append` runs on the audio engine's tap thread; `finish` and `discard` run
/// on the main thread once the tap is removed. A lock serializes them, so a
/// buffer delivered while the tap is being torn down is either written before
/// the file closes or dropped.
///
/// The recording stops growing at the duration `DictationRecordingFormat`
/// allows for the gateway's byte limit, and `onBudgetExhausted` fires once so
/// the owner can stop the session the way a user would.
final class DictationAudioRecorder: @unchecked Sendable {
    let url: URL
    private let lock = NSLock()
    private var file: AVAudioFile?
    /// Downmixes (and converts the sample format) when the input is not
    /// already mono deinterleaved float.
    private let converter: AVAudioConverter?
    private let monoFormat: AVAudioFormat
    private let maxFrames: AVAudioFramePosition
    private var framesWritten: AVAudioFramePosition = 0
    private var budgetSpent = false
    private var failed = false
    private let onBudgetExhausted: @Sendable () -> Void

    enum SetupError: Error {
        case unsupportedFormat
    }

    /// Throws when the encoder cannot be set up for `format`; the session
    /// then records nothing and keeps the on-device text.
    init(
        format: AVAudioFormat,
        maxAudioBytes: Int,
        directory: URL = FileManager.default.temporaryDirectory,
        onBudgetExhausted: @escaping @Sendable () -> Void
    ) throws {
        guard format.sampleRate > 0,
              let mono = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: format.sampleRate,
                  channels: 1,
                  interleaved: false
              )
        else {
            throw SetupError.unsupportedFormat
        }
        monoFormat = mono
        if format == mono {
            converter = nil
        } else {
            guard let converter = AVAudioConverter(from: format, to: mono) else {
                throw SetupError.unsupportedFormat
            }
            converter.downmix = true
            self.converter = converter
        }
        url = directory.appendingPathComponent(
            "omnesis-dictation-\(UUID().uuidString).\(DictationRecordingFormat.fileExtension)"
        )
        guard let bitRate = DictationRecordingFormat.bitRate(
            choosingFrom: Self.encoderBitRates(sampleRate: format.sampleRate)
        ) else {
            throw SetupError.unsupportedFormat
        }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: bitRate,
        ]
        do {
            file = try AVAudioFile(
                forWriting: url,
                settings: settings,
                commonFormat: .pcmFormatFloat32,
                interleaved: false
            )
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        maxFrames = AVAudioFramePosition(
            DictationRecordingFormat.maxDuration(forMaxAudioBytes: maxAudioBytes, bitRate: bitRate)
                * format.sampleRate
        )
        self.onBudgetExhausted = onBudgetExhausted
    }

    /// Tap thread. Writes one buffer unless the budget is spent or a write
    /// already failed.
    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        guard let file, !budgetSpent, !failed else {
            lock.unlock()
            return
        }
        do {
            let mono = try monoBuffer(from: buffer)
            try file.write(from: mono)
            framesWritten += AVAudioFramePosition(mono.frameLength)
        } catch {
            failed = true
        }
        let exhaustedNow = !failed && framesWritten >= maxFrames
        if exhaustedNow { budgetSpent = true }
        lock.unlock()
        if exhaustedNow { onBudgetExhausted() }
    }

    /// Closes the file and hands it over, or deletes it and returns nil when
    /// nothing usable was recorded.
    func finish() -> URL? {
        lock.lock()
        let usable = file != nil && !failed && framesWritten > 0
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

    private func monoBuffer(from buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        guard let converter else { return buffer }
        guard let mono = AVAudioPCMBuffer(pcmFormat: monoFormat, frameCapacity: buffer.frameLength) else {
            throw SetupError.unsupportedFormat
        }
        try converter.convert(to: mono, from: buffer)
        return mono
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
