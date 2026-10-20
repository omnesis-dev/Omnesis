// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import AVFoundation
import SwiftUI

@MainActor
@Observable
final class RealtimeCallSession {
    struct Tool: Identifiable {
        let id: String
        let name: String
        var finished = false
    }

    var status = "Connecting…"
    var transcript = ""
    var tools: [Tool] = []
    var muted = false
    var error: Error?
    var connected = false
    var conversationID: String?
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var receiver: Task<Void, Never>?
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var player: AVAudioPlayerNode?
    @ObservationIgnored private var captureMixer: AVAudioMixerNode?
    @ObservationIgnored private var captureReadiness = RealtimeCaptureReadiness()
    @ObservationIgnored private let log = AppLog.make(category: "agent.realtime")
    @ObservationIgnored private var timeout: Task<Void, Never>?
    @ObservationIgnored private var itemID: String?
    @ObservationIgnored private var assistantTranscriptStarted = false
    @ObservationIgnored private var playedFrames: Int64 = 0
    @ObservationIgnored private var playbackStarted: Date?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var playbackGeneration = UUID()
    @ObservationIgnored private var pendingSends = 0
    @ObservationIgnored private var pendingFrames: Int64 = 0
    @ObservationIgnored private var audioObservers: [NSObjectProtocol] = []

    func start(pairing: Pairing, conversationID: String? = nil) async {
        guard receiver == nil else { return }
        generation = UUID()
        let callGeneration = generation
        transcript = ""
        tools = []
        assistantTranscriptStarted = false
        status = "Connecting…"
        let granted = await AVAudioApplication.requestRecordPermission()
        guard !Task.isCancelled, generation == callGeneration else { return }
        guard granted else {
            error = NSError(
                domain: "RealtimeCall",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Allow microphone access in Settings to talk to Omnesis."]
            )
            status = "Microphone access needed"
            return
        }
        do {
            guard let url = RealtimeProtocol.socketURL(pairing.url, conversationID: conversationID) else { throw URLError(.badURL) }
            var request = URLRequest(url: url)
            request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
            let socket = OmnesisURLSession.shared.webSocketTask(with: request)
            self.socket = socket
            socket.resume()
            timeout = Task { [weak self] in
                try? await Task.sleep(for: .seconds(25))
                guard !Task.isCancelled, let self, !connected else { return }
                fail(URLError(.timedOut))
            }
            audioObservers = [
                NotificationCenter.default
                    .addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
                        Task { @MainActor in self?.fail(URLError(.cancelled)) }
                    },
                NotificationCenter.default
                    .addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
                        guard let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                              reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
                        Task { @MainActor in self?.fail(URLError(.networkConnectionLost)) }
                    },
            ]
            receiver = Task { [weak self] in
                do {
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        let data: Data
                        switch message {
                        case .data(let value): data = value
                        case .string(let value): data = Data(value.utf8)
                        @unknown default: continue
                        }
                        guard let event = RealtimeProtocol.event(data) else { continue }
                        guard self?.generation == callGeneration else { return }
                        try self?.receive(event)
                    }
                } catch {
                    guard !Task.isCancelled, self?.generation == callGeneration else { return }
                    self?.fail(error)
                }
            }
        } catch { fail(error) }
    }

    private func beginAudio() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        input.isVoiceProcessingInputMuted = false
        let inputFormat = input.outputFormat(forBus: 0)
        log
            .info(
                "Input rate=\(inputFormat.sampleRate, privacy: .public) channels=\(inputFormat.channelCount, privacy: .public) voiceProcessing=\(input.isVoiceProcessingEnabled, privacy: .public)"
            )
        let encoder = try RealtimePCMEncoder(inputFormat: inputFormat)
        captureMixer = RealtimeAudioGraph.connectCapture(input, format: inputFormat, engine: engine)
        let player = AVAudioPlayerNode()
        self.player = player
        engine.attach(player)
        let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        let captureGeneration = generation
        input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            do {
                guard let data = try encoder.encode(buffer) else { return }
                Task { @MainActor [weak self] in
                    guard let self, generation == captureGeneration, connected else { return }
                    if captureReadiness.receivePCMFrame(byteCount: data.count) {
                        timeout?.cancel()
                        status = "Listening"
                        log.info("Realtime microphone is delivering PCM frames")
                    }
                    guard !muted else { return }
                    send(RealtimeProtocol.audioAppend(data))
                }
            } catch {
                Task { @MainActor [weak self] in
                    guard let self, generation == captureGeneration else { return }
                    log.error("Realtime microphone conversion failed")
                    fail(error)
                }
            }
        }

        engine.prepare()
        try engine.start()
        player.play()
        log.info("Realtime audio engine started; waiting for microphone frames")
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled, let self, generation == captureGeneration, !captureReadiness.isReady else { return }
            log.error("Realtime microphone produced no frames before startup timeout")
            fail(NSError(
                domain: "RealtimeCall",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "The microphone did not start. End the call and try again."]
            ))
        }
    }

    private func receive(_ event: [String: Any]) throws {
        switch event["type"] as? String {
        case "session.ready":
            guard !connected else { return }
            self.conversationID = event["conversationId"] as? String ?? conversationID
            timeout?.cancel()
            try beginAudio()
            connected = true
            status = "Starting microphone…"
        case "input_audio_buffer.speech_started":
            interruptPlayback()
            transcript = ""
            assistantTranscriptStarted = false
            status = "Listening"
        case "input_audio_buffer.speech_stopped": status = "Thinking…"
        case "response.output_audio.delta":
            if let encoded = event["delta"] as? String, let data = Data(base64Encoded: encoded) {
                itemID = event["item_id"] as? String
                play(data)
                status = "Speaking"
            }
        case "response.output_audio_transcript.delta":
            if !assistantTranscriptStarted { transcript = ""
                assistantTranscriptStarted = true
            }
            transcript += event["delta"] as? String ?? ""
        case "conversation.item.input_audio_transcription.completed":
            if !assistantTranscriptStarted { transcript = event["transcript"] as? String ?? "" }
        case "response.done":
            // Playback can outlast the server response; its completion updates the label.
            if playbackStarted == nil { status = "Listening" }
        case "tool.start", "tool.end": receiveTool(event)
        case "error":
            let message = (event["error"] as? [String: Any])?["message"] as? String ?? "The voice conversation could not continue."
            throw NSError(domain: "RealtimeCall", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
        default: break
        }
    }

    private func receiveTool(_ event: [String: Any]) {
        guard let id = event["id"] as? String else { return }
        if event["type"] as? String == "tool.start", let name = event["name"] as? String {
            tools.append(Tool(id: id, name: name))
            if tools.count > 5 { tools.removeFirst() }
        } else if let index = tools.firstIndex(where: { $0.id == id }) {
            tools[index].finished = true
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(5))
                self?.tools.removeAll { $0.id == id }
            }
        }
    }

    private func play(_ data: Data) {
        guard pendingFrames + Int64(data.count / 2) <= 24000 * 30 else {
            fail(NSError(
                domain: "RealtimeCall",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "Voice playback could not keep up. Please reconnect."]
            ))
            return
        }
        guard data.count.isMultiple(of: 2), !data.isEmpty,
              let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(data.count / 2)),
              let channel = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = buffer.frameCapacity
        data.withUnsafeBytes { raw in
            for index in 0 ..< Int(buffer.frameLength) {
                let sample = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
                channel[index] = Float(sample) / 32768
            }
        }
        if playbackStarted == nil { playbackStarted = Date()
            playedFrames = 0
        }
        playedFrames += Int64(buffer.frameLength)
        pendingFrames += Int64(buffer.frameLength)
        let totalFrames = playedFrames
        let frameCount = Int64(buffer.frameLength)
        let audioGeneration = playbackGeneration
        player?.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, playbackGeneration == audioGeneration else { return }
                pendingFrames = max(0, pendingFrames - frameCount)
                guard playedFrames == totalFrames else { return }
                playbackStarted = nil
                if connected { status = "Listening" }
            }
        }
    }

    private func interruptPlayback() {
        playbackGeneration = UUID()
        if let itemID, let playbackStarted {
            let elapsed = max(0, Int(Date().timeIntervalSince(playbackStarted) * 1000))
            send([
                "type": "conversation.item.truncate",
                "item_id": itemID,
                "content_index": 0,
                "audio_end_ms": min(elapsed, Int(playedFrames * 1000 / 24000)),
            ])
        }
        player?.stop()
        player?.play()
        playbackStarted = nil
        playedFrames = 0
        pendingFrames = 0
        itemID = nil
    }

    func toggleMute() {
        muted.toggle()
        if muted { send(["type": "input_audio_buffer.clear"]) }
    }

    private func send(_ event: [String: Any]) {
        guard let socket, let data = try? JSONSerialization.data(withJSONObject: event),
              let text = String(data: data, encoding: .utf8) else { return }
        guard pendingSends < 8 else {
            fail(URLError(.networkConnectionLost))
            return
        }
        pendingSends += 1
        let sendGeneration = generation
        socket.send(.string(text)) { [weak self] error in
            Task { @MainActor in
                guard let self, self.generation == sendGeneration else { return }
                self.pendingSends -= 1
                if let error { self.fail(error) }
            }
        }
    }

    private func fail(_ error: Error) {
        stop()
        self.error = error
        status = "Call ended"
    }

    func stop() {
        generation = UUID()
        playbackGeneration = UUID()
        audioObservers.forEach { NotificationCenter.default.removeObserver($0) }
        audioObservers = []
        pendingSends = 0
        pendingFrames = 0
        playbackStarted = nil
        connected = false
        captureReadiness = RealtimeCaptureReadiness()
        timeout?.cancel()
        receiver?.cancel()
        receiver = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        player?.stop()
        engine = nil
        player = nil
        captureMixer = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
#endif
