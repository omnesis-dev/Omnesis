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
    var playbackNotice: String?
    private(set) var userSpeechActive = false
    var muted = false
    var error: Error?
    var replyFailure: RealtimeCallFailure?
    var connected = false
    var ending = false
    var conversationID: String?
    var liveCaptions: [LiveVoiceCaption] = []
    var isLive = false
    @ObservationIgnored private var liveSession: LiveVoiceSession?
    @ObservationIgnored private var starting = false
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var receiver: Task<Void, Never>?
    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var player: AVAudioPlayerNode?
    @ObservationIgnored private var captureMixer: AVAudioMixerNode?
    @ObservationIgnored private var captureTapInstalled = false
    @ObservationIgnored private var captureReadiness = RealtimeCaptureReadiness()
    @ObservationIgnored private var audioSessionLease = AudioSessionLease()
    @ObservationIgnored private let log = AppLog.make(category: "agent.realtime")
    @ObservationIgnored private var timeout: Task<Void, Never>?
    @ObservationIgnored private var assistantTranscriptStarted = false
    @ObservationIgnored private var playback = RealtimePlaybackBuffer()
    @ObservationIgnored private var discardingReply = false
    @ObservationIgnored private var responseID: String?
    @ObservationIgnored private var generation = UUID()
    @ObservationIgnored private var playbackGeneration = UUID()
    @ObservationIgnored private var playbackControls: [String] = []
    @ObservationIgnored private var playbackControlSender: Task<Void, Never>?
    @ObservationIgnored private var pendingSends = 0
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
        guard receiver == nil, liveSession == nil, !ending, !starting else { return }
        starting = true
        defer { starting = false }
        generation = UUID()
        let callGeneration = generation
        captureDiagnostics = RealtimeCaptureDiagnostics()
        transcript = ""
        playbackNotice = nil
        userSpeechActive = false
        assistantTranscriptStarted = false
        status = "Connecting…"
        error = nil
        replyFailure = nil
        liveCaptions = []
        isLive = false
        do {
            let kind = try await RealtimeCapability.connectionKind(pairing: pairing)
            guard isCurrentCall(callGeneration) else { return }
            guard let kind else { throw RealtimeCallFailure(code: "unavailable", fatal: true, retryable: false) }
            if kind == .live {
                await startLive(pairing: pairing, conversationID: conversationID, onReady: onReady, generation: callGeneration)
                return
            }
        } catch {
            if isCurrentCall(callGeneration) { fail(error) }
            return
        }
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
            installAudioObservers(callGeneration: callGeneration)
            receiver = receiveMessages(socket: socket, callGeneration: callGeneration, onReady: onReady)
        } catch { fail(error) }
    }

    private func installAudioObservers(callGeneration: UUID) {
        audioObservers = [
            NotificationCenter.default
                .addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in
                        guard self?.isCurrentCall(callGeneration) == true else { return }
                        self?.fail(RealtimeCallFailure(code: "audio_interrupted", fatal: true, retryable: true))
                    }
                },
            NotificationCenter.default
                .addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
                    guard let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                          reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
                    Task { @MainActor in
                        guard self?.isCurrentCall(callGeneration) == true else { return }
                        self?.fail(RealtimeCallFailure(code: "audio_interrupted", fatal: true, retryable: true))
                    }
                },
        ]
    }

    private func isCurrentCall(_ id: UUID) -> Bool {
        !Task.isCancelled && generation == id
    }

    private func acceptMicrophonePermission(_ granted: Bool, callGeneration: UUID) -> Bool {
        guard isCurrentCall(callGeneration) else { return false }
        guard granted else {
            error = RealtimeCallFailure(code: "microphone_permission", fatal: true, retryable: false)
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
        if event["type"] as? String == "error" {
            try receiveFailure(event)
            return
        }
        if receiveWhileEnding(event) { return }
        switch event["type"] as? String {
        case "session.ready":
            try RealtimeProtocol.validateReady(event)
            guard !connected else { return }
            self.conversationID = event["conversationId"] as? String ?? conversationID
            clientAudioDiagnostics = event["clientAudioDiagnostics"] as? Bool == true
            timeout?.cancel()
            do { try beginAudio() } catch {
                throw RealtimeCallFailure(code: "microphone_failed", fatal: true, retryable: true)
            }
            connected = true
            status = "Starting microphone…"
        case "input_audio_buffer.speech_started":
            replyFailure = nil
            interruptPlayback()
            playbackNotice = nil
            userSpeechActive = true
            transcript = ""
            assistantTranscriptStarted = false
            status = "Listening"
        case "input_audio_buffer.speech_stopped":
            userSpeechActive = false
            status = "Thinking…"
        case "conversation.item.input_audio_transcription.completed":
            if !assistantTranscriptStarted { transcript = event["transcript"] as? String ?? "" }
        default: receivePlaybackEvent(event)
        }
    }

    private func receiveFailure(_ event: [String: Any]) throws {
        let failure = RealtimeCallFailure.server(event)
        if ending {
            if failure.fatal {
                error = failure
                endHandshake.cancel(generation: generation)
            }
        } else if failure.fatal {
            throw failure
        } else {
            replyFailure = failure
        }
    }

    private func receivePlaybackEvent(_ event: [String: Any]) {
        switch event["type"] as? String {
        case "response.created":
            replyFailure = nil
            if let id = (event["response"] as? [String: Any])?["id"] as? String, id != responseID {
                responseID = id
                discardingReply = false
            }
        case "response.output_audio.delta":
            guard !discardingReply else { return }
            guard let encoded = event["delta"] as? String, let data = Data(base64Encoded: encoded), data.count.isMultiple(of: 2) else {
                fail(RealtimeCallFailure(code: "protocol_error", fatal: true, retryable: true))
                return
            }
            play(data, itemID: event["item_id"] as? String)
            if !discardingReply, error == nil { status = "Speaking" }
        case "response.output_audio_transcript.delta":
            guard !discardingReply else { return }
            if !assistantTranscriptStarted { transcript = ""
                assistantTranscriptStarted = true
            }
            transcript += event["delta"] as? String ?? ""
        case "response.done":
            // Playback can outlast the server response; its completion updates the label.
            discardingReply = false
            if playback.isEmpty { status = "Listening" }
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

    func toggleMute() {
        muted.toggle()
        if let liveSession { liveSession.mute(muted)
            return
        }
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
        let failure = RealtimeCallFailure.local(
            error, httpStatus: (socket?.response as? HTTPURLResponse)?.statusCode, closeReason: socket?.closeReason
        )
        if ending {
            guard endHandshake.isWaiting(generation: generation) else { return }
            if self.error == nil { self.error = failure }
            endHandshake.cancel(generation: generation)
            return
        }
        guard self.error == nil else { return }
        stop()
        self.error = failure
        status = failure.title
    }

    #if DEBUG
    @ObservationIgnored var outgoingMessageForTesting: ((String) -> Void)?
    @ObservationIgnored var configurationRecoveryEnabledForTesting = true
    @ObservationIgnored var voiceProcessingEnabledForTesting = true
    @ObservationIgnored var setupStageForTesting: ((String) -> Void)?

    func receiveForTesting(_ event: [String: Any]) throws {
        try receive(event)
    }

    func failForTesting(_ error: Error) {
        fail(error)
    }

    var engineRunningForTesting: Bool {
        engine?.isRunning ?? false
    }

    var captureCountersForTesting: RealtimeCaptureDiagnostics.Snapshot {
        captureDiagnostics.snapshot
    }

    var bufferedPlaybackBytesForTesting: Int {
        playback.retainedPCMBytes
    }

    var scheduledPlaybackFramesForTesting: Int64 {
        playback.scheduledFrames
    }

    var playbackIsEmptyForTesting: Bool {
        playback.isEmpty
    }

    func configurePlaybackForTesting(maximumBytes: Int) {
        playback = RealtimePlaybackBuffer(maximumBytes: maximumBytes)
    }

    func configurePlaybackForTesting(engine: AVAudioEngine, player: AVAudioPlayerNode) {
        self.engine = engine
        self.player = player
        connected = true
    }

    func stopEngineForConfigurationTest() {
        guard let engine else { return }
        engine.stop()
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: engine)
    }
    #endif

    func end() async {
        if let liveSession { await liveSession.end()
            return
        }
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
        if outcome == .timedOut {
            log.warning("Realtime graceful close timed out; forcing transport cleanup")
            if error == nil { error = RealtimeCallFailure(code: "session_end_failed", fatal: true, retryable: true) }
        }
        stop()
        if let failure = error as? RealtimeCallFailure { status = failure.title }
    }

    func stop() {
        let hadLive = liveSession != nil
        liveSession?.stop()
        liveSession = nil
        endHandshake.cancel(generation: generation)
        generation = UUID()
        playbackGeneration = UUID()
        playbackControlSender?.cancel()
        playbackControlSender = nil
        playbackControls.removeAll()
        pendingSends = 0
        playback.reset()
        discardingReply = false
        responseID = nil
        connected = false
        ending = false
        userSpeechActive = false
        captureReadiness = RealtimeCaptureReadiness()
        timeout?.cancel()
        receiver?.cancel()
        receiver = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        if !hadLive { stopAudio() }
    }

    private func stopAudio() {
        audioObservers.forEach { NotificationCenter.default.removeObserver($0) }
        audioObservers = []
        if captureTapInstalled { engine?.inputNode.removeTap(onBus: 0) }
        captureTapInstalled = false
        engine?.stop()
        player?.stop()
        engine = nil
        player = nil
        captureMixer = nil
        captureInputFormat = nil
        clientAudioDiagnostics = false
        configurationRestartAttempts = 0
        if audioSessionLease.release() {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}

extension RealtimeCallSession {
    private func startLive(
        pairing: Pairing, conversationID: String?, onReady: (@MainActor (String) async throws -> Void)?, generation epoch: UUID
    ) async {
        #if OMNESIS_REALTIME_VOICE
        isLive = true
        let session = LiveVoiceSession(
            api: LiveVoiceAPI(pairing: pairing),
            media: LiveWebRTCMedia(),
            permission: { await AVAudioApplication.requestRecordPermission() },
            publish: { [weak self] state in
                guard let self, self.generation == epoch else { return }
                connected = state.connected
                ending = state.ending
                error = state.error
                replyFailure = state.replyFailure
                status = state.outputLevel > 0.01 ? "Speaking" : state.status
                userSpeechActive = !muted && state.inputLevel > 0.01
                liveCaptions = state.captions.displayRuns
                self.conversationID = state.conversationID ?? self.conversationID
                if state.error != nil {
                    self.liveSession?.stop()
                    self.liveSession = nil
                }
            }
        )
        liveSession = session
        await session.start(conversationID: conversationID, onReady: onReady)
        #else
        fail(RealtimeCallFailure(code: "unavailable", fatal: true, retryable: false))
        #endif
    }

    private func receiveMessages(
        socket: URLSessionWebSocketTask,
        callGeneration: UUID,
        onReady: (@MainActor (String) async throws -> Void)?
    )
        -> Task<Void, Never> {
        Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    let data: Data
                    switch message {
                    case .data(let value): data = value
                    case .string(let value): data = Data(value.utf8)
                    @unknown default: continue
                    }
                    guard let event = RealtimeProtocol.event(data) else {
                        throw RealtimeCallFailure(code: "protocol_error", fatal: true, retryable: true)
                    }
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
        audioSessionLease.begin()
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
                    fail(RealtimeCallFailure(code: "microphone_failed", fatal: true, retryable: true))
                }
            }
        }
        captureTapInstalled = true
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
            fail(RealtimeCallFailure(code: "audio_interrupted", fatal: true, retryable: true))
            return
        }
        guard configurationRestartAttempts < 3 else {
            fail(RealtimeCallFailure(code: "microphone_failed", fatal: true, retryable: true))
            return
        }
        configurationRestartAttempts += 1
        // Engine reinitialization invalidates scheduled sample times. Keep the
        // call and microphone, but cancel this reply before resetting its epoch.
        interruptPlayback()
        discardingReply = true
        send(["type": "response.cancel"])
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
        } catch { fail(RealtimeCallFailure(code: "microphone_failed", fatal: true, retryable: true)) }
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

extension RealtimeCallSession {
    private func playerFrame(audible: Bool = false) -> Int64 {
        guard let player, let time = player.lastRenderTime,
              time.isSampleTimeValid || time.isHostTimeValid,
              let position = player.playerTime(forNodeTime: time), position.isSampleTimeValid,
              position.sampleRate.isFinite, position.sampleRate > 0 else { return 0 }
        let frames = Double(position.sampleTime) * 24000 / position.sampleRate
        let latency = audible ? max(0, player.outputPresentationLatency) * 24000 : 0
        guard frames.isFinite, latency.isFinite else { return 0 }
        return max(0, Int64(frames - latency))
    }

    private func play(_ data: Data, itemID: String?) {
        guard playback.append(data, itemID: itemID) else { cancelOversizedReply(itemID: itemID)
            return
        }
        pumpPlayback()
    }

    private func pumpPlayback() {
        guard let player, let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1) else {
            if connected { fail(RealtimeCallFailure(code: "playback_failed", fatal: true, retryable: true)) }
            return
        }
        while let packet = playback.nextPacket(renderedFrame: playerFrame()) {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(packet.frameCount)),
                  let channel = buffer.floatChannelData?[0] else {
                fail(RealtimeCallFailure(code: "playback_failed", fatal: true, retryable: true))
                return
            }
            buffer.frameLength = buffer.frameCapacity
            packet.data.withUnsafeBytes { raw in
                for index in 0 ..< Int(buffer.frameLength) {
                    let sample = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))
                    channel[index] = Float(sample) / 32768
                }
            }
            let audioGeneration = playbackGeneration
            let token = packet.token
            // Offline rendering has no device: dataPlayedBack applies only to
            // device I/O, while dataRendered supplies the offline completion.
            let callback: AVAudioPlayerNodeCompletionCallbackType =
                engine?.isInManualRenderingMode == true ? .dataRendered : .dataPlayedBack
            player.scheduleBuffer(
                buffer,
                at: AVAudioTime(sampleTime: packet.startFrame, atRate: 24000),
                completionCallbackType: callback
            ) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, playbackGeneration == audioGeneration else { return }
                    playback.complete(token: token)
                    pumpPlayback()
                    if playback.isEmpty, connected { status = "Listening" }
                }
            }
        }
    }

    private func cancelOversizedReply(itemID: String? = nil) {
        interruptPlayback(additionalItemID: itemID)
        discardingReply = true
        playbackNotice = "That reply was too long. Ask for a shorter answer."
        status = "Listening"
        log.warning("Realtime playback memory budget reached; cancelling the reply")
        send(["type": "response.cancel"])
    }

    private func interruptPlayback(additionalItemID: String? = nil) {
        let cursor = playerFrame(audible: true)
        var truncations = playback.truncations(at: cursor)
        if let additionalItemID, !truncations.contains(where: { $0.itemID == additionalItemID }) {
            truncations.append(playback.truncation(itemID: additionalItemID, at: cursor))
        }
        playbackGeneration = UUID()
        sendPlaybackControls(truncations.map { item in
            [
                "type": "conversation.item.truncate",
                "item_id": item.itemID,
                "content_index": 0,
                "audio_end_ms": item.audioEndMilliseconds,
            ]
        })
        player?.stop()
        if engine?.isRunning == true { player?.play() }
        playback.reset()
    }

    /// Many unheard items must not overflow the microphone sender's eight-packet bound.
    private func sendPlaybackControls(_ events: [[String: Any]]) {
        #if DEBUG
        if outgoingMessageForTesting != nil { events.forEach { send($0) }
            return
        }
        #endif
        guard let socket, !ending else { return }
        guard playbackControls.count + events.count <= 1024 else { fail(URLError(.networkConnectionLost))
            return
        }
        playbackControls += events.compactMap { event in
            guard let data = try? JSONSerialization.data(withJSONObject: event) else { return nil }
            return String(data: data, encoding: .utf8)
        }
        guard playbackControlSender == nil, !playbackControls.isEmpty else { return }
        let callGeneration = generation
        playbackControlSender = Task { [weak self] in
            defer {
                if self?.generation == callGeneration { self?.playbackControlSender = nil }
            }
            do {
                while let self, generation == callGeneration, !ending, !Task.isCancelled, !playbackControls.isEmpty {
                    let text = playbackControls.removeFirst()
                    try await socket.send(.string(text))
                }
            } catch {
                guard let self, generation == callGeneration else { return }
                fail(error)
            }
        }
    }
}

#endif
