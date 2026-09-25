// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The gateway's selected carrier path. This is configuration evidence only;
/// it does not claim that APNs has delivered a background notification.
public enum PushGatewayConfiguration: Equatable, Sendable {
    case notChecked
    case checking
    case direct
    case relay
    case relayConsentRequired
    case noDirectCredential
    case unavailable(String)
    case gatewayUnavailable
    case planUnavailable
    case legacyGateway
}

enum PushRegistrationModel {
    enum Plan {
        case direct
        case relay(URL)
        case unavailable(reasonCode: String?, reason: String)
        case legacy

        var isRelay: Bool {
            if case .relay = self { return true }
            return false
        }

        func matchesRelay(url: String) -> Bool {
            guard case .relay(let selectedURL) = self else { return false }
            return selectedURL.absoluteString == url
        }
    }

    struct State: Codable {
        var pending: Pending?
        var completed: Completed?
    }

    struct ActiveRegistration {
        let key: RegistrationKey
        let generation: UInt64
        let task: Task<Void, Error>
    }

    struct ActiveChallenge {
        let ownership: ChallengeOwnership
        let pairingToken: String
        let generation: UInt64
        let task: Task<Bool, Error>
    }

    struct RegistrationKey: Equatable {
        let identity: Identity
        let pairingToken: String
    }

    struct Identity: Codable, Equatable {
        let gatewayURL: String
        let deviceId: String
        let pairingGeneration: String?
        let carrierToken: String
        let appId: String
        let environment: String

        func matches(_ pairing: Pairing) -> Bool {
            gatewayURL == pairing.url.absoluteString &&
                deviceId == pairing.deviceId &&
                pairingGeneration == pairing.pairingGeneration
        }
    }

    struct Pending: Codable {
        let identity: Identity
        let relayURL: String
        let challengeId: String
        var verifiedCredential: String?
        let startedAt: Date
    }

    struct ChallengeOwnership: Equatable {
        let identity: Identity
        let relayURL: String
        let challengeId: String

        init(pending: Pending) {
            identity = pending.identity
            relayURL = pending.relayURL
            challengeId = pending.challengeId
        }
    }

    struct Completed: Codable {
        let identity: Identity
        let transport: String
        let relayURL: String?
        let registeredAt: Date

        func matches(_ plan: Plan) -> Bool {
            switch (transport, plan) {
            case ("direct-apns", .direct), ("legacy-apns", .legacy):
                true
            case ("relay", .relay(let selectedURL)):
                relayURL == selectedURL.absoluteString
            default:
                false
            }
        }
    }

    struct PushPlanResponse: Decodable {
        let transport: String
        let relayUrl: String?
        let reasonCode: String?
        let reason: String?
    }

    struct DirectBody: Encodable {
        let transport: String
        let deviceToken: String
        let environment: String
        let bundleId: String
    }

    struct LegacyBody: Encodable {
        let deviceToken: String
        let environment: String
        let bundleId: String
    }

    struct RelayBody: Encodable {
        let transport: String
        let relayUrl: String
        let credential: String
    }

    struct RelayConsentBody: Encodable {
        let platform: String
        let appId: String
    }

    struct EnrolBody: Encodable {
        let platform: String
        let token: String
        let bundleId: String
        let environment: String
    }

    struct VerifyBody: Encodable {
        let challengeId: String
        let nonce: String
    }
}
