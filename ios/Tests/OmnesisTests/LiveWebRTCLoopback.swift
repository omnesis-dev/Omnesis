// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(iOS) && canImport(WebRTC)
import Foundation
@preconcurrency import WebRTC

/// A real local RTC peer for the hosted signaling regression. Audio stays
/// disabled: this fixture sends only scripted data-channel events, no inference.
@MainActor
final class LiveWebRTCLoopback: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    private let factory: RTCPeerConnectionFactory
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var gathering: CheckedContinuation<String, Error>?
    private var deadline: Task<Void, Never>?
    private var sent = false

    override init() {
        factory = RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: nil, audioDevice: LiveWebRTCSilentAudioDevice())
        super.init()
    }

    func answer(offer: String) async throws -> String {
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self)!
        self.peer = peer
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: offer)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        let answer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            peer.answer(for: constraints) { sdp, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let sdp {
                    continuation.resume(returning: sdp)
                } else {
                    continuation.resume(throwing: URLError(.badServerResponse))
                }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(answer) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        if peer.iceGatheringState == .complete { return peer.localDescription!.sdp }
        return try await withCheckedThrowingContinuation { continuation in
            gathering = continuation
            deadline = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(10)) } catch { return }
                self?.gathering?.resume(throwing: URLError(.timedOut))
                self?.gathering = nil
            }
        }
    }

    func close() {
        deadline?.cancel()
        gathering?.resume(throwing: CancellationError())
        gathering = nil
        channel?.delegate = nil
        peer?.delegate = nil
        channel?.close()
        peer?.close()
    }

    private func sendWhenOpen() {
        guard !sent, let channel, channel.readyState == .open else { return }
        sent = true
        for event in [
            #"{"type":"session.started"}"#,
            #"{"type":"session.output_transcript.delta","event_id":"scripted-caption","start_ms":0,"end_ms":100,"# +
                #""delta":"The workshop notes are ready."}"#,
        ] {
            _ = channel.sendData(RTCDataBuffer(data: Data(event.utf8), isBinary: false))
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        Task { @MainActor [weak self] in
            guard let self, newState == .complete, let sdp = peer?.localDescription?.sdp else { return }
            deadline?.cancel()
            gathering?.resume(returning: sdp)
            gathering = nil
        }
    }

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        Task { @MainActor [weak self] in
            self?.channel = dataChannel
            dataChannel.delegate = self
            self?.sendWhenOpen()
        }
    }

    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        Task { @MainActor [weak self] in self?.sendWhenOpen() }
    }

    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {}
}

/// The remote test peer consumes signaling without opening a second hardware
/// audio unit. The production peer alone owns the real microphone under test.
private final class LiveWebRTCSilentAudioDevice: NSObject, RTCAudioDevice {
    var deviceInputSampleRate = 48000.0
    var deviceOutputSampleRate = 48000.0
    var inputIOBufferDuration = 0.01
    var outputIOBufferDuration = 0.01
    var inputNumberOfChannels = 1
    var outputNumberOfChannels = 1
    var inputLatency = 0.0
    var outputLatency = 0.0
    var isInitialized = false
    var isPlayoutInitialized = false
    var isRecordingInitialized = false
    var isPlaying = false
    var isRecording = false

    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        isInitialized = true
        return true
    }

    func terminateDevice() -> Bool {
        isInitialized = false
        return true
    }

    func initializePlayout() -> Bool {
        isPlayoutInitialized = true
        return true
    }

    func initializeRecording() -> Bool {
        isRecordingInitialized = true
        return true
    }

    func startPlayout() -> Bool {
        isPlaying = true
        return true
    }

    func stopPlayout() -> Bool {
        isPlaying = false
        return true
    }

    func startRecording() -> Bool {
        isRecording = true
        return true
    }

    func stopRecording() -> Bool {
        isRecording = false
        return true
    }
}
#endif
