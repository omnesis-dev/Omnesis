// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum PushRegistrationError: Error, Equatable {
    case invalidURL
    case invalidResponse
    case unavailable(reasonCode: String?, reason: String)
    case serverError(status: Int, body: String)
}

public struct RelayPushConsentRequest: Identifiable, Equatable, Sendable {
    public let gatewayURL: String
    public let deviceId: String
    public let pairingGeneration: String?
    public let appId: String

    public var id: String {
        "\(gatewayURL)|\(deviceId)|\(pairingGeneration ?? "legacy")|\(appId)"
    }

    public init(pairing: Pairing, appId: String) {
        gatewayURL = pairing.url.absoluteString
        deviceId = pairing.deviceId
        pairingGeneration = pairing.pairingGeneration
        self.appId = appId
    }

    public func matches(pairing: Pairing, appId: String) -> Bool {
        gatewayURL == pairing.url.absoluteString
            && deviceId == pairing.deviceId
            && pairingGeneration == pairing.pairingGeneration
            && self.appId == appId
    }
}

struct PushRegistrationAttemptGate {
    private var generation: UInt64 = 0

    mutating func begin() -> UInt64 {
        invalidate()
        return generation
    }

    mutating func invalidate() {
        generation &+= 1
    }

    func isCurrent(_ attempt: UInt64) -> Bool {
        attempt == generation
    }
}

/// Accepts one APNs callback while the current pairing has a pending request.
/// APNs does not identify which request produced a callback: if a new pairing
/// requests registration first, a late callback is still app-level APNs state.
struct PushCallbackRequestGate {
    private var requestedPairing: Pairing?

    mutating func begin(pairing: Pairing?) {
        requestedPairing = pairing
    }

    mutating func consume(pairing: Pairing?) -> Bool {
        guard let requestedPairing, requestedPairing == pairing else { return false }
        self.requestedPairing = nil
        return true
    }

    mutating func invalidate() {
        requestedPairing = nil
    }
}

/// Binds an asynchronous plan read to the exact pairing and app identity that
/// started it. A late response cannot repaint Settings after re-pairing.
struct PushConfigurationCheckGate {
    struct Check {
        let generation: UInt64
        let pairing: Pairing
        let appId: String
    }

    private var generation: UInt64 = 0

    mutating func begin(pairing: Pairing, appId: String) -> Check {
        invalidate()
        return Check(generation: generation, pairing: pairing, appId: appId)
    }

    mutating func invalidate() {
        generation &+= 1
    }

    func isCurrent(_ check: Check, pairing: Pairing?, appId: String?) -> Bool {
        generation == check.generation && pairing == check.pairing && appId == check.appId
    }
}
