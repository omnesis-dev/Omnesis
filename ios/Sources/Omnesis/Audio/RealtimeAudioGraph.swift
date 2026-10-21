// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(AVFoundation)
import AVFoundation

/// Keep microphone input in the rendered graph without playing it through the speaker.
enum RealtimeAudioGraph {
    static func connect(
        input: AVAudioNode, inputFormat: AVAudioFormat,
        playback: AVAudioNode, playbackFormat: AVAudioFormat, engine: AVAudioEngine
    )
        -> AVAudioMixerNode {
        let capture = AVAudioMixerNode()
        engine.attach(capture)
        engine.connect(input, to: capture, format: inputFormat)
        engine.connect(capture, to: engine.mainMixerNode, format: inputFormat)
        engine.connect(playback, to: engine.mainMixerNode, format: playbackFormat)
        connectOutput(format: inputFormat, engine: engine)
        capture.outputVolume = 0
        return capture
    }

    /// Voice Processing I/O requires identical input-node output and output-node input formats.
    static func connectOutput(format: AVAudioFormat, engine: AVAudioEngine) {
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: format)
    }
}

/// Input hardware can run at a different rate from the gateway's mono PCM16 stream.
final class RealtimePCMEncoder {
    private let converter: AVAudioConverter
    private let wireFormat: AVAudioFormat
    private let inputRate: Double
    private(set) var lastStatus = "not-run"

    init(inputFormat: AVAudioFormat) throws {
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: inputFormat, to: format) else {
            throw URLError(.cannotDecodeContentData)
        }
        self.converter = converter
        self.wireFormat = format
        self.inputRate = inputFormat.sampleRate
    }

    func encode(_ buffer: AVAudioPCMBuffer) throws -> Data? {
        guard buffer.frameLength > 0 else { lastStatus = "empty-input"
            return nil
        }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 24000 / inputRate) + 1
        guard let converted = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else {
            throw URLError(.cannotDecodeContentData)
        }
        var provided = false
        var conversionError: NSError?
        let status = converter.convert(to: converted, error: &conversionError) { _, state in
            if provided { state.pointee = .noDataNow
                return nil
            }
            provided = true
            state.pointee = .haveData
            return buffer
        }
        switch status {
        case .haveData: lastStatus = "have-data"
        case .inputRanDry: lastStatus = "input-ran-dry"
        case .endOfStream: lastStatus = "end-of-stream"
        case .error: lastStatus = "error"
        @unknown default: lastStatus = "unknown"
        }
        if let conversionError { throw conversionError }
        guard converted.frameLength > 0 else { return nil }
        guard let samples = converted.int16ChannelData else {
            lastStatus = "missing-pcm16-storage"
            throw URLError(.cannotDecodeContentData)
        }
        return Data(bytes: samples[0], count: Int(converted.frameLength) * 2)
    }
}
#endif
