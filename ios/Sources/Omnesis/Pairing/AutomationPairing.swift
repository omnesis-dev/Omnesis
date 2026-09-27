// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if DEBUG && canImport(UIKit)
/// Launch-time pairing state for UI automation, applied before `AppStore`
/// reads the Keychain. Absent from release builds.
///
/// - `DEMO_RESET_PAIRING=1` clears the stored pairing and the notification
///   claim credential, so a journey can start unpaired. The simulator keeps
///   Keychain items across launches and reinstalls.
/// - `DEMO_PAIRING_JSON`, or the `-pairingFile` / `-pairingFileName` launch
///   arguments, seed a pairing so automation can start paired without scanning
///   a QR code. The JSON carries the gateway URL and a token, and optionally a
///   TLS fingerprint for a gateway with a self-signed certificate: with it,
///   `OmnesisURLSession` builds a `PinnedSession` that trusts the gateway.
enum AutomationPairing {
    static func applyLaunchEnvironment() {
        if ProcessInfo.processInfo.environment["DEMO_RESET_PAIRING"] == "1" {
            try? Keychain().deleteAll()
            NotificationClaimCredentials.clear()
        }
        guard let data = suppliedPairing(),
              let config = try? JSONDecoder().decode(AutomationPairingConfig.self, from: data)
        else { return }
        let store = Keychain()
        let tlsMode = PairingTlsMode(rawValue: config.tlsMode ?? "") ??
            (config.fingerprint == nil ? .legacy : .pinnedLeaf)
        let credential = PairingCredentialBundle(
            url: config.url,
            token: config.token,
            accountId: "local",
            deviceId: config.deviceId ?? "demo",
            name: config.name ?? "Demo Gateway",
            scopes: [],
            tlsMode: tlsMode.rawValue,
            fingerprint: tlsMode == .system ? nil : config.fingerprint
        )
        if let encoded = try? credential.encoded() {
            try? store.set(encoded, forKey: PairingCredentialBundle.key)
        }
        if let claimToken = config.claimToken,
           tlsMode != .legacy {
            let notificationStore = NotificationClaimCredentials.sharedKeychain()
            try? NotificationClaimCredentials.commit(
                .init(
                    url: config.url,
                    token: claimToken,
                    deviceId: config.deviceId ?? "demo",
                    tlsMode: tlsMode.rawValue,
                    fingerprint: tlsMode == .system ? nil : config.fingerprint
                ),
                keychain: notificationStore
            )
        }
        OmnesisURLSession.reset()
    }

    private static func suppliedPairing() -> Data? {
        if let json = ProcessInfo.processInfo.environment["DEMO_PAIRING_JSON"] {
            return json.data(using: .utf8)
        }
        if let idx = CommandLine.arguments.firstIndex(of: "-pairingFile"),
           idx + 1 < CommandLine.arguments.count {
            return FileManager.default.contents(
                atPath: CommandLine.arguments[idx + 1]
            )
        }
        if let idx = CommandLine.arguments.firstIndex(of: "-pairingFileName"),
           idx + 1 < CommandLine.arguments.count,
           let documents = FileManager.default.urls(
               for: .documentDirectory,
               in: .userDomainMask
           ).first {
            return FileManager.default.contents(
                atPath: documents.appendingPathComponent(
                    CommandLine.arguments[idx + 1],
                    isDirectory: false
                ).path
            )
        }
        return nil
    }
}

/// JSON shape read from `DEMO_PAIRING_JSON` or the `-pairingFile` launch
/// argument. Allows XCUITest automation to pair the app without a QR scan.
struct AutomationPairingConfig: Decodable {
    let url: String
    let token: String
    var deviceId: String?
    var name: String?
    /// TLS leaf-cert SHA-256 fingerprint (lowercase hex). Required
    /// when the demo gateway uses HTTPS with a self-signed cert.
    var fingerprint: String?
    /// Explicit transport trust mode. Omitted fixtures infer pinned trust from
    /// a fingerprint and legacy behavior otherwise.
    var tlsMode: String?
    /// DEBUG automation only: least-privilege token placed in the extension's
    /// separate keychain group for notification claim/confirm requests.
    var claimToken: String?
}
#endif
