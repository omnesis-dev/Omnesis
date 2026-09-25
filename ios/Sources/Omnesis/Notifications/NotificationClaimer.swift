// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif

public enum ClaimedNotificationRoute: Equatable, Sendable, Decodable {
    case agentAnswer(conversationId: String)
    case conversation(conversationId: String)
    case brief(briefId: String)
    case watch(watchId: String, firingKey: String, conversationId: String?)
    case needsAuth(sourceId: String, providerId: String?)
    case privacyApproval(approvalId: String)
    case accessAuthorization
    case unknown

    private enum CodingKeys: String, CodingKey {
        case kind, conversationId, briefId, watchId, firingKey
        case sourceId, providerId, approvalId
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .kind) {
        case "agent-answer":
            if let id = try? values.decode(String.self, forKey: .conversationId) {
                self = .agentAnswer(conversationId: id)
            } else {
                self = .unknown
            }
        case "conversation":
            if let id = try? values.decode(String.self, forKey: .conversationId) {
                self = .conversation(conversationId: id)
            } else {
                self = .unknown
            }
        case "brief":
            if let id = try? values.decode(String.self, forKey: .briefId) {
                self = .brief(briefId: id)
            } else {
                self = .unknown
            }
        case "watch":
            if let watchId = try? values.decode(String.self, forKey: .watchId),
               let firingKey = try? values.decode(String.self, forKey: .firingKey) {
                self = .watch(
                    watchId: watchId,
                    firingKey: firingKey,
                    conversationId: try? values.decodeIfPresent(String.self, forKey: .conversationId)
                )
            } else {
                self = .unknown
            }
        case "needs-auth":
            if let sourceId = try? values.decode(String.self, forKey: .sourceId) {
                self = .needsAuth(
                    sourceId: sourceId,
                    providerId: try? values.decodeIfPresent(String.self, forKey: .providerId)
                )
            } else {
                self = .unknown
            }
        case "privacy-approval":
            if let id = try? values.decode(String.self, forKey: .approvalId) {
                self = .privacyApproval(approvalId: id)
            } else {
                self = .unknown
            }
        case "access-authorization":
            self = .accessAuthorization
        default:
            self = .unknown
        }
    }
}

/// One notification leased to this device. Content reaches the phone only over
/// its pinned gateway connection; APNs carries the same constant wake for every
/// item.
public struct ClaimedNotification: Decodable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let targetId: String
    /// Device that owns a source-permission problem. Nil for all other kinds
    /// and for claims minted by older gateways.
    public let affectedDeviceId: String?
    public let sourceName: String?
    public let affectedDeviceName: String?
    public let title: String
    public let body: String
    public let collapseId: String
    public let remaining: Int
    public let route: ClaimedNotificationRoute?

    public init(
        id: String,
        kind: String,
        targetId: String,
        affectedDeviceId: String? = nil,
        sourceName: String? = nil,
        affectedDeviceName: String? = nil,
        title: String,
        body: String,
        collapseId: String,
        remaining: Int,
        route: ClaimedNotificationRoute? = nil
    ) {
        self.id = id
        self.kind = kind
        self.targetId = targetId
        self.affectedDeviceId = affectedDeviceId
        self.sourceName = sourceName
        self.affectedDeviceName = affectedDeviceName
        self.title = title
        self.body = body
        self.collapseId = collapseId
        self.remaining = remaining
        self.route = route
    }

    /// Stable across lease retries so the OS replaces a banner whose render
    /// succeeded but whose gateway confirmation did not.
    public var localRequestIdentifier: String {
        collapseId
    }

    /// The local tap payload. Route metadata reaches this point only over the
    /// paired gateway connection; the carrier wake remains constant.
    public var userInfo: [AnyHashable: Any] {
        let matchedRoute = route.flatMap { route -> ClaimedNotificationRoute? in
            switch (kind, route) {
            case ("agent-answer", .agentAnswer(_)),
                 ("conversation", .conversation(_)),
                 ("brief", .brief(_)),
                 ("watch", .watch(_, _, _)),
                 ("needs-auth", .needsAuth(_, _)),
                 ("privacy-approval", .privacyApproval(_)),
                 ("access-authorization", .accessAuthorization):
                route
            default:
                nil
            }
        }
        var omnesis: [String: Any] = switch matchedRoute {
        case .agentAnswer(let conversationId):
            ["kind": "agent-answer", "targetId": conversationId]
        case .conversation(let conversationId):
            ["kind": "conversation", "targetId": conversationId]
        case .brief(let briefId):
            ["kind": "brief", "targetId": briefId]
        case .watch(let watchId, let firingKey, let conversationId):
            // A firing the agent opened a thread about lands in the thread,
            // whose opening sentence this banner is quoting. One it did not
            // lands on the firing's line of the watch's ledger.
            if let conversationId, !conversationId.isEmpty {
                ["kind": "agent-answer", "targetId": conversationId]
            } else {
                ["kind": "watch-firing", "watchId": watchId, "firingKey": firingKey]
            }
        case .needsAuth(let sourceId, _):
            ["kind": "needs-auth", "targetId": sourceId]
        case .privacyApproval(let approvalId):
            ["kind": "privacy-approval", "targetId": approvalId]
        case .accessAuthorization:
            ["kind": "access-authorization", "targetId": "access"]
        case .unknown, nil:
            ["kind": kind, "targetId": targetId]
        }
        if let affectedDeviceId {
            omnesis["affectedDeviceId"] = affectedDeviceId
        }
        if let sourceName {
            omnesis["sourceName"] = sourceName
        }
        if let affectedDeviceName {
            omnesis["affectedDeviceName"] = affectedDeviceName
        }
        return ["omnesis": omnesis]
    }

    /// String-only view used by routing tests and older call sites.
    public var routingPayload: [String: String] {
        userInfo["omnesis"] as? [String: String] ?? [
            "kind": kind,
            "targetId": targetId,
        ]
    }
}

#if canImport(UserNotifications)
/// A claim must remain leased at the gateway unless iOS can visibly present
/// its locally rendered notification. Scheduled Summary and Notification
/// Center delivery are still visible; a disabled banner alone therefore does
/// not discard an otherwise usable presentation path.
@available(iOS 15.0, macOS 12.0, *)
public enum NotificationPresentationPolicy {
    public static let foregroundOptions: UNNotificationPresentationOptions = [.banner, .list, .sound]

    public static func canVisiblyPresent(
        authorization: UNAuthorizationStatus,
        alert: UNNotificationSetting,
        notificationCenter: UNNotificationSetting
    )
        -> Bool {
        switch authorization {
        case .authorized, .provisional, .ephemeral:
            alert == .enabled || notificationCenter == .enabled
        case .denied, .notDetermined:
            false
        @unknown default:
            false
        }
    }

    public static func canVisiblyPresent(using center: UNUserNotificationCenter) async -> Bool {
        let settings = await center.notificationSettings()
        return canVisiblyPresent(
            authorization: settings.authorizationStatus,
            alert: settings.alertSetting,
            notificationCenter: settings.notificationCenterSetting
        )
    }
}

@available(iOS 15.0, macOS 12.0, *)
public func applyClaimedNotification(
    _ claimed: ClaimedNotification,
    to content: UNMutableNotificationContent
) {
    content.title = claimed.title
    content.body = claimed.body
    content.badge = NSNumber(value: claimed.remaining)
    if claimed.kind == "agent-answer" {
        content.interruptionLevel = .timeSensitive
    }
    content.userInfo = claimed.userInfo
}
#endif

public enum NotificationClaimerError: Error, Equatable {
    case invalidURL
    case invalidResponse
    case serverError(status: Int, body: String)
}

/// Only a coarse failure category is shared with the app. Push carriers and
/// diagnostic storage contain no notification title, body, or target ID.
public enum NotificationClaimDiagnostic {
    public enum Reason: String, Codable {
        case unreachable
        case certificate
        case pairing
        case other

        public var detail: String {
            switch self {
            case .unreachable:
                "A recent notification wake could not reach the gateway for its private text. If away from home, connect Tailscale on both devices and pair with the gateway's Tailscale hostname."
            case .certificate:
                "A recent notification wake could not verify the gateway's certificate. Check the paired hostname and re-pair using a new QR code if it changed."
            case .pairing:
                "The gateway rejected this phone's credential during a recent notification wake. Re-pair this phone from Settings if it continues."
            case .other:
                "A recent notification wake could not fetch its private text. Check the gateway connection if it continues."
            }
        }
    }

    public struct Attempt: Sendable {
        public let startedAt: Date

        public init(startedAt: Date = Date()) {
            self.startedAt = startedAt
        }
    }

    private struct Failure: Codable {
        let startedAt: Date
        let reason: Reason
    }

    private static let failureKey = "notification.claim.failure.v2"
    private static let legacyFailureKey = "notification.claim.failure.v1"
    private static let failureLifetime: TimeInterval = 24 * 60 * 60

    public static func classify(_ error: Error) -> Reason {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot,
                 .secureConnectionFailed:
                return .certificate
            default:
                return .unreachable
            }
        }
        if let claimError = error as? NotificationClaimerError,
           case .serverError(let status, _) = claimError,
           status == 401 || status == 403 {
            return .pairing
        }
        return .other
    }

    public static func record(
        _ error: Error,
        attempt: Attempt,
        keychain: PairingStore = NotificationClaimCredentials.sharedKeychain()
    ) {
        record(classify(error), attempt: attempt, keychain: keychain)
    }

    public static func record(
        _ reason: Reason,
        attempt: Attempt,
        keychain: PairingStore = NotificationClaimCredentials.sharedKeychain()
    ) {
        let failure = Failure(startedAt: attempt.startedAt, reason: reason)
        if let raw = encode(failure) { try? keychain.set(raw, forKey: failureKey) }
    }

    public static func current(
        at now: Date = Date(),
        keychain: PairingStore = NotificationClaimCredentials.sharedKeychain()
    )
        -> Reason? {
        guard let failure = decode(Failure.self, from: try? keychain.get(failureKey)),
              failure.startedAt <= now,
              now.timeIntervalSince(failure.startedAt) < failureLifetime
        else { return nil }
        return failure.reason
    }

    public static func clear(keychain: PairingStore = NotificationClaimCredentials.sharedKeychain()) {
        try? keychain.delete(failureKey)
        try? keychain.delete(legacyFailureKey)
    }

    public static func recordTimeoutIfNeeded(
        claimCompleted: Bool,
        recordedFailure: Bool,
        attempt: Attempt,
        keychain: PairingStore = NotificationClaimCredentials.sharedKeychain()
    ) {
        if !claimCompleted, !recordedFailure {
            record(URLError(.timedOut), attempt: attempt, keychain: keychain)
        }
    }

    private static func encode(_ value: some Encodable) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func decode<Value: Decodable>(_ type: Value.Type, from raw: String?) -> Value? {
        guard let raw, let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

/// Drain a bounded FIFO slice while proving the pairing and visible delivery
/// path are current before leasing and immediately before rendering. A
/// successful render is the commit point: confirm it even if state changes
/// afterward, otherwise a lease retry would duplicate visible content. The
/// caller serializes invocations so socket and foreground triggers cannot
/// reorder local banners.
@discardableResult
public func drainClaimedNotifications<Session>(
    session: Session,
    maxItems: Int,
    isCurrent: (Session) async -> Bool,
    claim: () async throws -> ClaimedNotification?,
    render: (ClaimedNotification) async throws -> Void,
    confirm: (String) async throws -> Void,
    canPresent: () async -> Bool
) async
    -> Int {
    guard maxItems > 0 else { return 0 }
    var delivered = 0
    for _ in 0 ..< maxItems {
        guard await isCurrent(session), await canPresent() else { break }
        guard let item = try? await claim() else { break }
        // This is the final visibility/session boundary. Once render returns,
        // the notification has been accepted by the OS (or the service
        // extension has prepared the content it will hand back), so leaving
        // the lease unconfirmed would only cause a duplicate retry.
        guard await isCurrent(session), await canPresent() else { break }
        do {
            try await render(item)
        } catch {
            break
        }
        do {
            try await confirm(item.id)
            delivered += 1
        } catch {
            break
        }
    }
    return delivered
}

/// Device-scoped gateway client shared by the app and notification service
/// extension. Its token needs only the `push:claim` scope.
public struct NotificationClaimer: Sendable {
    public typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let baseURL: URL
    private let token: String
    private let request: Request

    public init(baseURL: URL, token: String, session: URLSession) {
        self.init(baseURL: baseURL, token: token) { request in
            try await session.data(for: request)
        }
    }

    public init(baseURL: URL, token: String, request: @escaping Request) {
        self.baseURL = baseURL
        self.token = token
        self.request = request
    }

    /// Atomically leases the oldest pending delivery. A 204 means the wake was
    /// redundant (already claimed, superseded, or expired).
    public func claim() async throws -> ClaimedNotification? {
        let response = try await send(path: "/notifications/claim", body: EmptyBody())
        if response.statusCode == 204 {
            return nil
        }
        guard (200 ... 299).contains(response.statusCode) else {
            throw serverError(response)
        }
        do {
            return try JSONDecoder().decode(ClaimedNotification.self, from: response.data)
        } catch {
            throw NotificationClaimerError.invalidResponse
        }
    }

    /// Closes a lease only after the extension has prepared the banner.
    public func confirm(id: String) async throws {
        let response = try await send(
            path: "/notifications/confirm",
            body: ConfirmBody(id: id)
        )
        guard (200 ... 299).contains(response.statusCode) else {
            throw serverError(response)
        }
    }

    private func send(path: String, body: some Encodable) async throws
        -> (data: Data, statusCode: Int) {
        guard baseURL.scheme?.lowercased() == "https",
              let url = URL(string: path, relativeTo: baseURL)?.absoluteURL
        else {
            throw NotificationClaimerError.invalidURL
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await request(urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw NotificationClaimerError.invalidResponse
        }
        return (data, http.statusCode)
    }

    private func serverError(_ response: (data: Data, statusCode: Int))
        -> NotificationClaimerError {
        .serverError(
            status: response.statusCode,
            body: String(data: response.data, encoding: .utf8) ?? ""
        )
    }

    private struct EmptyBody: Encodable {}
    private struct ConfirmBody: Encodable { let id: String }
}

/// Loads the minimum authority the extension needs from the app's shared
/// keychain group and preserves the pairing's explicit TLS trust mode.
public enum NotificationClaimCredentials {
    enum Keys {
        static let credential = "notification.credential.v1"
        static let url = "notification.gateway.url"
        static let token = "notification.gateway.token"
        static let deviceId = "notification.gateway.deviceId"
        static let fingerprint = "notification.gateway.fingerprint"
    }

    public static func sharedKeychain() -> Keychain {
        Keychain(
            service: "dev.omnesis.ios.notifications",
            accessGroup: Bundle.main.object(
                forInfoDictionaryKey: "OmnesisKeychainAccessGroup"
            ) as? String
        )
    }

    public static func clear(keychain: Keychain? = nil) {
        let resolved = keychain ?? sharedKeychain()
        try? resolved.deleteAll()
    }

    struct StoredCredential: Codable, Equatable {
        let url: String
        let token: String
        let deviceId: String
        let tlsMode: String?
        let fingerprint: String?

        init(
            url: String,
            token: String,
            deviceId: String,
            tlsMode: String? = nil,
            fingerprint: String?
        ) {
            self.url = url
            self.token = token
            self.deviceId = deviceId
            self.tlsMode = tlsMode
            self.fingerprint = fingerprint
        }
    }

    static func stored(keychain: PairingStore) throws -> StoredCredential? {
        guard let raw = try keychain.get(Keys.credential),
              let data = raw.data(using: .utf8)
        else { return nil }
        return try? JSONDecoder().decode(StoredCredential.self, from: data)
    }

    static func commit(_ credential: StoredCredential, keychain: PairingStore) throws {
        let data = try JSONEncoder().encode(credential)
        guard let raw = String(data: data, encoding: .utf8) else {
            throw NotificationClaimerError.invalidResponse
        }
        // One Keychain item is the transaction boundary: an extension can see
        // the complete old credential, no credential during replacement, or
        // the complete new credential, but never mixed routing fields.
        try keychain.set(raw, forKey: Keys.credential)
        NotificationClaimDiagnostic.clear(keychain: keychain)
        // Remove the pre-bundle representation after commit. `load` retains a
        // read-only fallback so upgrades can consume an older stored identity.
        try? keychain.delete(Keys.url)
        try? keychain.delete(Keys.token)
        try? keychain.delete(Keys.deviceId)
        try? keychain.delete(Keys.fingerprint)
    }

    public static func load(keychain: Keychain? = nil) -> NotificationClaimer? {
        let resolvedKeychain = keychain ?? sharedKeychain()
        let bundled: StoredCredential? = try? stored(keychain: resolvedKeychain)
        let rawURL = bundled?.url ??
            (try? resolvedKeychain.get(Keys.url))
        let token = bundled?.token ??
            (try? resolvedKeychain.get(Keys.token))
        let fingerprint = bundled?.fingerprint ??
            (try? resolvedKeychain.get(Keys.fingerprint))
        let tlsMode = PairingTlsMode(rawValue: bundled?.tlsMode ?? "") ??
            (fingerprint == nil ? .legacy : .pinnedLeaf)
        guard let rawURL,
              let baseURL = URL(string: rawURL),
              let token,
              !token.isEmpty
        else {
            return nil
        }
        let session: URLSession
        switch tlsMode {
        case .system:
            guard baseURL.scheme?.lowercased() == "https" else { return nil }
            session = URLSession.shared
        case .pinnedLeaf:
            guard let fingerprint,
                  fingerprint.count == 64,
                  fingerprint.allSatisfy(\.isHexDigit)
            else { return nil }
            session = PinnedSession(fingerprintHex: fingerprint).session
        case .legacy:
            return nil
        }
        return NotificationClaimer(baseURL: baseURL, token: token, session: session)
    }
}
