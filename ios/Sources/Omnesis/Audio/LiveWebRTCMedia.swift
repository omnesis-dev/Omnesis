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
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    func offer() async throws -> String {
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = Self.factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            throw URLError(.cannotCreateFile)
        }
        self.peer = peer
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

    func enableMicrophone(_ enabled: Bool) {
        guard !closed else { return }
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
                    guard let level = item.values["audioLevel"] as? NSNumber else { continue }
                    if item.type == "media-source" { input = max(input, level.doubleValue) }
                    if item.type == "inbound-rtp" { output = max(output, level.doubleValue) }
                }
                onLevels?(microphone?.isEnabled == true ? min(1, max(0, input)) : 0, min(1, max(0, output)))
                do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            }
        }
    }

    private func fail(_ error: Error) {
        guard !closed else { return }
        deadline?.cancel()
        gathering?.resume(throwing: error)
        gathering = nil
        connecting?.resume(throwing: error)
        connecting = nil
        onFailure?(error)
    }

    func close() {
        guard !closed else { return }
        closed = true
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
        let audio = RTCAudioSession.sharedInstance()
        audio.lockForConfiguration()
        audio.isAudioEnabled = false
        if audioActive { try? audio.setActive(false) }
        audioActive = false
        audio.useManualAudio = false
        audio.unlockForConfiguration()
        audio.remove(self)
    }
}

extension LiveWebRTCMedia: RTCPeerConnectionDelegate, RTCDataChannelDelegate, RTCAudioSessionDelegate {
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
