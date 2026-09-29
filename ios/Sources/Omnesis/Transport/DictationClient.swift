// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Client for gateway dictation (experimental): `POST /dictation/transcribe`,
/// which turns audio recorded at one of the app's mic touchpoints into text
/// with the gateway's transcriber, and the operator's opt-in, written through
/// the same `PATCH /admin/config` the Models screen uses.
///
/// Requests are built by pure static functions so the logic lane can pin the
/// wire shape without a network; `dispatch` only sends them and translates the
/// status.
public final class DictationClient: DictationTranscribing {
    public let baseURL: URL
    public let token: String
    private let session: URLSessionLike

    /// Transcription can include a cold model load on the gateway, so the
    /// request waits much longer than an ordinary admin call.
    static let transcribeTimeout: TimeInterval = 90

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    /// `POST /dictation/transcribe` — send one recording, receive its text.
    /// Throws `DictationTranscribeError` for the route's own refusals and
    /// `GatewayClient.Error` for authentication and transport failures.
    public func transcribe(audio: Data, contentType: String, language: String?) async throws -> DictationTranscription {
        let request = try Self.transcribeRequest(
            baseURL: baseURL,
            token: token,
            audio: audio,
            contentType: contentType,
            language: language
        )
        let data = try await dispatch(request)
        do {
            return try JSONDecoder().decode(DictationTranscription.self, from: data)
        } catch {
            throw GatewayClient.Error.decoding("\(error)")
        }
    }

    /// `PATCH /admin/config` — switch gateway dictation on or off. A gateway
    /// setting: it applies to every device paired with this gateway.
    public func setTranscribeOnGateway(_ enabled: Bool) async throws {
        let request = try Self.optInRequest(baseURL: baseURL, token: token, enabled: enabled)
        _ = try await dispatch(request)
    }

    // MARK: - Request building

    static func transcribeRequest(
        baseURL: URL,
        token: String,
        audio: Data,
        contentType: String,
        language: String?
    ) throws
        -> URLRequest {
        guard let routeURL = URL(string: "/dictation/transcribe", relativeTo: baseURL)?.absoluteURL,
              var components = URLComponents(url: routeURL, resolvingAgainstBaseURL: false)
        else {
            throw GatewayClient.Error.invalidURL
        }
        if let language, !language.isEmpty {
            components.queryItems = [URLQueryItem(name: "language", value: language.lowercased())]
        }
        guard let url = components.url else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: url, timeoutInterval: transcribeTimeout)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = audio
        return request
    }

    static func optInRequest(baseURL: URL, token: String, enabled: Bool) throws -> URLRequest {
        guard let url = URL(string: "/admin/config", relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(
            DictationOptInPatch(inference: .init(dictation: .init(transcribeOnGateway: enabled)))
        )
        return request
    }

    /// The error a non-2xx answer maps to. The dictation route's refusals get
    /// their own cases so callers can tell "switched off" from "cannot run";
    /// everything else keeps the shared gateway vocabulary.
    static func error(status: Int, body: Data) -> Error {
        let envelope = GatewayErrorEnvelope.parse(body)
        switch (status, envelope?.code) {
        case (401, _): return GatewayClient.Error.unauthorized
        case (403, _): return GatewayClient.Error.forbidden
        case (404, _): return DictationTranscribeError.notOffered
        case (409, "DICTATION_DISABLED"): return DictationTranscribeError.disabled
        case (413, _): return DictationTranscribeError.payloadTooLarge
        case (503, "TRANSCRIBER_UNAVAILABLE"):
            return DictationTranscribeError.transcriberUnavailable(envelope?.error)
        default:
            return GatewayClient.Error.serverError(status: status, body: String(data: body, encoding: .utf8) ?? "")
        }
    }

    // MARK: - Internals

    private func dispatch(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        guard (200 ... 299).contains(http.statusCode) else {
            throw Self.error(status: http.statusCode, body: data)
        }
        return data
    }
}

/// `{"inference":{"dictation":{"transcribeOnGateway":…}}}` — the partial
/// config the opt-in writes.
private struct DictationOptInPatch: Encodable {
    struct Inference: Encodable {
        let dictation: DictationSettings
    }

    struct DictationSettings: Encodable {
        let transcribeOnGateway: Bool
    }

    let inference: Inference
}

/// Why `POST /dictation/transcribe` refused a recording.
public enum DictationTranscribeError: Error, Equatable {
    /// 404: the gateway is not in experimental mode, or predates the route.
    case notOffered
    /// 409 `DICTATION_DISABLED`: the operator has not switched it on.
    case disabled
    /// 503 `TRANSCRIBER_UNAVAILABLE`: no runnable transcriber, or the
    /// transcription failed. Carries the gateway's explanation.
    case transcriberUnavailable(String?)
    /// 413 `PAYLOAD_TOO_LARGE`: over the advertised `maxAudioBytes`.
    case payloadTooLarge
}

/// The `dictation` field on `GET /status`: whether this app should send the
/// audio it records to the gateway. A gateway that predates the field sends
/// none, which the app reads exactly like an inactive gate.
public struct DictationStatus: Decodable, Equatable, Sendable {
    /// The gateway runs in experimental mode, so the setting may show.
    public let visible: Bool
    /// The operator switched gateway dictation on.
    public let enabled: Bool
    /// A transcriber is assigned and its model can run.
    public let modelAssigned: Bool
    /// Experimental, enabled and a runnable model: send dictation audio.
    public let active: Bool
    /// Why the transcriber cannot run, when it cannot.
    public let reason: String?
    /// Largest audio body the gateway accepts, in bytes.
    public let maxAudioBytes: Int

    public init(
        visible: Bool,
        enabled: Bool,
        modelAssigned: Bool,
        active: Bool,
        reason: String? = nil,
        maxAudioBytes: Int
    ) {
        self.visible = visible
        self.enabled = enabled
        self.modelAssigned = modelAssigned
        self.active = active
        self.reason = reason
        self.maxAudioBytes = maxAudioBytes
    }

    private enum CodingKeys: String, CodingKey {
        case visible, enabled, modelAssigned, active, reason, maxAudioBytes
    }

    /// Every flag defaults to off, so a partial object can only ever keep
    /// the app on its on-device recognizer.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        visible = try container.decodeIfPresent(Bool.self, forKey: .visible) ?? false
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        modelAssigned = try container.decodeIfPresent(Bool.self, forKey: .modelAssigned) ?? false
        active = try container.decodeIfPresent(Bool.self, forKey: .active) ?? false
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        maxAudioBytes = try container.decodeIfPresent(Int.self, forKey: .maxAudioBytes) ?? 0
    }

    /// Whether a mic session starting now should record for the gateway.
    public var routesToGateway: Bool {
        active && maxAudioBytes > 0
    }

    /// The explanation Settings shows beside the switch: the operator asked
    /// for gateway dictation and the transcriber cannot run.
    public var blockedReason: String? {
        guard enabled, !modelAssigned else { return nil }
        return reason ?? "No transcriber model can run."
    }
}
