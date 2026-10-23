// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS) && canImport(WebRTC)
import AVFAudio
import Foundation
@preconcurrency import WebRTC

/// Owns the SDK's RTP media and audio session. The legacy PCM engine is never
/// started for this transport. No application audio buffers or files are used.
@MainActor
final class LiveWebRTCMedia: NSObject, LiveVoiceMedia {
    var onEvent: ((Data) -> Void)?
    var onFailure: ((Error) -> Void)?
    var onLevels: ((Double, Double) -> Void)?
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var microphone: RTCAudioTrack?
    private var gathering: CheckedContinuation<String, Error>?
    private var connecting: CheckedContinuation<Void, Error>?
    private var deadline: Task<Void, Never>?
    private var meter: Task<Void, Never>?
    private var closed = false
    private var audioActive = false
    private static var configurationLease = AudioSessionLease()
    private var configurationGeneration: UUID?
    private let log = AppLog.make(category: "agent.realtime")
    private var captureProgress = LiveMicrophoneProgress()
    private var captureReady = false
    private var captureWaiter: CheckedContinuation<Void, Error>?
    private var captureDeadline: Task<Void, Never>?
    private var audioDeviceRequested = false
    #if DEBUG
    private(set) var capturedDurationForTesting = 0.0
    private(set) var captureStatsSummaryForTesting = "No statistics received"
    #endif
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    func offer() async throws -> String {
        guard !Self.configurationLease.owns(Self.configurationLease.generation) else {
            throw RealtimeCallFailure(code: "session_busy", fatal: true, retryable: true)
        }
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = Self.factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            throw URLError(.cannotCreateFile)
        }
        self.peer = peer
        Self.configurationLease.begin()
        configurationGeneration = Self.configurationLease.generation
        let audio = RTCAudioSession.sharedInstance()
        audio.useManualAudio = true
        audio.isAudioEnabled = false
        audio.add(self)
        let source = Self.factory.audioSource(with: constraints)
        let track = Self.factory.audioTrack(with: source, trackId: "microphone")
        track.isEnabled = false
        microphone = track
        peer.add(track, streamIds: ["voice"])
        channel = peer.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
        channel?.delegate = self
        let offer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: constraints) { sdp, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let sdp {
                    continuation.resume(returning: sdp)
                } else {
                    continuation.resume(throwing: URLError(.badServerResponse))
                }
            }
        }
        try await setDescription(offer, local: true, peer: peer)
        guard !closed else { throw CancellationError() }
        if peer.iceGatheringState == .complete { return peer.localDescription?.sdp ?? offer.sdp }
        return try await withCheckedThrowingContinuation { continuation in
            gathering = continuation
            armDeadline()
        }
    }

    func connect(answer: String) async throws {
        guard let peer, !closed else { throw CancellationError() }
        try await setDescription(RTCSessionDescription(type: .answer, sdp: answer), local: false, peer: peer)
        guard !closed else { throw CancellationError() }
        if peer.connectionState == .connected { return }
        try await withCheckedThrowingContinuation { continuation in
            connecting = continuation
            armDeadline()
        }
    }

    private func setDescription(_ sdp: RTCSessionDescription, local: Bool, peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let completed: @Sendable (Error?) -> Void = { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
            if local {
                peer.setLocalDescription(sdp, completionHandler: completed)
            } else {
                peer.setRemoteDescription(sdp, completionHandler: completed)
            }
        }
    }

    private func armDeadline() {
        deadline?.cancel()
        deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            self?.fail(URLError(.timedOut))
        }
    }

    func startMicrophone() async throws {
        guard !closed else { throw CancellationError() }
        guard let configurationGeneration, Self.configurationLease.owns(configurationGeneration) else {
            throw RealtimeCallFailure(code: "microphone_failed", fatal: true, retryable: true)
        }
        log.info("Live microphone capture requested")
        enableMicrophone(true)
        guard !closed else { throw CancellationError() }
        if captureReady { return }
        try await withCheckedThrowingContinuation { continuation in
            captureWaiter = continuation
            captureDeadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(8)) } catch { return }
                guard let self, !closed else { return }
                let audio = RTCAudioSession.sharedInstance()
                log.error("Live capture timeout; device requested: \(audioDeviceRequested, privacy: .public)")
                log.error("SDK active: \(audio.isActive, privacy: .public); audio enabled: \(audio.isAudioEnabled, privacy: .public)")
                log.error("Input channels: \(audio.inputNumberOfChannels, privacy: .public)")
                fail(RealtimeCallFailure(code: "microphone_failed", fatal: true, retryable: true))
            }
        }
    }

    private func observeCaptureDuration(_ duration: Double) {
        guard !captureReady, captureProgress.observe(duration: duration) else { return }
        captureReady = true
        captureDeadline?.cancel()
        captureDeadline = nil
        let waiter = captureWaiter
        captureWaiter = nil
        log.info("Live microphone captured sample duration advanced")
        waiter?.resume()
    }

    func enableMicrophone(_ enabled: Bool) {
        guard !closed, let configurationGeneration, Self.configurationLease.owns(configurationGeneration) else { return }
        if enabled, !audioActive {
            let audio = RTCAudioSession.sharedInstance()
            audio.lockForConfiguration()
            defer { audio.unlockForConfiguration() }
            do {
                try audio.setCategory(AVAudioSession.Category.playAndRecord, with: [.defaultToSpeaker, .allowBluetoothHFP])
                try audio.setMode(AVAudioSession.Mode.voiceChat)
                try audio.setActive(true)
                audio.isAudioEnabled = true
                audioActive = true
            } catch { fail(RealtimeCallFailure(code: "microphone_failed", fatal: true, retryable: true))
                return
            }
            if meter == nil { startMeter() }
        }
        microphone?.isEnabled = enabled
    }

    private func startMeter() {
        meter = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let peer, !closed else { return }
                let report = await peer.statistics()
                guard !closed else { return }
                var input = 0.0
                var output = 0.0
                for item in report.statistics.values {
                    if item.type == "media-source", let duration = item.values["totalSamplesDuration"] as? NSNumber {
                        observeCaptureDuration(duration.doubleValue)
                        #if DEBUG
                        capturedDurationForTesting = duration.doubleValue
                        #endif
                    }
                    guard let level = item.values["audioLevel"] as? NSNumber else { continue }
                    if item.type == "media-source" { input = max(input, level.doubleValue) }
                    if item.type == "inbound-rtp" { output = max(output, level.doubleValue) }
                }
                #if DEBUG
                let types = Set(report.statistics.values.map(\.type)).sorted()
                let sourceKeys = report.statistics.values
                    .filter { $0.type == "media-source" }
                    .flatMap(\.values.keys)
                    .sorted()
                captureStatsSummaryForTesting = "types=\(types); source fields=\(sourceKeys); duration=\(capturedDurationForTesting)"
                #endif
                onLevels?(microphone?.isEnabled == true ? min(1, max(0, input)) : 0, min(1, max(0, output)))
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            }
        }
    }

    private func fail(_ error: Error) {
        guard !closed else { return }
        deadline?.cancel()
        captureDeadline?.cancel()
        let capture = captureWaiter
        captureWaiter = nil
        capture?.resume(throwing: error)
        gathering?.resume(throwing: error)
        gathering = nil
        connecting?.resume(throwing: error)
        connecting = nil
        onFailure?(error)
    }

    func close() {
        guard !closed else { return }
        closed = true
        captureDeadline?.cancel()
        let capture = captureWaiter
        captureWaiter = nil
        capture?.resume(throwing: CancellationError())
        deadline?.cancel()
        meter?.cancel()
        gathering?.resume(throwing: CancellationError())
        gathering = nil
        connecting?.resume(throwing: CancellationError())
        connecting = nil
        microphone?.isEnabled = false
        channel?.delegate = nil
        channel?.close()
        peer?.delegate = nil
        peer?.close()
        microphone = nil
        channel = nil
        peer = nil
        guard let configurationGeneration else { return }
        self.configurationGeneration = nil
        let audio = RTCAudioSession.sharedInstance()
        audio.remove(self)
        guard Self.configurationLease.release(expectedGeneration: configurationGeneration) else { return }
        audio.lockForConfiguration()
        audio.isAudioEnabled = false
        if audioActive { try? audio.setActive(false) }
        audioActive = false
        // This SDK is dedicated to Live calls. Re-enabling automatic audio
        // would reopen canPlayOrRecord during asynchronous peer teardown.
        audio.unlockForConfiguration()
    }
}

extension LiveWebRTCMedia: RTCPeerConnectionDelegate, RTCDataChannelDelegate, RTCAudioSessionDelegate {
    nonisolated func audioSessionDidStartPlayOrRecord(_ session: RTCAudioSession) {
        Task { @MainActor [weak self] in
            guard let self, !closed else { return }
            // This SDK notification precedes AudioUnit initialization; it is
            // diagnostic only and must never resolve microphone readiness.
            audioDeviceRequested = true
        }
    }

    nonisolated func audioSession(_ audioSession: RTCAudioSession, audioUnitStartFailedWithError error: Error) {
        Task { @MainActor [weak self] in
            self?.fail(RealtimeCallFailure(code: "microphone_failed", fatal: true, retryable: true))
        }
    }

    nonisolated func audioSessionDidBeginInterruption(_ session: RTCAudioSession) {
        Task { @MainActor [weak self] in
            self?.fail(RealtimeCallFailure(code: "audio_interrupted", fatal: true, retryable: true))
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        if newState == .failed { Task { @MainActor [weak self] in self?.fail(URLError(.networkConnectionLost)) } }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        Task { @MainActor [weak self] in
            guard let self, !closed else { return }
            if newState == .connected {
                deadline?.cancel()
                connecting?.resume()
                connecting = nil
            } else if newState == .failed || newState == .closed {
                fail(URLError(.networkConnectionLost))
            }
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        Task { @MainActor [weak self] in
            guard let self, !closed, newState == .complete, let sdp = peer?.localDescription?.sdp else { return }
            deadline?.cancel()
            gathering?.resume(returning: sdp)
            gathering = nil
        }
    }

    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        if dataChannel.readyState == .closed { Task { @MainActor [weak self] in self?.fail(URLError(.networkConnectionLost)) } }
    }

    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        Task { @MainActor [weak self] in
            guard let self, !closed else { return }
            guard data.count <= 128 * 1024 else {
                fail(RealtimeCallFailure(code: "protocol_error", fatal: true, retryable: true))
                return
            }
            onEvent?(data)
        }
    }
}
#endif
