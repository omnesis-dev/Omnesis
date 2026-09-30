// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import Foundation
import Observation

/// Gateway dictation as the app's views see it: the gate the paired gateway
/// advertises on `GET /status`, and whether a Tell Omnesis capture records
/// its audio for the gateway to transcribe.
extension AppStore {
    /// The paired gateway's dictation gate; nil from a gateway that predates it.
    var dictationStatus: DictationStatus? {
        statusSnapshot?.dictation
    }

    /// Client for gateway dictation. `nil` until pairing completes.
    var dictationClient: DictationClient? {
        pairing.map { DictationClient(baseURL: $0.url, token: $0.token) }
    }

    /// The byte limit a Tell Omnesis recording must stay under, when a
    /// capture starting now should record its audio for the gateway; nil to
    /// keep the phone's transcript alone.
    var voiceNoteAudioLimit: Int? {
        guard pairing != nil, let status = dictationStatus, status.routesToGateway else { return nil }
        return status.maxAudioBytes
    }

    /// Switch gateway dictation on or off for this gateway, then re-read
    /// `/status` so every surface sees the new gate.
    func setGatewayDictation(enabled: Bool) async throws {
        guard let client = dictationClient else { throw GatewayClient.Error.invalidResponse }
        try await client.setTranscribeOnGateway(enabled)
        await refreshGatewayStats()
    }
}

#if os(iOS)
extension AppStore {
    /// Keep the Apple Watch told whether to record for the gateway: pass the
    /// gate the paired gateway's status implies to the relay receiver now,
    /// and again whenever the status or pairing changes. Nothing is passed
    /// while the status is unknown — a background launch has not read it yet.
    func publishDictationGateToWatch() {
        let gate = withObservationTracking {
            WatchGatePublishing.gate(
                status: dictationStatus,
                statusKnown: statusSnapshot != nil,
                paired: pairing != nil,
                now: Date()
            )
        } onChange: { [weak self] in
            guard let self else { return }
            Task { @MainActor in self.publishDictationGateToWatch() }
        }
        if let gate { WatchRelayReceiver.shared.update(gate) }
    }
}
#endif
#endif
