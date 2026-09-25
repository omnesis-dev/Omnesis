// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// User-facing mapping for a failed relay-consent save. The consent sheet
/// used to render one banner for every failure. Transport-level failures keep
/// that banner; server refusals now render typed guidance, with older
/// gateways (no detail reason) falling through to the generic per-status
/// branches.
enum RelayConsentSaveMessage {
    static let connectionIssue =
        "The gateway could not save this permission. Check the connection and try again."

    private static let repairApp =
        "The gateway doesn't recognise this phone's app. " +
        "Remove the phone and pair it again, then try allowing relay notifications."
    private static let repairPhone =
        "The gateway doesn't recognise this phone. " +
        "Remove the phone and pair it again, then try allowing relay notifications."

    /// Machine-readable refusal reason a current gateway attaches in the
    /// error envelope's detail (`{"reason": ...}`). Absent on older
    /// gateways and on non-JSON bodies — callers must fall back, never crash.
    static func refusalReason(in body: String) -> String? {
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let detail = json["detail"] as? [String: Any],
              let reason = detail["reason"] as? String
        else { return nil }
        return reason
    }

    static func message(for error: Error) -> String {
        guard let registration = error as? PushRegistrationError else { return connectionIssue }
        switch registration {
        case .serverError(let status, let body):
            switch status {
            case 400 where refusalReason(in: body) == "identity-mismatch":
                return repairApp
            case 403, 404:
                return repairPhone
            case 400, 409:
                return "The gateway refused to save this permission (error \(status)). Check the gateway and try again."
            case 500 ... 599:
                return "The gateway hit an error saving this permission. Try again in a moment."
            default:
                return "The gateway refused to save this permission (error \(status)). Check the gateway and try again."
            }
        case .invalidResponse:
            return "Pairing changed while saving. Dismiss this sheet and try again."
        case .invalidURL, .unavailable:
            return connectionIssue
        }
    }
}

/// Whether a refused consent save is worth replaying after the hello. The
/// race shape is an uncoded 400 (older gateways) or an identity-mismatch (a
/// current gateway refusing a stale row). Deliberately not a function of
/// hello state: the wait that follows confirms it either way, so both
/// response orderings retry exactly once. Any other stated reason — or any
/// other status — is deterministic, and retrying it only burns the hello wait.
enum RelayConsentRetryPolicy {
    static func shouldRetry(status: Int, body: String) -> Bool {
        guard status == 400 else { return false }
        let reason = RelayConsentSaveMessage.refusalReason(in: body)
        return reason == nil || reason == "identity-mismatch"
    }
}
