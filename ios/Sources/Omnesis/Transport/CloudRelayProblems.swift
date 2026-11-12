// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What is wrong with this gateway's Omnesis account link or remote access: a plain
/// sentence per problem, and the details to paste when asking for help. The portal's
/// `relay-problems.js` says the same.
extension CloudRelayPresentation {
    /// Every error code the gateway reports, with where it came from.
    private static func reported(_ status: CloudRelayStatus) -> [(source: String, code: String)] {
        let all: [(String, String?)] = [
            ("connect", status.connect?.error),
            ("registration", status.enrollment?.error),
            ("tunnel", status.tunnel?.lastError),
            ("certificate", status.certificate?.lastError),
            ("address", status.publicMcp?.lastError),
            ("certificate monitor", status.certificateMonitor?.lastError),
            ("service", status.serviceError),
            ("account", status.account?.lastError),
            ("google", status.google?.lastError),
        ]
        return all.compactMap { source, code in
            guard let code, !code.isEmpty else { return nil }
            return (source, code)
        }
    }

    /// The sentences to show, each once. A problem the headline already states (a failed
    /// connect, a dropped connection, an unavailable service) is not repeated.
    public static func problems(_ status: CloudRelayStatus) -> [String] {
        let inHeadline: [String] = switch status.phase {
        case .failed: ["connect", "registration"]
        case .disconnected: ["tunnel"]
        case .unavailable: ["service"]
        default: []
        }
        var messages = reported(status).filter { !inHeadline.contains($0.source) }.map { error($0.code) }
        if status.enabled, status.certificate?.state == "expired" {
            messages.append(
                "The certificate for this gateway's address has expired, so devices away from home cannot connect. "
                    + "The gateway keeps trying to renew it."
            )
        }
        if status.enabled, status.certificate?.state == "expiring" {
            let until = date(status.certificate?.expiresAt) ?? "a date soon"
            messages.append(
                "The certificate for this gateway's address expires on \(until). The gateway renews it by itself. "
                    + "If this message stays for more than a day, ask for help."
            )
        }
        if status.certificateMonitor?.incidents.isEmpty == false {
            messages.append(
                "A certificate for this gateway's address was issued with a key this gateway does not hold. Someone else "
                    + "may be able to pose as this gateway. Copy the details and ask for help before you add new devices."
            )
        }
        var unique: [String] = []
        for message in messages where !unique.contains(message) {
            unique.append(message)
        }
        return unique
    }

    /// Whether the problems box is shown. A failed connect or a dropped connection is
    /// said in the headline; the details still help.
    public static func troubled(_ status: CloudRelayStatus) -> Bool {
        !problems(status).isEmpty || status.phase == .failed || status.phase == .disconnected
    }

    public static func problemsTitle(count: Int) -> String {
        count > 1 ? "Some things need your attention" : "Something needs your attention"
    }

    public static let problemsHelp = "Need help? Copy the details and paste them to an assistant or a help forum. "
        + "They contain no passwords or keys. Running omnesis cloud status on this gateway prints the same details."

    /// The plain-text block a person pastes to an assistant or a forum. It carries public
    /// facts only: addresses, states, dates and error codes. No token, key or sign-in
    /// identifier is in the status this reads, and none is added here.
    public static func diagnostics(_ status: CloudRelayStatus, now: Date = Date()) -> String {
        var codes = reported(status).map { "\(plain($0.code)) (\($0.source))" }
        if status.certificate?.state == "expired" { codes.append("certificate-expired (certificate)") }
        if status.certificate?.state == "expiring" { codes.append("certificate-expiring (certificate)") }
        let monitor = status.certificateMonitor
        let incidents = monitor?.incidents ?? []
        if !incidents.isEmpty { codes.append("unexpected-certificate (certificate monitor)") }
        let address = status.publicMcp
        let answering = address?.ready == true ? "answering" : address?.lastError != nil ? "not answering" : "not confirmed"
        let certificate = status.certificate
        let account = accountLinked(status)
            ? "connected"
            : status.account?.pendingUnlink == true ? "disconnected here, account not updated yet" : "not connected"
        var lines = [
            "Omnesis account details",
            "Time: \(iso(now))",
            "Page state: \(status.phase.rawValue)",
            "Error codes: \(codes.isEmpty ? "none" : codes.joined(separator: ", "))",
            "Remote access: \(status.enabled ? "on" : "off")",
            "Address: \(plain(httpsURL(address?.url)?.absoluteString, "none")) (\(answering))",
            "Registration: \(plain(status.enrollment?.state)), gateway ID \(plain(status.gatewayId, "none"))",
            "Tunnel: \(plain(status.tunnel?.state)), last connected \(iso(status.tunnel?.lastConnectedAt?.date))",
            "Public certificate: \(plain(certificate?.state)), expires \(iso(certificate?.expiresAt?.date)), "
                + "last renewed \(iso(certificate?.lastRenewedAt?.date))",
            "Certificate monitor: \(plain(monitor?.state, "not reported")), last checked \(iso(monitor?.lastCompletedAt?.date))",
        ]
        lines += incidents.map(incidentLine)
        lines += [
            "Account: \(account)",
            "New devices: \(plain(status.deviceEnrollment?.policy, "not reported"))",
            "Relay: \(plain(httpsURL(status.config?.relayUrl)?.absoluteString, "none"))",
        ]
        return lines.joined(separator: "\n") + "\n"
    }

    private static func incidentLine(_ incident: CloudRelayStatus.Incident) -> String {
        "Unexpected certificate: name \(plain(incident.hostname)), public key \(plain(incident.spkiFingerprint)), "
            + "certificate \(plain(incident.certificateFingerprint)), issuer \(plain(incident.issuer)), "
            + "serial \(plain(incident.serial)), valid \(iso(incident.validFrom?.date)) to \(iso(incident.validTo?.date)), "
            + "seen \(iso(incident.observedAt?.date)), log entry \(plain(incident.providerEntryId))"
    }

    private static func iso(_ date: Date?) -> String {
        guard let date else { return "not recorded" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// One printable line: status values are data from the gateway, never layout.
    private static func plain(_ value: String?, _ fallback: String = "unknown") -> String {
        guard let value, !value.isEmpty else { return fallback }
        let printable = value.replacingOccurrences(of: "[^\\x20-\\x7e]+", with: " ", options: .regularExpression)
        return String(printable.prefix(300))
    }
}
