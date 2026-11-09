// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What `GET /admin/cloud-relay` and every relay management action answer.
///
/// Decoding is tolerant: states and error codes stay strings, a missing or
/// malformed part reads as absent, and unknown fields are ignored, so a newer
/// gateway never empties the Omnesis account screen.
public struct CloudRelayStatus: Decodable, Equatable, Sendable {
    public let enabled: Bool
    public let serviceConfigured: Bool?
    public let serviceError: String?
    public let gatewayId: String?
    public let hostname: String?
    public let config: Config?
    public let enrollment: Step?
    public let tunnel: Tunnel?
    public let certificate: Certificate?
    public let publicMcp: PublicMcp?
    public let google: Google?
    public let account: Account?
    public let connect: Connect?
    public let deviceEnrollment: DeviceEnrollment?
    public let can: Can?
    public let certificateMonitor: Monitor?

    public struct Config: Decodable, Equatable, Sendable {
        public let relayUrl: String?
    }

    /// Registration with the relay: `unconfigured`, `pending`, `enrolled` or `failed`.
    public struct Step: Decodable, Equatable, Sendable {
        public let state: String?
        public let error: String?
    }

    public struct Tunnel: Decodable, Equatable, Sendable {
        public let state: String?
        public let lastConnectedAt: CloudRelayTimestamp?
        public let lastError: String?
    }

    public struct Certificate: Decodable, Equatable, Sendable {
        public let state: String?
        public let expiresAt: CloudRelayTimestamp?
        public let lastRenewedAt: CloudRelayTimestamp?
        public let lastError: String?
    }

    public struct PublicMcp: Decodable, Equatable, Sendable {
        public let ready: Bool?
        public let url: String?
        public let lastError: String?
    }

    /// The older Google-only link, shown when no Omnesis account is set up.
    public struct Google: Decodable, Equatable, Sendable {
        public let configured: Bool?
        public let linked: Bool?
        public let canLink: Bool?
        public let canUnlink: Bool?
        public let lastError: String?
    }

    public struct Account: Decodable, Equatable, Sendable {
        public let activated: Bool?
        public let configured: Bool?
        public let linked: Bool?
        public let canLink: Bool?
        public let canUnlink: Bool?
        public let pendingUnlink: Bool?
        public let lastError: String?
    }

    /// Progress of connecting by sign-in. Present while one is under way or just ended.
    public struct Connect: Decodable, Equatable, Sendable {
        public let state: String?
        public let authorizeUrl: String?
        public let connectUrl: String?
        public let connectShortUrl: String?
        public let code: String?
        public let expiresAt: CloudRelayTimestamp?
        public let error: String?
    }

    /// The local choice about new devices: `automatic` or `ask`.
    public struct DeviceEnrollment: Decodable, Equatable, Sendable {
        public let policy: String?
    }

    public struct Can: Decodable, Equatable, Sendable {
        public let enable: Bool?
        public let disable: Bool?
        public let reconnect: Bool?
    }

    public typealias Monitor = CloudRelayMonitor

    /// A certificate naming this gateway that was issued with a key it doesn't hold.
    public struct Incident: Decodable, Equatable, Sendable {
        public let hostname: String?
        public let spkiFingerprint: String?
        public let certificateFingerprint: String?
        public let issuer: String?
        public let serial: String?
        public let validFrom: CloudRelayTimestamp?
        public let validTo: CloudRelayTimestamp?
        public let observedAt: CloudRelayTimestamp?
        public let providerEntryId: String?
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, serviceConfigured, serviceError, gatewayId, hostname, config, enrollment, tunnel
        case certificate, publicMcp, google, account, connect, deviceEnrollment, can, certificateMonitor
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = values.lenient(.enabled) ?? false
        serviceConfigured = values.lenient(.serviceConfigured)
        serviceError = values.lenient(.serviceError)
        gatewayId = values.lenient(.gatewayId)
        hostname = values.lenient(.hostname)
        config = values.lenient(.config)
        enrollment = values.lenient(.enrollment)
        tunnel = values.lenient(.tunnel)
        certificate = values.lenient(.certificate)
        publicMcp = values.lenient(.publicMcp)
        google = values.lenient(.google)
        account = values.lenient(.account)
        connect = values.lenient(.connect)
        deviceEnrollment = values.lenient(.deviceEnrollment)
        can = values.lenient(.can)
        certificateMonitor = values.lenient(.certificateMonitor)
    }
}

/// Certificate Transparency monitoring of the gateway's public address.
public struct CloudRelayMonitor: Decodable, Equatable, Sendable {
    public let state: String?
    public let lastCompletedAt: CloudRelayTimestamp?
    public let lastError: String?
    public let incidents: [CloudRelayStatus.Incident]

    private enum CodingKeys: String, CodingKey { case state, lastCompletedAt, lastError, incidents }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        state = values.lenient(.state)
        lastCompletedAt = values.lenient(.lastCompletedAt)
        lastError = values.lenient(.lastError)
        incidents = values.lenientArray(.incidents)
    }
}

/// A time the gateway sends as an ISO 8601 string, as milliseconds or as Unix
/// seconds, depending on the field. Anything else reads as no time at all.
public struct CloudRelayTimestamp: Decodable, Equatable, Sendable {
    public let date: Date?

    public init(date: Date?) {
        self.date = date
    }

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let number = try? value.decode(Double.self) {
            date = number.isFinite ? Date(timeIntervalSince1970: number < 1e12 ? number : number / 1000) : nil
        } else if let text = try? value.decode(String.self) {
            date = Self.parse(text)
        } else {
            date = nil
        }
    }

    private static func parse(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }
}

/// The one state the Omnesis account screen is in.
public enum CloudRelayPhase: String, Equatable, Sendable {
    case notConnected = "not-connected"
    case waiting, registering, linking, failed, connected, reconnecting, disconnected, off, unavailable

    /// A connect by sign-in is under way and the status is worth following closely.
    public var inProgress: Bool {
        self == .waiting || self == .registering || self == .linking
    }

    /// The gateway is registered, so its account, address and devices have something to show.
    public var established: Bool {
        self == .connected || self == .reconnecting || self == .disconnected || self == .off
    }
}

extension CloudRelayStatus {
    /// The same derivation as the portal's `relayPhase`. Order matters: an active
    /// connect outranks everything, then a failure, then the connection.
    public var phase: CloudRelayPhase {
        if let active = connect?.state.flatMap(CloudRelayPhase.init(rawValue:)), active.inProgress || active == .failed {
            return active
        }
        let enrolled = enrollment?.state == "enrolled"
        if !enrolled, !enabled {
            if serviceConfigured != true { return .unavailable }
            return enrollment?.state == "failed" ? .failed : .notConnected
        }
        if !enabled { return .off }
        if !enrolled { return .registering }
        switch tunnel?.state {
        case "online": return .connected
        case "offline": return .disconnected
        default: return .reconnecting
        }
    }
}

extension KeyedDecodingContainer {
    /// A missing key, a null and a value of another shape all read as nil.
    fileprivate func lenient<T: Decodable>(_ key: Key) -> T? {
        try? decodeIfPresent(T.self, forKey: key)
    }

    /// The elements that decode; one malformed element never drops its neighbours.
    fileprivate func lenientArray<T: Decodable>(_ key: Key) -> [T] {
        let elements: [Lenient<T>] = lenient(key) ?? []
        return elements.compactMap(\.value)
    }
}

private struct Lenient<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}
