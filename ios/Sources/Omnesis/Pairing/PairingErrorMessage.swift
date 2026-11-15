// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// What a failed pairing shows the person pairing.
public enum PairingFailure: Equatable, Sendable {
    /// A plain sentence.
    case message(String)
    /// The QR code names the gateway's address on the owner's Tailscale
    /// network, and this phone could not reach it there: the pairing screen
    /// offers to open Tailscale and to try again instead of a sentence.
    case tailnetUnreachable

    /// The sentence for this failure, for surfaces that show only one.
    public var message: String {
        switch self {
        case .message(let text): text
        case .tailnetUnreachable: PairingErrorMessage.tailnetUnreachable
        }
    }
}

/// A plain sentence for a pairing that failed, in place of an error type's
/// description.
public enum PairingErrorMessage {
    public static let usedOrExpiredCode =
        "This pairing code has already been used or has expired. Create a new one on your gateway and scan it again."
    public static let certificate =
        "Couldn't verify your gateway's certificate. Check that the QR code uses a hostname covered by the certificate. If using Tailscale, choose its hostname instead of its IP address."
    public static let pinnedCertificate =
        "The gateway certificate does not match the fingerprint in this QR code. Create a new pairing code on your gateway and scan it again."
    public static let notAPairingCode = "That code isn't an Omnesis pairing code. Scan the QR code shown by your gateway."
    public static let unsupportedVersion =
        "This pairing code is for a different version of Omnesis. Update the app, then create a new code on your gateway."
    public static let notHTTPS = "That code points to a gateway without HTTPS. Omnesis only pairs with a gateway over HTTPS."
    public static let unfinished = "Pairing didn't finish. Try again."
    public static let generic = "Couldn't pair with your gateway. Try again."
    public static let tailnetUnreachable =
        "This gateway's address is on your Tailscale network, and this phone isn't connected to it."

    public static func unreachable(host: String?) -> String {
        "Couldn't reach your gateway at \(host ?? "that address"). "
            + "Check that the gateway is running and this phone can reach it. Away from home, connect Tailscale on both devices and use the gateway's Tailscale hostname when creating the QR code."
    }

    /// What to show for `error` from pairing with the scanned `payload`.
    public static func failure(for error: Error, payload: String) -> PairingFailure {
        if let urlError = error as? URLError, unreachableCodes.contains(urlError.code),
           marksTailnetAddress(inPayload: payload) {
            return .tailnetUnreachable
        }
        return .message(message(for: error, payload: payload))
    }

    /// Whether a scanned pairing payload says its gateway URL is an address on
    /// the owner's Tailscale network.
    public static func marksTailnetAddress(inPayload raw: String) -> Bool {
        (try? PairingPayload.decode(from: raw))?.isTailnetAddress == true
    }

    /// The sentence for `error` from pairing with the scanned `payload`.
    public static func message(for error: Error, payload: String) -> String {
        if let payloadError = error as? PairingPayloadError {
            return message(for: payloadError)
        }
        if let gatewayError = error as? GatewayClient.Error {
            return message(for: gatewayError)
        }
        if let urlError = error as? URLError {
            return message(
                for: urlError,
                host: gatewayHost(inPayload: payload),
                pinsCertificate: pinsCertificate(inPayload: payload)
            )
        }
        if let described = (error as? LocalizedError)?.errorDescription {
            return described
        }
        return generic
    }

    /// The gateway host a scanned pairing payload names, if it names one.
    public static func gatewayHost(inPayload raw: String) -> String? {
        guard let object = jsonObject(raw) else { return nil }
        let address = (object["gatewayUrl"] as? String) ?? (object["url"] as? String)
        return address.flatMap(URL.init(string:))?.host()
    }

    /// Whether a scanned pairing payload pins the gateway's certificate.
    public static func pinsCertificate(inPayload raw: String) -> Bool {
        guard let object = jsonObject(raw) else { return false }
        return containsFingerprint(object)
    }

    private static func message(for error: PairingPayloadError) -> String {
        switch error {
        case .invalidJSON, .invalidShape, .missingField, .invalidURL, .invalidFingerprint: notAPairingCode
        case .unsupportedVersion: unsupportedVersion
        case .invalidScheme: notHTTPS
        }
    }

    private static func message(for error: GatewayClient.Error) -> String {
        guard case .serverError(let status, let body) = error else { return generic }
        let text = (error.gatewayMessage ?? body).lowercased()
        let refusesCode = [400, 401, 403, 404, 409, 410].contains(status)
            && (text.contains("pairing code") || text.contains("expired") || text.contains("already used"))
        if refusesCode {
            return usedOrExpiredCode
        }
        if let gatewayMessage = error.gatewayMessage?.trimmingCharacters(in: .whitespacesAndNewlines),
           !gatewayMessage.isEmpty {
            return "Your gateway couldn't pair this phone: \(sentence(gatewayMessage))"
        }
        return generic
    }

    private static func message(for error: URLError, host: String?, pinsCertificate: Bool) -> String {
        switch error.code {
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
             .serverCertificateHasUnknownRoot, .clientCertificateRejected, .clientCertificateRequired,
             .secureConnectionFailed:
            certificate
        // A pinned certificate that doesn't match cancels the connection.
        case .cancelled:
            pinsCertificate ? pinnedCertificate : unfinished
        case _ where unreachableCodes.contains(error.code):
            unreachable(host: host)
        default:
            generic
        }
    }

    /// The failures that mean this phone could not reach the gateway's address.
    private static let unreachableCodes: Set<URLError.Code> = [
        .cannotConnectToHost, .cannotFindHost, .timedOut, .networkConnectionLost, .notConnectedToInternet,
        .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed,
    ]

    private static func jsonObject(_ raw: String) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any]
    }

    private static func containsFingerprint(_ object: [String: Any]) -> Bool {
        object.contains { key, value in
            if key == "fingerprint", let fingerprint = value as? String, !fingerprint.isEmpty { return true }
            return (value as? [String: Any]).map(containsFingerprint) ?? false
        }
    }

    /// `text` with a capital first letter and a closing full stop.
    private static func sentence(_ text: String) -> String {
        let capitalised = text.prefix(1).uppercased() + text.dropFirst()
        return capitalised.hasSuffix(".") ? capitalised : capitalised + "."
    }
}
