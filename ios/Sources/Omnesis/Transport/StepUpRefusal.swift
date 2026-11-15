// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// A gateway refused a change from this phone until the owner confirms it's them
/// (`packages/gateway/src/http/step-up.ts`). Once a passkey is confirmed on the gateway, a change
/// that loosens it (approving a device, adding a device, a token, automatic joins) needs that
/// passkey on the gateway's own page when it comes through the relay or from a device that joined
/// by signing in. The app has no ceremony of its own for it, so it sends the person to that page.
///
/// - `required` is 428 `STEP_UP_REQUIRED`: the gateway's page can confirm it.
/// - `unavailable` is 403 `STEP_UP_UNAVAILABLE`: a security lock is on, or the gateway has no
///   secure address of its own, so only the computer running Omnesis can make the change.
public enum StepUpRefusal: Equatable, Sendable {
    case required
    case unavailable

    /// The refusal `error` carries, if it is one.
    public init?(_ error: Error?) {
        guard let error = error as? GatewayClient.Error else { return nil }
        switch error.gatewayCode {
        case "STEP_UP_REQUIRED": self = .required
        case "STEP_UP_UNAVAILABLE": self = .unavailable
        default: return nil
        }
    }

    public var title: String {
        switch self {
        case .required: "Confirm it's you"
        case .unavailable: "Security lock is on"
        }
    }

    public var message: String {
        switch self {
        case .required: "This change needs Face ID on your gateway's page."
        case .unavailable: "This change can only be made on the computer running Omnesis right now."
        }
    }

    /// The button that opens the gateway's page; nothing to open while the lock is on.
    public var action: String? {
        self == .required ? "Open your gateway's page" : nil
    }

    /// A 403 keeps its body when it is a step-up refusal, so the reason reaches the screen;
    /// every other 403 stays the plain `forbidden` it always was.
    static func forbidden(_ body: Data) -> GatewayClient.Error {
        let text = String(data: body, encoding: .utf8) ?? ""
        let refusal = GatewayClient.Error.serverError(status: 403, body: text)
        return StepUpRefusal(refusal) == .unavailable ? refusal : .forbidden
    }

    /// The gateway's portal at `path` on the address this phone reaches it at. A phone asked to
    /// step up reaches the gateway on its secure address, the origin its passkey works on.
    public static func page(gateway: URL, path: String, fragment: String? = nil) -> URL? {
        guard var parts = URLComponents(url: gateway, resolvingAgainstBaseURL: false), parts.scheme == "https",
              parts.host != nil else { return nil }
        parts.path = path
        parts.query = nil
        parts.fragment = fragment
        return parts.url
    }
}
