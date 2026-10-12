// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// When a gateway pinned by its leaf certificate may be trusted through the
/// system root store instead.
///
/// The rule matches the gateway's own pairing decision: only a DNS name can
/// carry a publicly trusted certificate, so an IP literal or a `localhost`
/// name never qualifies, and a pinned pairing to one stays strictly pinned.
/// A qualifying host must still present a chain that verifies under the
/// system roots for that exact name; this check only decides whether that
/// evaluation is worth running.
///
/// This file is shared with the notification-service extension.
public enum GatewayTrustPolicy {
    public static func systemTrustQualifies(host: String?) -> Bool {
        guard var name = host?.trimmingCharacters(in: .whitespaces), !name.isEmpty else {
            return false
        }
        if name.hasPrefix("["), name.hasSuffix("]") {
            name = String(name.dropFirst().dropLast())
        }
        if isIPLiteral(name) { return false }
        let lowered = name.lowercased()
        let bare = lowered.hasSuffix(".") ? String(lowered.dropLast()) : lowered
        return !bare.isEmpty && bare != "localhost" && !bare.hasSuffix(".localhost")
    }

    private static func isIPLiteral(_ value: String) -> Bool {
        var v4 = in_addr()
        var v6 = in6_addr()
        // A zone index (`fe80::1%en0`) is not part of the address itself.
        let address = value.split(separator: "%", maxSplits: 1).first.map(String.init) ?? value
        return inet_pton(AF_INET, address, &v4) == 1 || inet_pton(AF_INET6, address, &v6) == 1
    }
}
