// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import Foundation

/// Relay statuses for the Omnesis account screen, written as the gateway sends
/// them so previews go through the same decoding as the app.
extension PreviewMocks {
    static let cloudRelayNotConnected = cloudRelayStatus(
        #""enabled":false,"serviceConfigured":true,"enrollment":{"state":"unconfigured"},"tunnel":{"state":"disabled"},"#
            + #""certificate":{"state":"unconfigured"},"can":{"configure":true,"enable":false,"disable":false}"#
    )

    static let cloudRelayWaiting: CloudRelayStatus = {
        let expires = Int(Date().timeIntervalSince1970) + 540
        return cloudRelayStatus(
            #""enabled":false,"serviceConfigured":true,"enrollment":{"state":"unconfigured"},"tunnel":{"state":"disabled"},"#
                + #""connect":{"state":"waiting","authorizeUrl":"https://relay.example.test/_relay/v3/connect/sign-in?request=fictional","#
                + #""connectUrl":"https://relay.example.test/_relay/v3/connect","connectShortUrl":"https://omnesis.example/connect","#
                + #""code":"QK7M-2XPD","expiresAt":\#(expires)}"#
        )
    }()

    static let cloudRelayRegistering = cloudRelayStatus(
        #""enabled":true,"serviceConfigured":true,"enrollment":{"state":"pending"},"tunnel":{"state":"connecting"},"#
            + #""connect":{"state":"registering"}"#
    )

    static let cloudRelayFailed = cloudRelayStatus(
        #""enabled":false,"serviceConfigured":true,"enrollment":{"state":"unconfigured"},"tunnel":{"state":"disabled"},"#
            + #""connect":{"state":"failed","error":"account-link-failed"}"#
    )

    static let cloudRelayConnected = cloudRelayStatus(
        cloudRelayEstablished(tunnel: #"{"state":"online","lastConnectedAt":"2026-11-02T07:41:00.000Z"}"#)
    )

    static let cloudRelayConnectedNotLinked = cloudRelayStatus(
        cloudRelayEstablished(
            tunnel: #"{"state":"online","lastConnectedAt":"2026-11-02T07:41:00.000Z"}"#,
            account: #"{"activated":true,"configured":true,"linked":false,"canLink":true,"canUnlink":false,"pendingUnlink":false}"#
        )
    )

    static let cloudRelayDisconnected = cloudRelayStatus(
        cloudRelayEstablished(
            tunnel: #"{"state":"offline","lastConnectedAt":"2026-11-02T07:41:00.000Z","lastError":"relay-unreachable"}"#,
            publicReady: false
        )
    )

    static let cloudRelayOff = cloudRelayStatus(cloudRelayEstablished(tunnel: #"{"state":"disabled"}"#, enabled: false, publicReady: false))

    static let cloudRelayUnavailable = cloudRelayStatus(
        #""enabled":false,"serviceConfigured":false,"serviceError":"relay-service-unavailable","#
            + #""enrollment":{"state":"unconfigured"},"tunnel":{"state":"disabled"}"#
    )

    /// Connected a moment ago: the gateway has not yet confirmed that its address answers.
    static let cloudRelayChecking = cloudRelayStatus(
        cloudRelayEstablished(tunnel: #"{"state":"online","lastConnectedAt":"2026-11-02T07:41:00.000Z"}"#, publicReady: false)
    )

    /// The address stopped answering and the certificate is close to its end.
    static let cloudRelayProblems = cloudRelayStatus(
        cloudRelayEstablished(
            tunnel: #"{"state":"online","lastConnectedAt":"2026-11-02T07:41:00.000Z"}"#,
            publicReady: false,
            publicError: "public-endpoint-unreachable",
            certificate: #"{"state":"expiring","expiresAt":"2026-11-20T09:00:00.000Z","lastRenewedAt":"2026-08-22T09:00:00.000Z","#
                + #""lastError":"certificate-renewal-failed"}"#
        )
    )

    /// A certificate for the address was issued with a key this gateway does not hold.
    static let cloudRelayIncident = cloudRelayStatus(
        cloudRelayEstablished(
            tunnel: #"{"state":"online","lastConnectedAt":"2026-11-02T07:41:00.000Z"}"#,
            monitor: #"{"enabled":true,"state":"incident","lastCompletedAt":"2026-11-10T06:00:00.000Z","incidents":["#
                + #"{"hostname":"g-fictional.relay.example.test","spkiFingerprint":"sha256:fictional-key","#
                + #""issuer":"Example Test CA","serial":"00:fa:ce","observedAt":"2026-11-10T05:58:00.000Z"}]}"#
        )
    )

    /// A registered gateway with a linked account and a choice about new devices.
    private static func cloudRelayEstablished(
        tunnel: String,
        enabled: Bool = true,
        publicReady: Bool = true,
        publicError: String? = nil,
        certificate: String = #"{"state":"valid","expiresAt":"2027-02-08T09:00:00.000Z","lastRenewedAt":"2026-11-10T09:00:00.000Z"}"#,
        monitor: String = #"{"enabled":true,"state":"observing","lastCompletedAt":"2026-11-10T06:00:00.000Z","incidents":[]}"#,
        account: String = #"{"activated":true,"configured":true,"linked":true,"canLink":false,"canUnlink":true,"pendingUnlink":false}"#
    )
        -> String {
        let lastError = publicError.map { #","lastError":"\#($0)""# } ?? ""
        return #""enabled":\#(enabled),"serviceConfigured":true,"gatewayId":"00000000-0000-4000-8000-000000000001","#
            + #""hostname":"g-fictional.relay.example.test","enrollment":{"state":"enrolled"},"tunnel":\#(tunnel),"#
            + #""certificate":\#(certificate),"#
            + #""publicMcp":{"ready":\#(publicReady),"url":"https://g-fictional.relay.example.test/mcp"\#(lastError)},"#
            + #""account":\#(account),"deviceEnrollment":{"policy":"automatic"},"certificateMonitor":\#(monitor),"#
            + #""can":{"enable":\#(!enabled),"disable":\#(enabled),"reconnect":\#(enabled)}"#
    }

    /// `fields` is the inside of the status object; the relay addresses every status carries are added here.
    private static func cloudRelayStatus(_ fields: String) -> CloudRelayStatus {
        let json = #"{"revision":1,"configured":true,"config":{"relayUrl":"https://relay.example.test"},"#
            + #""google":{"configured":false},\#(fields)}"#
        do {
            return try JSONDecoder().decode(CloudRelayStatus.self, from: Data(json.utf8))
        } catch {
            preconditionFailure("Preview relay status does not decode: \(error)")
        }
    }
}
#endif
