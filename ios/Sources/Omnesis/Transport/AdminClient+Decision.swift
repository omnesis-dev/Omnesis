// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The `PATCH /admin/config` merge patch that saves a Decision model choice:
/// at most one backend added, changed or removed, the `decision` assignment
/// set or cleared, and cloud inference turned on when the operator agreed to
/// it in the same step.
///
/// ```json
/// {"inference": {"allowRemoteInference": true,
///   "backends": {"<key>": {"type", "preset", "url", "apiKey",
///     "decision": {"url", "protocol", "auth", "scoreField"}}},
///   "assignments": {"decision": "<key>/<model>"}}}
/// ```
///
/// A backend has one API key, sent to its OpenAI-compatible API and its
/// decision API alike. A blank key is left out, so the stored one is kept;
/// the gateway moves a sent key into its secret store and never returns it.
public struct DecisionConfigPatch: Encodable, Equatable, Sendable {
    /// A backend's decision API fields. Every field is optional because a
    /// merge patch on an existing decision API sends only what changes.
    public struct DecisionAPI: Encodable, Equatable, Sendable {
        public var url: String?
        public var `protocol`: String?
        public var auth: String?
        public var scoreField: String?

        public init(url: String? = nil, protocol: String? = nil, auth: String? = nil, scoreField: String? = nil) {
            self.url = url
            self.protocol = `protocol`
            self.auth = auth
            self.scoreField = scoreField
        }

        /// A preset's decision API at `url` (its URL with the placeholders
        /// filled), with the preset's protocol, key header and score field.
        public init(preset: ProviderDecisionPreset, url: String) {
            self.init(
                url: url,
                protocol: preset.protocol ?? "systemone",
                auth: preset.auth ?? "bearer",
                scoreField: preset.scoreField
            )
        }
    }

    /// What happens to a backend's decision API.
    public enum DecisionChange: Equatable, Sendable {
        case set(DecisionAPI)
        /// Remove it, keeping the backend's OpenAI-compatible API.
        case remove
    }

    /// One backend's fields. Every field is optional because a merge patch on
    /// an existing backend sends only what changes.
    public struct Backend: Encodable, Equatable, Sendable {
        public var type: String?
        public var preset: String?
        /// The OpenAI-compatible base URL.
        public var url: String?
        public var apiPathPrefix: String?
        public var apiKey: String?
        public var decision: DecisionChange?

        public init(
            type: String? = nil,
            preset: String? = nil,
            url: String? = nil,
            apiPathPrefix: String? = nil,
            apiKey: String? = nil,
            decision: DecisionChange? = nil
        ) {
            self.type = type
            self.preset = preset
            self.url = url
            self.apiPathPrefix = apiPathPrefix
            self.apiKey = apiKey
            self.decision = decision
        }

        public func encode(to encoder: Encoder) throws {
            var values = encoder.container(keyedBy: AnyKey.self)
            try values.encodeIfPresent(type, forKey: AnyKey("type"))
            try values.encodeIfPresent(preset, forKey: AnyKey("preset"))
            try values.encodeIfPresent(url, forKey: AnyKey("url"))
            try values.encodeIfPresent(apiPathPrefix, forKey: AnyKey("apiPathPrefix"))
            try values.encodeIfPresent(apiKey, forKey: AnyKey("apiKey"))
            switch decision {
            case .set(let api): try values.encode(api, forKey: AnyKey("decision"))
            // A missing key is a no-op in a merge patch; only an explicit null removes.
            case .remove: try values.encodeNil(forKey: AnyKey("decision"))
            case nil: break
            }
        }
    }

    public enum BackendChange: Equatable, Sendable {
        case upsert(key: String, Backend)
        case remove(key: String)
    }

    public enum AssignmentChange: Equatable, Sendable {
        case keep
        case set(String)
        case clear
    }

    public var backend: BackendChange?
    public var assignment: AssignmentChange
    public var enableRemoteInference: Bool

    public init(backend: BackendChange? = nil, assignment: AssignmentChange = .keep, enableRemoteInference: Bool = false) {
        self.backend = backend
        self.assignment = assignment
        self.enableRemoteInference = enableRemoteInference
    }

    /// Whether the patch changes nothing, so there is nothing to send.
    public var isEmpty: Bool {
        backend == nil && assignment == .keep && !enableRemoteInference
    }

    public func encode(to encoder: Encoder) throws {
        var root = encoder.container(keyedBy: AnyKey.self)
        var inference = root.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("inference"))
        if enableRemoteInference {
            try inference.encode(true, forKey: AnyKey("allowRemoteInference"))
        }
        switch backend {
        case .upsert(let key, let config):
            var backends = inference.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("backends"))
            try backends.encode(config, forKey: AnyKey(key))
        case .remove(let key):
            var backends = inference.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("backends"))
            try backends.encodeNil(forKey: AnyKey(key))
        case nil:
            break
        }
        switch assignment {
        case .keep:
            break
        case .set(let value):
            var assignments = inference.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("assignments"))
            try assignments.encode(value, forKey: AnyKey("decision"))
        case .clear:
            var assignments = inference.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("assignments"))
            try assignments.encodeNil(forKey: AnyKey("decision"))
        }
    }
}

/// A new HTTP backend as `AdminClient.addHttpBackend` writes it. Built by
/// `ModelManagement.newHttpBackend` from the Add backend form.
public struct NewHttpBackend: Equatable, Sendable {
    public let key: String
    /// The OpenAI-compatible base URL.
    public let url: String
    public var apiKey: String?
    public var apiPathPrefix: String?
    /// The provider preset it was made from.
    public var preset: String?
    /// The preset's decision API, reached with the same key.
    public var decision: DecisionConfigPatch.DecisionAPI?

    public init(
        key: String,
        url: String,
        apiKey: String? = nil,
        apiPathPrefix: String? = nil,
        preset: String? = nil,
        decision: DecisionConfigPatch.DecisionAPI? = nil
    ) {
        self.key = key
        self.url = url
        self.apiKey = apiKey
        self.apiPathPrefix = apiPathPrefix
        self.preset = preset
        self.decision = decision
    }
}

extension AdminClient {
    /// `PATCH /admin/config` with a Decision model patch.
    public func patchDecisionConfig(_ patch: DecisionConfigPatch) async throws {
        _ = try await dispatch(method: "PATCH", path: "/admin/config", body: JSONEncoder().encode(patch))
    }

    /// `POST /admin/inference/backends/:key/decision/verify` — one small
    /// invented decision through a backend's decision API.
    public func verifyBackendDecision(key: String, model: String) async throws -> DecisionVerifyResult {
        try await postDecisionVerify(path: "/admin/inference/backends/\(Self.pathSegment(key))/decision/verify", model: model)
    }

    /// `POST /admin/inference/typesafe/verify` — the same for TypeSafe.
    public func verifyTypeSafeDecision(model: String) async throws -> DecisionVerifyResult {
        try await postDecisionVerify(path: "/admin/inference/typesafe/verify", model: model)
    }

    /// `POST /admin/inference/backends/:key/decision/probe` — the models a
    /// saved backend's local decision server lists.
    public func probeBackendDecision(key: String) async throws -> DecisionProbeResult {
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/admin/inference/backends/\(Self.pathSegment(key))/decision/probe",
            body: Data("{}".utf8)
        )
        return try decodeOrThrow(DecisionProbeResult.self, from: data)
    }

    /// `POST /admin/inference/decision/probe` — the models a decision server
    /// lists before it is saved on a backend. `backendKey` names a saved
    /// backend whose key the gateway sends when no `apiKey` is given. Fields
    /// left nil are not sent.
    public func probeDecisionURL(
        url: String,
        auth: String? = nil,
        apiKey: String? = nil,
        protocol: String? = nil,
        preset: String? = nil,
        backendKey: String? = nil
    ) async throws
        -> DecisionProbeResult {
        struct Body: Encodable {
            let url: String
            let auth: String?
            let apiKey: String?
            let `protocol`: String?
            let preset: String?
            let backendKey: String?
        }
        let body = try JSONEncoder().encode(Body(
            url: url,
            auth: auth,
            apiKey: apiKey,
            protocol: `protocol`,
            preset: preset,
            backendKey: backendKey
        ))
        let (data, _) = try await dispatch(method: "POST", path: "/admin/inference/decision/probe", body: body)
        return try decodeOrThrow(DecisionProbeResult.self, from: data)
    }

    /// `GET /admin/models/decision/calibration` — the calibration job's status.
    public func decisionCalibrationStatus() async throws -> DecisionCalibrationStatus {
        try await calibrationRequest(method: "GET", body: nil)
    }

    /// `POST /admin/models/decision/calibration` — calibrate the assigned
    /// model. The gateway answers 409 while a run is going and 400 with the
    /// reason when the assignment cannot be calibrated.
    public func startDecisionCalibration() async throws -> DecisionCalibrationStatus {
        try await calibrationRequest(method: "POST", body: Data("{}".utf8))
    }

    /// `DELETE /admin/models/decision/calibration` — cancel the running calibration.
    public func cancelDecisionCalibration() async throws -> DecisionCalibrationStatus {
        try await calibrationRequest(method: "DELETE", body: nil)
    }

    /// A backend name as one path segment, encoded as `encodeURIComponent`
    /// does: `/`, `?`, `#` and `%` cannot end the segment or the path early.
    static func pathSegment(_ raw: String) -> String {
        raw.addingPercentEncoding(withAllowedCharacters: DecisionModelSetup.uriComponentAllowed) ?? raw
    }

    private func postDecisionVerify(path: String, model: String) async throws -> DecisionVerifyResult {
        struct Body: Encodable { let model: String }
        let (data, _) = try await dispatch(method: "POST", path: path, body: JSONEncoder().encode(Body(model: model)))
        return try decodeOrThrow(DecisionVerifyResult.self, from: data)
    }

    private func calibrationRequest(method: String, body: Data?) async throws -> DecisionCalibrationStatus {
        let (data, _) = try await dispatch(method: method, path: "/admin/models/decision/calibration", body: body)
        return try decodeOrThrow(DecisionCalibrationStatus.self, from: data)
    }
}
