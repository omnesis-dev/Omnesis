// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Only fixed, app-owned copy reaches the voice error surface. Provider messages
/// may contain request contents or implementation details, including on older gateways.
struct RealtimeCallFailure: LocalizedError, Equatable {
    let code: String
    let fatal: Bool
    let retryable: Bool

    var title: String {
        Self.titles[code] ?? (fatal ? "Voice call interrupted" : "Reply interrupted")
    }

    private static let titles: [String: String] = [
        "quota_exhausted": "OpenAI credit or quota limit",
        "credit_balance_exhausted": "OpenAI credit needed",
        "project_spend_limit_exceeded": "OpenAI project spend limit reached",
        "organization_spend_limit_exceeded": "OpenAI organization spend limit reached",
        "organization_usage_limit_exceeded": "OpenAI usage limit reached",
        "authentication_failed": "OpenAI authentication failed",
        "pairing_rejected": "Gateway pairing rejected",
        "certificate_error": "Gateway certificate could not be verified",
        "rate_limited": "Voice is temporarily busy",
        "microphone_permission": "Microphone access needed",
        "microphone_failed": "Microphone unavailable",
        "playback_failed": "Voice playback unavailable",
        "audio_interrupted": "Audio was interrupted",
        "connection_error": "Voice connection interrupted",
        "timeout": "Voice connection interrupted",
        "session_busy": "Conversation is busy",
        "model_unavailable": "Voice is unavailable",
        "unavailable": "Voice is unavailable",
        "protocol_error": "Voice connection needs an update",
        "server_shutdown": "Gateway restarted",
        "session_end_failed": "Call could not finish normally",
    ]

    var errorDescription: String? {
        Self.details[code] ?? ("The voice provider could not complete the request. "
            + "Try again, or check the OpenAI backend on your gateway if it continues.")
    }

    private static let details: [String: String] = [
        "quota_exhausted": "The OpenAI account used by your gateway has reached a credit or usage limit. Check its "
            + "available credit and project billing limits, then retry the call.",
        "credit_balance_exhausted": "The OpenAI account used by your gateway has run out of API credit. Add credit in OpenAI "
            + "billing, then retry the call.",
        "project_spend_limit_exceeded": "The gateway's OpenAI project reached its spending limit. Raise that project's limit or "
            + "wait for it to reset, then retry the call.",
        "organization_spend_limit_exceeded": "The gateway's OpenAI organization reached its spending limit. Check the organization's "
            + "billing limit, then retry the call.",
        "organization_usage_limit_exceeded": "The gateway's OpenAI organization reached its assigned usage limit. Check its usage "
            + "allowance, then retry the call.",
        "authentication_failed": "OpenAI rejected the gateway's API key. Check the OpenAI backend credentials on your gateway, then retry.",
        "pairing_rejected": "The gateway rejected this device's access. Re-pair from Settings, then retry the call.",
        "certificate_error": "Check that the saved gateway address matches its HTTPS certificate. Re-pair from Settings "
            + "if the address changed.",
        "rate_limited": "The voice provider is limiting requests. Wait a moment, then try again.",
        "microphone_permission": "Allow microphone access for Omnesis in iPhone Settings, then retry the call.",
        "microphone_failed": "The microphone could not start or process audio. Check your audio device, then retry the call.",
        "playback_failed": "The reply could not be played on this audio device. Check your speaker or headphones, then retry the call.",
        "audio_interrupted": "Your audio device changed or another app interrupted the call. Check your audio connection, then retry.",
        "connection_error": "The voice connection was lost. Check the phone and gateway's internet connection, then retry.",
        "timeout": "The voice connection did not respond in time. Check your connection, then retry.",
        "session_busy": "Another turn is still using this conversation. Wait for it to finish, then retry the call.",
        "session_not_found": "This conversation is no longer available. Return to chat and select a conversation, then try again.",
        "model_unavailable": "Check that experimental mode and an OpenAI realtime backend are enabled on your gateway.",
        "unavailable": "Check that experimental mode and an OpenAI realtime backend are enabled on your gateway.",
        "protocol_error": "The app and gateway could not agree on the voice connection. Update both, then retry.",
        "context_window_exceeded": "This conversation is too long for the voice model. Start a new conversation to continue.",
        "output_truncated": "The reply reached the voice model's limit. Ask for a shorter answer or one part at a time.",
        "call_limit_reached": "This call reached its duration limit. Start another call to continue the same conversation.",
        "server_shutdown": "The gateway stopped or restarted. Wait for it to reconnect, then retry the call.",
        "session_end_failed": "The gateway could not finish the call cleanly. Return to chat and wait for the "
            + "conversation to settle before retrying.",
        "session_expired": "The voice session expired. Start another call to continue the same conversation.",
        "content_filtered": "The voice provider could not answer that request. Try rephrasing it.",
    ]

    static func server(_ event: [String: Any]) -> Self {
        let payload = event["error"] as? [String: Any] ?? [:]
        let rawCode = payload["code"] as? String ?? ""
        let legacy = (payload["message"] as? String ?? "").lowercased()
        let code: String = if ["insufficient_quota", "quota_exhausted"].contains(rawCode)
            || (rawCode.isEmpty && (legacy.contains("credit balance") || legacy.contains("insufficient_quota"))) {
            "quota_exhausted"
        } else { rawCode.isEmpty ? "provider_error" : rawCode }
        let requiresChange = [
            "quota_exhausted", "credit_balance_exhausted", "project_spend_limit_exceeded",
            "organization_spend_limit_exceeded", "organization_usage_limit_exceeded",
            "authentication_failed", "pairing_rejected", "context_window_exceeded", "content_filtered",
        ].contains(code)
        return Self(code: code, fatal: payload["fatal"] as? Bool ?? true, retryable: payload["retryable"] as? Bool ?? !requiresChange)
    }

    static func local(_ error: Error, httpStatus: Int? = nil, closeReason: Data? = nil) -> Self {
        if let failure = error as? Self { return failure }
        if let closeReason, closeReason.count <= 123, let reason = String(data: closeReason, encoding: .utf8),
           reason.hasPrefix("voice_error:") {
            return server(["error": ["code": String(reason.dropFirst("voice_error:".count))]])
        }
        if let gateway = error as? GatewayClient.Error { return gatewayFailure(gateway) }
        if let httpStatus, httpStatus != 101 {
            let codes = [
                400: "protocol_error",
                401: "pairing_rejected",
                403: "pairing_rejected",
                404: "unavailable",
                409: "session_busy",
                429: "rate_limited",
            ]
            return Self(code: codes[httpStatus] ?? "connection_error", fatal: true, retryable: ![401, 403].contains(httpStatus))
        }
        let ns = error as NSError
        if ns.domain == "RealtimeCall" {
            let codes = [1: "microphone_permission", 4: "microphone_failed", 6: "protocol_error"]
            return Self(code: codes[ns.code] ?? "provider_error", fatal: true, retryable: ns.code != 1)
        }
        if let url = error as? URLError {
            if [
                .serverCertificateUntrusted,
                .serverCertificateHasBadDate,
                .serverCertificateNotYetValid,
                .serverCertificateHasUnknownRoot,
                .secureConnectionFailed,
            ].contains(url.code) {
                return Self(code: "certificate_error", fatal: true, retryable: false)
            }
            return Self(code: url.code == .timedOut ? "timeout" : "connection_error", fatal: true, retryable: true)
        }
        return Self(code: "provider_error", fatal: true, retryable: true)
    }

    private static func gatewayFailure(_ gateway: GatewayClient.Error) -> Self {
        switch gateway {
        case .unauthorized, .forbidden:
            return Self(code: "pairing_rejected", fatal: true, retryable: false)
        case .notFound:
            return Self(code: "session_not_found", fatal: true, retryable: false)
        case .serverError(let status, _):
            if status == 409 {
                return Self(code: "session_busy", fatal: true, retryable: true)
            }
            // Do not expose HTTP bodies; they can contain provider details.
            return local(URLError(.badServerResponse), httpStatus: status)
        default:
            return Self(code: "protocol_error", fatal: true, retryable: false)
        }
    }
}
