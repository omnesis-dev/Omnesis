// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(UIKit)
import UIKit
#endif

/// Reports the iOS-side APNs device token back to the gateway so the
/// `notify-ios` trigger action can fan out push notifications to this
/// phone.
///
/// Lifecycle:
///   1. Once the user has decided on notifications,
///      `AppStore.requestPushAndRegister()` calls
///      `UIApplication.registerForRemoteNotifications()`. The iOS prompt only
///      comes from `AppStore.requestNotificationPermission()`.
///   2. iOS calls `AppDelegate.application(_:didRegisterFor…:)` with
///      the device-token `Data`.
///   3. `PushRegistrar.report(...)` encodes the bytes as lowercase
///      hex, builds the JSON body, and POSTs to
///      `/admin/devices/:id/apns-token` using the paired admin token.
///   4. The gateway persists the registration; subsequent notify-ios
///      fan-outs include this device.
///
/// Environment is determined at compile time: `DEBUG` builds run on
/// the APNs sandbox; release / TestFlight / App Store builds run on
/// production. iOS issues different device tokens for the two
/// environments, so the gateway needs to know which APNs host to
/// hit — this is the simplest correct way to surface it from the
/// client.
@available(iOS 17.0, *)
public struct PushRegistrar: Sendable {
    public let baseURL: URL
    public let token: String
    public let deviceId: String
    public let bundleId: String
    private let session: URLSessionLike

    public init(
        baseURL: URL,
        token: String,
        deviceId: String,
        bundleId: String,
        session: URLSessionLike = OmnesisURLSession.shared
    ) {
        self.baseURL = baseURL
        self.token = token
        self.deviceId = deviceId
        self.bundleId = bundleId
        self.session = session
    }

    /// Convenience initialiser that pulls baseURL/token/deviceId from
    /// the current `Pairing` and bundleId from `Bundle.main`. Returns
    /// nil when any required piece is missing.
    public init?(pairing: Pairing, session: URLSessionLike = OmnesisURLSession.shared) {
        guard let bundleId = Bundle.main.bundleIdentifier else { return nil }
        self.init(
            baseURL: pairing.url,
            token: pairing.token,
            deviceId: pairing.deviceId,
            bundleId: bundleId,
            session: session
        )
    }

    /// Compile-time-pinned APNs environment. Debug builds register
    /// sandbox tokens; release / TestFlight / App Store builds
    /// register production tokens. This matches Apple's own
    /// behaviour: a debug-signed binary calls the development APS
    /// gateway, an Xcode-archive-signed binary calls production.
    public static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    /// Convert raw APNs device-token bytes (from
    /// `didRegisterForRemoteNotificationsWithDeviceToken`) to the
    /// lowercase hex string the APNs HTTP/2 path uses.
    public static func hexEncode(_ tokenData: Data) -> String {
        tokenData.map { String(format: "%02x", $0) }.joined()
    }

    public func report(tokenData: Data) async throws {
        let hex = Self.hexEncode(tokenData)
        try await report(tokenHex: hex, environment: Self.environment)
    }

    /// Lower-level entrypoint. Tests inject this directly with their
    /// own hex token + environment.
    public func report(tokenHex: String, environment: String) async throws {
        struct Body: Encodable {
            let deviceToken: String
            let environment: String
            let bundleId: String
        }
        let path = "/admin/devices/\(deviceId)/apns-token"
        guard let requestURL = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw PushRegistrarError.invalidURL
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            Body(deviceToken: tokenHex, environment: environment, bundleId: bundleId)
        )
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw PushRegistrarError.invalidResponse
        }
        if !(200 ... 299).contains(http.statusCode) {
            let text = String(data: data, encoding: .utf8) ?? ""
            throw PushRegistrarError.serverError(status: http.statusCode, body: text)
        }
    }
}

public enum PushRegistrarError: Error, Equatable {
    case invalidURL
    case invalidResponse
    case serverError(status: Int, body: String)
}
