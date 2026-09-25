// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Observation)
import Observation
#endif

/// The only authority carried by an access-authorization deep link is the
/// temporary user code. The phone always resolves it through its current
/// paired Gateway; URLs, tokens, request ids, and grant choices are rejected.
@available(iOS 17.0, macOS 14.0, *)
struct AccessAuthorizationDeepLink: Equatable, Sendable {
    static let scheme = "omnesis"
    static let host = "access-authorization"
    static let version = "1"

    let code: String

    init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme,
              url.host?.lowercased() == Self.host,
              url.user == nil,
              url.password == nil,
              url.port == nil,
              url.path.isEmpty,
              url.fragment == nil,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              items.count == 2,
              items.map(\.name).sorted() == ["code", "v"],
              items.first(where: { $0.name == "v" })?.value == Self.version,
              let rawCode = items.first(where: { $0.name == "code" })?.value,
              Self.canonicalCode(rawCode) == rawCode
        else { return nil }
        code = rawCode
    }

    /// Mirrors the Gateway's user-code normalization and alphabet exactly.
    static func canonicalCode(_ value: String) -> String? {
        let compact = value.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        let alphabet = Set("23456789ABCDEFGHJKLMNPQRSTUVWXYZ")
        guard compact.count == 8, compact.allSatisfy(alphabet.contains) else { return nil }
        let split = compact.index(compact.startIndex, offsetBy: 4)
        return "\(compact[..<split])-\(compact[split...])"
    }
}

/// Non-secret identity of the pairing that was active when the QR was opened.
/// A handoff is discarded if the phone changes pairing before consuming it.
@available(iOS 17.0, macOS 14.0, *)
struct AccessAuthorizationPairingKey: Equatable, Sendable {
    let gatewayURL: String
    let deviceId: String
    let generation: String?
}

/// Buffers a deep link across a paired app's cold launch until `HomeView`
/// exists. The value is consumed once and bound to the pairing that received
/// it; the Gateway remains the authority on the user code's expiration.
@available(iOS 17.0, macOS 14.0, *)
@MainActor
@Observable
final class AccessAuthorizationDeepLinkRouter {
    static let shared = AccessAuthorizationDeepLinkRouter()

    private(set) var requestCount = 0
    private var pendingCode: String?
    private var pairingKey: AccessAuthorizationPairingKey?

    init() {}

    func request(
        code: String,
        pairingKey: AccessAuthorizationPairingKey
    ) {
        pendingCode = code
        self.pairingKey = pairingKey
        requestCount += 1
    }

    func consume(pairingKey currentPairingKey: AccessAuthorizationPairingKey) -> String? {
        defer {
            pendingCode = nil
            pairingKey = nil
        }
        guard pairingKey == currentPairingKey else { return nil }
        return pendingCode
    }
}
