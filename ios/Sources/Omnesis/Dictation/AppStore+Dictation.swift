// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import Foundation

/// Gateway dictation as the app's views see it: the gate the paired gateway
/// advertises on `GET /status`, and the route a mic session starting now
/// should record for.
extension AppStore {
    /// The paired gateway's dictation gate; nil from a gateway that predates it.
    var dictationStatus: DictationStatus? {
        statusSnapshot?.dictation
    }

    /// Client for gateway dictation. `nil` until pairing completes.
    var dictationClient: DictationClient? {
        pairing.map { DictationClient(baseURL: $0.url, token: $0.token) }
    }

    /// Where a mic session starting now sends its recording, or nil to keep
    /// the on-device recognizer's text. Read once per session start.
    var gatewayDictationRoute: GatewayDictationRoute? {
        guard let status = dictationStatus, status.routesToGateway, let client = dictationClient else {
            return nil
        }
        return GatewayDictationRoute(transcriber: client, maxAudioBytes: status.maxAudioBytes)
    }

    /// Switch gateway dictation on or off for this gateway, then re-read
    /// `/status` so every surface sees the new gate.
    func setGatewayDictation(enabled: Bool) async throws {
        guard let client = dictationClient else { throw GatewayClient.Error.invalidResponse }
        try await client.setTranscribeOnGateway(enabled)
        await refreshGatewayStats()
    }
}

extension SpeechRecognizer {
    /// Route this recognizer's sessions through `store`'s gateway dictation
    /// gate, read afresh each time a session starts.
    func routeDictation(through store: AppStore) {
        gatewayRoute = { [weak store] in store?.gatewayDictationRoute }
    }
}
#endif
