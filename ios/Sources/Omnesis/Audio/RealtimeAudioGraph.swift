// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(AVFoundation)
import AVFoundation

/// Keep microphone input in the rendered graph without playing it through the speaker.
enum RealtimeAudioGraph {
    static func connectCapture(_ input: AVAudioNode, format: AVAudioFormat, engine: AVAudioEngine) -> AVAudioMixerNode {
        let capture = AVAudioMixerNode()
        engine.attach(capture)
        engine.connect(input, to: capture, format: format)
        engine.connect(capture, to: engine.mainMixerNode, format: format)
        capture.outputVolume = 0
        return capture
    }
}

/// Input hardware can run at a different rate from the gateway's mono PCM16 stream.
final class RealtimePCMEncoder {
    private let converter: AVAudioConverter
    private let wireFormat: AVAudioFormat
    private let inputRate: Double

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
        guard buffer.frameLength > 0 else { return nil }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 24000 / inputRate) + 1
        guard let converted = AVAudioPCMBuffer(pcmFormat: wireFormat, frameCapacity: capacity) else {
            throw URLError(.cannotDecodeContentData)
        }
        var provided = false
        var conversionError: NSError?
        converter.convert(to: converted, error: &conversionError) { _, state in
            if provided { state.pointee = .noDataNow
                return nil
            }
            provided = true
            state.pointee = .haveData
            return buffer
        }
        if let conversionError { throw conversionError }
        guard converted.frameLength > 0, let samples = converted.int16ChannelData else { return nil }
        return Data(bytes: samples[0], count: Int(converted.frameLength) * 2)
    }
}
#endif
