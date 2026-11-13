// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The words of the Omnesis account screen. They match the portal's Settings →
/// Omnesis account page (`relay.js`, `relay-problems.js`, `cloud-relay-api.js`) so the two read alike.
public enum CloudRelayPresentation {
    /// What the portal offers and this screen does not: custom addresses, certificate
    /// directories and invitation files.
    public static let portalHint = "Open the portal on your gateway to finish this."

    /// This gateway watches public certificate logs for a certificate it did not ask for.
    private static let checkLater =
        "The check for unexpected certificates could not finish. It runs again by itself. Nothing else is affected."
    private static let checkBroken =
        "The check for unexpected certificates is not working. Remote access keeps working. Copy the details and ask for help."

    private static let addressUnreachable = "This gateway's address does not answer from outside your home network. "
        + "Check that this gateway is online. It checks again by itself."

    private static let errors: [String: String] = [
        "account-unavailable": "Omnesis account sign-in is unavailable. Direct connections and QR pairing remain available.",
        "account-link-failed":
            "Couldn't connect this gateway to your Omnesis account. Try again. Existing device access is unchanged.",
        "ct-configuration-invalid": checkBroken,
        "ct-provider-unavailable": checkLater,
        "ct-provider-refused": checkBroken,
        "ct-provider-invalid": checkLater,
        "ct-scan-incomplete": checkLater,
        "ct-journal-invalid": checkBroken,
        "ct-journal-write-failed": checkBroken,
        "hostname-conflict":
            "Choose a different public gateway hostname. This name is already covered by the direct/default certificate.",
        "hostname-required": "This relay needs a public gateway hostname. Enter its HTTPS origin in custom domain settings.",
        "ca-terms-required": "Accept the configured certificate authority’s terms before enabling public certificates.",
        "operation-in-progress": "Another change is in progress. Wait for it to finish and try again.",
        "google-unavailable": "Google sign-in is unavailable. Remote access and QR pairing work without it.",
        "google-link-failed": "Couldn't connect with Google. Try again. Gateway access is unchanged.",
        "relay-service-unavailable":
            "Omnesis account setup is unavailable. Ask the installation administrator to configure the relay service.",
        "relay-service-mismatch":
            "The installation service configuration does not match this gateway. Ask the installation administrator to resolve it.",
        "configuration-invalid": "Check the public gateway origin and certificate settings.",
        "relay-unreachable":
            "Omnesis Relay could not be reached. Check this gateway's internet connection. It keeps trying by itself.",
        "invitation-required": "This relay requires an invitation for this gateway ID.",
        "enrollment-refused":
            "This gateway couldn't register with Omnesis Relay. It keeps trying by itself. If this message stays, try connecting again.",
        "tunnel-disconnected": "Remote access was interrupted. Reconnect to try again.",
        "certificate-setup-failed":
            "The certificate for this gateway's address could not be prepared. The gateway tries again by itself.",
        "certificate-renewal-failed":
            "The certificate for this gateway's address could not be renewed. The gateway tries again by itself.",
        "public-endpoint-unreachable": addressUnreachable,
    ]

    /// Failures only the portal's manual setup form can resolve.
    private static let manualSetupErrors: Set = [
        "hostname-conflict", "hostname-required", "ca-terms-required", "configuration-invalid", "invitation-required",
    ]

    /// Whether the gateway names `code` as one this screen has words for.
    public static func knowsError(_ code: String?) -> Bool {
        code.map { errors[$0] != nil } ?? false
    }

    /// The portal's text for a relay error code, with where to go when only manual setup fixes it.
    public static func error(_ code: String?) -> String {
        guard let code, !code.isEmpty else { return "" }
        let text = errors[code] ?? "An operation failed. Check settings and retry."
        return manualSetupErrors.contains(code) ? "\(text) \(portalHint)" : text
    }

    // MARK: - Hero

    public struct Hero: Equatable, Sendable {
        public let title: String
        /// Set apart from the title: the address this gateway is connected as.
        public var hostname: String?
        public let lede: String
    }

    public static func hero(_ status: CloudRelayStatus) -> Hero {
        switch status.phase {
        case .notConnected:
            Hero(
                title: "Enroll this gateway in your Omnesis Account",
                lede: "An Omnesis account lets you reach your gateway from your phone and laptop outside your home network "
                    + "and pair new devices by signing in. Traffic is encrypted end to end, and the keys never leave this "
                    + "gateway. Connecting gives this gateway a public address and a certificate."
            )
        case .waiting:
            Hero(
                title: "Sign in to your Omnesis account",
                lede: "Continue in the sign-in page to finish connecting. This screen updates by itself."
            )
        case .registering:
            Hero(
                title: "Registering this gateway…",
                lede: "Getting its address and certificate. This usually takes less than a minute."
            )
        case .linking:
            Hero(title: "Connecting to your Omnesis account…", lede: "Almost done.")
        case .failed:
            Hero(
                title: "Couldn't connect",
                lede: (status.connect?.error ?? status.enrollment?.error).map { error($0) }
                    ?? "The connection could not be set up. Nothing on this gateway changed."
            )
        case .connected:
            Hero(
                title: "Connected as",
                hostname: status.hostname ?? "your gateway",
                lede: "Your devices can reach this gateway from anywhere. "
                    + "Traffic is encrypted end to end, and the keys never leave this gateway."
            )
        case .reconnecting:
            Hero(
                title: "Reconnecting…",
                lede: "Devices on your home network keep working. "
                    + "Devices away from home reconnect when the connection returns."
            )
        case .disconnected:
            Hero(
                title: "Disconnected",
                lede: status.tunnel?.lastError.map { error($0) } ?? "Remote access dropped. Devices on your home network keep working."
            )
        case .off:
            Hero(
                title: "Remote access is off",
                lede: "This gateway keeps its address. Turn remote access back on to reach it from anywhere."
            )
        case .unavailable:
            Hero(
                title: "Remote access isn't available",
                lede: status.serviceError.map { error($0) }
                    ?? "This installation is not set up for Omnesis accounts. Direct connections and QR pairing keep working."
            )
        }
    }

    // MARK: - Account

    /// Whether this gateway has an account section to show: an Omnesis account, or the older Google-only link.
    public static func accountShown(_ status: CloudRelayStatus) -> Bool {
        usesOmnesisAccount(status) || status.google?.configured == true || status.google?.linked == true
    }

    /// False for a gateway that only has the older Google link.
    public static func usesOmnesisAccount(_ status: CloudRelayStatus) -> Bool {
        let account = status.account
        return account?.activated == true || account?.configured == true || account?.linked == true || account?.pendingUnlink == true
    }

    /// Whether this gateway is on an account, by either kind of link.
    public static func accountLinked(_ status: CloudRelayStatus) -> Bool {
        usesOmnesisAccount(status) ? status.account?.linked == true : status.google?.linked == true
    }

    public static func accountLine(_ status: CloudRelayStatus) -> String {
        let linked = accountLinked(status)
        if usesOmnesisAccount(status) {
            return linked ? "This gateway is linked to your Omnesis account." : "This gateway is not linked to an Omnesis account."
        }
        return linked ? "This gateway is connected with Google." : "This gateway is not connected with Google."
    }

    /// What to know while the gateway is not on an account. Linking a registered gateway ends
    /// on the gateway's own page, in a browser that holds a portal session, so it stays in the portal.
    public static func accountHints(_ status: CloudRelayStatus) -> [String] {
        guard !accountLinked(status) else { return [] }
        guard usesOmnesisAccount(status) else {
            let hint = "Connect with Google to find this gateway on your other devices. QR pairing works without it."
            return status.google?.canLink == true ? [hint, portalHint] : [hint]
        }
        if status.account?.pendingUnlink == true {
            return ["Disconnected here. Your Omnesis account updates when the connection returns."]
        }
        let hint = "Connect it to find this gateway when you sign in on a new device. QR pairing works without an account."
        return status.account?.canLink == true ? [hint, portalHint] : [hint]
    }

    public static let manageAccount = "Manage your account"
    public static let unlink = "Unlink this gateway"
    public static let unlinking = "Unlinking…"
    public static let unlinkTitle = "Unlink this gateway from your Omnesis account?"
    public static let unlinkConfirm = "Unlink"
    public static let unlinkMessage = "This gateway leaves your Omnesis account. It can no longer be reached from outside your "
        + "home network, and devices can no longer join by signing in. Devices already paired keep working on your home network."

    // MARK: - Remote access

    /// One line on why the address cannot be used right now, or nil once it answers. A gateway
    /// that has not reported a failed check is still checking, never failing.
    public static func addressState(_ status: CloudRelayStatus) -> String? {
        if !status.enabled { return "Not reachable while remote access is off." }
        if status.publicMcp?.ready == true { return nil }
        if status.tunnel?.state != "online" { return "Not reachable while this gateway is disconnected from the relay." }
        if status.publicMcp?.lastError != nil { return "This address does not answer right now." }
        return "Checking that this address answers. This takes up to a minute after the gateway connects."
    }

    public static let turnOffFootnote = "Turning it off stops access from outside your home network. "
        + "This gateway keeps its address and stays in your Omnesis account."
    public static let turnOnFootnote = "Turn it on to reach this gateway from outside your home network again, at the same address."

    // MARK: - New devices

    public struct PolicyChoice: Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        public let text: String
    }

    public static let policyChoices = [
        PolicyChoice(
            id: "automatic",
            title: "Join automatically",
            text: "A device joins once you sign in to your Omnesis account with a sign-in this gateway trusts. "
                + "You're notified and can remove it any time."
        ),
        PolicyChoice(
            id: "ask",
            title: "Ask me first",
            text: "A device waits until you approve it on a device you already use, and the codes match. "
                + "Someone with your Google password still can't get in."
        ),
    ]

    // MARK: - Dates

    /// A calendar date such as "10 Jan 2027", or nil without one.
    public static func date(_ value: CloudRelayTimestamp?) -> String? {
        value?.date?.formatted(.dateTime.day().month(.abbreviated).year())
    }

    /// A clock time such as "16:42", for short-lived codes.
    public static func clock(_ value: CloudRelayTimestamp?) -> String? {
        value?.date?.formatted(.dateTime.hour().minute())
    }

    // MARK: - Addresses

    /// An HTTPS address without credentials; anything else is not opened or shown as a link.
    public static func httpsURL(_ value: String?) -> URL? {
        guard let value, value.count <= 2048, let parts = URLComponents(string: value), parts.scheme?.lowercased() == "https",
              parts.host?.isEmpty == false, parts.user == nil, parts.password == nil else { return nil }
        return parts.url
    }

    /// An already checked address without its scheme, so it reads like something to type.
    public static func displayAddress(_ url: URL) -> String {
        let host = url.port.map { "\(url.host ?? ""):\($0)" } ?? url.host ?? ""
        return url.path == "/" ? host : host + url.path
    }

    /// The code a person types on another device, when it is one.
    public static func connectCode(_ value: String?) -> String? {
        guard let value, value.range(of: "^[A-Z0-9-]{4,16}$", options: .regularExpression) != nil else { return nil }
        return value
    }

    /// The relay's own account page, where the person manages their Omnesis account.
    public static func accountPageURL(relayUrl: String?) -> URL? {
        httpsURL(relayUrl).flatMap { URL(string: "/_relay/account", relativeTo: $0)?.absoluteURL }
    }
}
