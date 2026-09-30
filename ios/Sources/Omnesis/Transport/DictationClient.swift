// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Client for the operator's gateway dictation opt-in (experimental),
/// written through the same `PATCH /admin/config` the Models screen uses.
/// The request is built by a pure static function so the logic lane can pin
/// its shape.
public final class DictationClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSessionLike

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    /// `PATCH /admin/config` — switch gateway dictation on or off. A gateway
    /// setting: it applies to every device paired with this gateway.
    public func setTranscribeOnGateway(_ enabled: Bool) async throws {
        let request = try Self.optInRequest(baseURL: baseURL, token: token, enabled: enabled)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw GatewayClient.Error.invalidResponse }
        switch http.statusCode {
        case 200 ... 299: return
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        case 404: throw GatewayClient.Error.notFound
        default: throw GatewayClient.Error.serverError(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
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

/// The `dictation` field on `GET /status`: whether Tell Omnesis notes should
/// carry their recording for the gateway to transcribe. A gateway that
/// predates the field sends none, which the app reads exactly like an
/// inactive gate.
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

    /// Whether a capture starting now should record for the gateway.
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
