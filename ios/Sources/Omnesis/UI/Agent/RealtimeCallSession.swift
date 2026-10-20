// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import AVFoundation
import SwiftUI

@MainActor
@Observable
final class RealtimeCallSession {
    var status = "Connecting…"
    var transcript = ""
    var muted = false
    var error: Error?
    var connected = false
    var ending = false
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
    @ObservationIgnored private var clientAudioDiagnostics = false
    @ObservationIgnored private var configurationRestartAttempts = 0
    @ObservationIgnored private var captureInputFormat: AVAudioFormat?
    @ObservationIgnored private var captureDiagnostics = RealtimeCaptureDiagnostics()
    @ObservationIgnored private var audioObservers: [NSObjectProtocol] = []
    @ObservationIgnored private var endHandshake = RealtimeEndHandshake()

    func start(
        pairing: Pairing,
        conversationID: String? = nil,
        onReady: (@MainActor (String) async throws -> Void)? = nil
    ) async {
        guard receiver == nil, !ending else { return }
        generation = UUID()
        let callGeneration = generation
        captureDiagnostics = RealtimeCaptureDiagnostics()
        transcript = ""
        assistantTranscriptStarted = false
        status = "Connecting…"
        let granted = await AVAudioApplication.requestRecordPermission()
        guard acceptMicrophonePermission(granted, callGeneration: callGeneration) else { return }
        do {
            guard let request = RealtimeProtocol.socketRequest(pairing: pairing, conversationID: conversationID) else {
                throw URLError(.badURL)
            }
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
                        guard self?.isCurrentCall(callGeneration) == true else { return }
                        try await self?.prepareConversation(event, onReady: onReady)
                        guard self?.isCurrentCall(callGeneration) == true else { return }
                        try self?.receive(event)
                    }
                } catch {
                    guard self?.isCurrentCall(callGeneration) == true else { return }
                    self?.fail(error)
                }
            }
        } catch { fail(error) }
    }

    private func isCurrentCall(_ id: UUID) -> Bool {
        !Task.isCancelled && generation == id
    }

    private func acceptMicrophonePermission(_ granted: Bool, callGeneration: UUID) -> Bool {
        guard isCurrentCall(callGeneration) else { return false }
        guard granted else {
            error = NSError(
                domain: "RealtimeCall",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Allow microphone access in Settings to talk to Omnesis."]
            )
            status = "Microphone access needed"
            return false
        }
        return true
    }

    private func prepareConversation(
        _ event: [String: Any],
        onReady: (@MainActor (String) async throws -> Void)?
    ) async throws {
        guard !ending else { return }
        guard event["type"] as? String == "session.ready" else { return }
        try RealtimeProtocol.validateReady(event)
        guard !connected, let onReady else { return }
        guard let id = event["conversationId"] as? String else { throw URLError(.badServerResponse) }
        conversationID = id
        try await onReady(id)
    }

    private func receive(_ event: [String: Any]) throws {
        if receiveWhileEnding(event) { return }
        switch event["type"] as? String {
        case "session.ready":
            try RealtimeProtocol.validateReady(event)
            guard !connected else { return }
            self.conversationID = event["conversationId"] as? String ?? conversationID
            clientAudioDiagnostics = event["clientAudioDiagnostics"] as? Bool == true
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
        case "error":
            let message = (event["error"] as? [String: Any])?["message"] as? String ?? "The voice conversation could not continue."
            throw NSError(domain: "RealtimeCall", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
        default: break
        }
    }

    private func receiveWhileEnding(_ event: [String: Any]) -> Bool {
        guard ending else { return false }
        if event["type"] as? String == "session.ended", event["conversationId"] as? String == conversationID {
            endHandshake.acknowledge(generation: generation)
        }
        return true
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
        if ending, event["type"] as? String != "session.end" { return }
        guard let data = try? JSONSerialization.data(withJSONObject: event),
              let text = String(data: data, encoding: .utf8) else { return }
        #if DEBUG
        if let outgoingMessageForTesting {
            if event["type"] as? String == "input_audio_buffer.append" { captureDiagnostics.sent() }
            outgoingMessageForTesting(text)
            return
        }
        #endif
        guard let socket else { return }
        guard pendingSends < 8 else {
            fail(URLError(.networkConnectionLost))
            return
        }
        pendingSends += 1
        if event["type"] as? String == "input_audio_buffer.append" { captureDiagnostics.sent() }
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
        if ending { endHandshake.cancel(generation: generation)
            return
        }
        stop()
        self.error = error
        status = "Call ended"
    }

    #if DEBUG
    @ObservationIgnored var outgoingMessageForTesting: ((String) -> Void)?
    @ObservationIgnored var configurationRecoveryEnabledForTesting = true
    @ObservationIgnored var voiceProcessingEnabledForTesting = true
    @ObservationIgnored var setupStageForTesting: ((String) -> Void)?

    func receiveForTesting(_ event: [String: Any]) throws {
        try receive(event)
    }

    var engineRunningForTesting: Bool {
        engine?.isRunning ?? false
    }

    var captureCountersForTesting: RealtimeCaptureDiagnostics.Snapshot {
        captureDiagnostics.snapshot
    }

    func stopEngineForConfigurationTest() {
        guard let engine else { return }
        engine.stop()
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)
    }
    #endif

    func end() async {
        guard socket != nil else { stop()
            return
        }
        let callGeneration = generation
        if !ending {
            ending = true
            status = "Ending call…"
            connected = false
            playbackGeneration = UUID()
            timeout?.cancel()
            stopAudio()
        }
        let outcome = await endHandshake.wait(generation: callGeneration) { send(["type": "session.end"]) }
        guard generation == callGeneration else { return }
        if outcome == .timedOut { log.warning("Realtime graceful close timed out; forcing transport cleanup") }
        stop()
    }

    func stop() {
        endHandshake.cancel(generation: generation)
        generation = UUID()
        playbackGeneration = UUID()
        pendingSends = 0
        pendingFrames = 0
        playbackStarted = nil
        connected = false
        ending = false
        captureReadiness = RealtimeCaptureReadiness()
        timeout?.cancel()
        receiver?.cancel()
        receiver = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        stopAudio()
    }

    private func stopAudio() {
        audioObservers.forEach { NotificationCenter.default.removeObserver($0) }
        audioObservers = []
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        player?.stop()
        engine = nil
        player = nil
        captureMixer = nil
        captureInputFormat = nil
        clientAudioDiagnostics = false
        configurationRestartAttempts = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

extension RealtimeCallSession {
    private func logSetupStage(_ stage: String) {
        log.info("Realtime audio setup: \(stage, privacy: .public)")
        #if DEBUG
        setupStageForTesting?(stage)
        #endif
    }

    private func beginAudio() throws {
        let session = AVAudioSession.sharedInstance()
        logSetupStage("configuring audio session")
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
        logSetupStage("activating audio session")
        try session.setActive(true)
        logSetupStage("creating audio engine")
        let engine = AVAudioEngine()
        self.engine = engine
        logSetupStage("acquiring input node")
        let input = engine.inputNode
        #if DEBUG
        let voiceProcessing = voiceProcessingEnabledForTesting
        #else
        let voiceProcessing = true
        #endif
        logSetupStage("configuring voice processing")
        try input.setVoiceProcessingEnabled(voiceProcessing)
        if voiceProcessing { input.isVoiceProcessingInputMuted = false }
        logSetupStage("voice processing configured")
        let inputFormat = input.outputFormat(forBus: 0)
        captureInputFormat = inputFormat
        let rate = inputFormat.sampleRate
        let channels = inputFormat.channelCount
        log.info("Input rate=\(rate, privacy: .public) channels=\(channels, privacy: .public)")
        log.info("Voice processing enabled=\(input.isVoiceProcessingEnabled, privacy: .public)")
        let encoder = try RealtimePCMEncoder(inputFormat: inputFormat)
        let player = AVAudioPlayerNode()
        self.player = player
        engine.attach(player)
        let playbackFormat = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
        captureMixer = RealtimeAudioGraph.connect(
            input: input, inputFormat: inputFormat, playback: player, playbackFormat: playbackFormat, engine: engine
        )
        let captureGeneration = generation
        audioObservers.append(NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self, weak engine] _ in
            Task { @MainActor [weak self, weak engine] in
                guard let self, let engine, generation == captureGeneration, self.engine === engine else { return }
                recoverAudioConfiguration(engine)
            }
        })
        installCaptureTap(input, format: inputFormat, encoder: encoder, generation: captureGeneration)

        logSetupStage("checking IO graph formats")
        let outputFormat = engine.outputNode.inputFormat(forBus: 0)
        let outputRate = outputFormat.sampleRate
        let outputChannels = outputFormat.channelCount
        let matchingFormats = input.outputFormat(forBus: 0).isEqual(outputFormat)
        log.info("Output rate=\(outputRate, privacy: .public) channels=\(outputChannels, privacy: .public)")
        log.info("Input and output IO formats match=\(matchingFormats, privacy: .public)")
        logSetupStage("preparing engine")
        engine.prepare()
        logSetupStage("starting engine")
        try engine.start()
        player.play()
        log.info("Realtime audio engine started; waiting for microphone frames")
        sendCaptureDiagnostic(stage: "starting")
        armCaptureStartupWatchdog(generation: captureGeneration)
    }

    private func armCaptureStartupWatchdog(generation captureGeneration: UUID) {
        timeout?.cancel()
        timeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, let self, generation == captureGeneration, !captureReadiness.isReady else { return }
            sendCaptureDiagnostic(stage: "starting")
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, generation == captureGeneration, !captureReadiness.isReady else { return }
            let detail = microphoneStartupDiagnostic
            log.error("Realtime microphone startup failed: \(detail, privacy: .public)")
            sendCaptureDiagnostic(stage: "timeout")
            fail(NSError(
                domain: "RealtimeCall",
                code: 4,
                userInfo: [NSLocalizedDescriptionKey: "The microphone did not start. End the call and try again."]
            ))
        }
    }

    private func installCaptureTap(
        _ input: AVAudioInputNode, format: AVAudioFormat, encoder: RealtimePCMEncoder, generation captureGeneration: UUID
    ) {
        let diagnostics = captureDiagnostics
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            let inputStamp = diagnostics.input(frames: Int(buffer.frameLength))
            if inputStamp.isFirst {
                Task { @MainActor [weak self] in
                    self?.log.info("Realtime hardware tap delivered its first buffer")
                }
            }
            do {
                let encoded = try encoder.encode(buffer)
                diagnostics.converted(hasData: encoded != nil, status: encoder.lastStatus)
                guard let data = encoded else { return }
                Task { @MainActor [weak self] in
                    guard let self, generation == captureGeneration, connected, diagnostics.isCurrent(inputStamp) else {
                        diagnostics.discarded()
                        return
                    }
                    configurationRestartAttempts = 0
                    let becameReady = captureReadiness.receivePCMFrame(byteCount: data.count)
                    if becameReady {
                        timeout?.cancel()
                        status = "Listening"
                        log.info("Realtime microphone is delivering PCM frames")
                    }
                    if !muted { send(RealtimeProtocol.audioAppend(data)) }
                    if becameReady { sendCaptureDiagnostic(stage: "ready") }
                }
            } catch {
                diagnostics.failedConversion()
                Task { @MainActor [weak self] in
                    guard let self, generation == captureGeneration else { return }
                    log.error("Realtime microphone conversion failed")
                    fail(error)
                }
            }
        }
    }

    var microphoneStartupDiagnostic: String {
        "engineRunning=\(engine?.isRunning ?? false) " + captureDiagnostics.snapshot.summary
    }

    private func recoverAudioConfiguration(_ engine: AVAudioEngine) {
        captureDiagnostics.configurationChanged()
        sendCaptureDiagnostic(stage: "configuration_changed")
        #if DEBUG
        guard configurationRecoveryEnabledForTesting else { return }
        #endif
        guard connected, !engine.isRunning else { return }
        let current = engine.inputNode.outputFormat(forBus: 0)
        let inputRate = current.sampleRate
        let outputRate = engine.outputNode.inputFormat(forBus: 0).sampleRate
        log.info("Audio configuration inputRate=\(inputRate, privacy: .public) outputRate=\(outputRate, privacy: .public)")
        guard current.sampleRate == captureInputFormat?.sampleRate,
              current.channelCount == captureInputFormat?.channelCount else {
            fail(URLError(.cannotDecodeContentData))
            return
        }
        guard configurationRestartAttempts < 3 else {
            fail(URLError(.cannotConnectToHost))
            return
        }
        configurationRestartAttempts += 1
        captureDiagnostics.advanceEpoch()
        do {
            RealtimeAudioGraph.connectOutput(format: current, engine: engine)
            captureMixer?.outputVolume = 0
            try engine.start()
            player?.play()
            captureDiagnostics.restarted()
            captureReadiness = RealtimeCaptureReadiness()
            status = "Starting microphone…"
            armCaptureStartupWatchdog(generation: generation)
            sendCaptureDiagnostic(stage: "configuration_changed")
            log.info("Realtime audio restarted after an engine configuration change")
        } catch { fail(error) }
    }

    private func sendCaptureDiagnostic(stage: String) {
        guard clientAudioDiagnostics else { return }
        let capture = captureDiagnostics.snapshot
        send([
            "type": "client.audio_diagnostics",
            "stage": stage,
            "rawBuffers": capture.inputBuffers,
            "pcmBuffers": capture.convertedPackets,
            "sentFrames": capture.sentPackets,
            "engineRunning": engine?.isRunning ?? false,
        ])
    }
}

#endif
