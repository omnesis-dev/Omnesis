// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The `PATCH /admin/config` merge patch that saves a Decision model choice:
/// at most one decision backend added, updated or removed, the `decision`
/// assignment set or cleared, and cloud inference turned on when the operator
/// agreed to it in the same step.
///
/// ```json
/// {"inference": {"allowRemoteInference": true,
///   "decisionBackends": {"<key>": {"preset", "url", "protocol", "auth", "scoreField", "apiKey"}},
///   "assignments": {"decision": "<key>/<model>"}}}
/// ```
///
/// A blank API key is left out, so the stored one is kept; the gateway moves
/// a sent key into its secret store and never returns it.
public struct DecisionConfigPatch: Encodable, Equatable, Sendable {
    /// One decision backend's fields. Every field is optional because a merge
    /// patch on an existing backend sends only what changes (a new key).
    public struct Backend: Encodable, Equatable, Sendable {
        public var preset: String?
        public var url: String?
        public var `protocol`: String?
        public var auth: String?
        public var scoreField: String?
        public var apiKey: String?

        public init(
            preset: String? = nil,
            url: String? = nil,
            protocol: String? = nil,
            auth: String? = nil,
            scoreField: String? = nil,
            apiKey: String? = nil
        ) {
            self.preset = preset
            self.url = url
            self.protocol = `protocol`
            self.auth = auth
            self.scoreField = scoreField
            self.apiKey = apiKey
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
            var backends = inference.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("decisionBackends"))
            try backends.encode(config, forKey: AnyKey(key))
        case .remove(let key):
            // A missing key is a no-op in a merge patch; only an explicit null removes.
            var backends = inference.nestedContainer(keyedBy: AnyKey.self, forKey: AnyKey("decisionBackends"))
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

extension AdminClient {
    /// `PATCH /admin/config` with a Decision model patch.
    public func patchDecisionConfig(_ patch: DecisionConfigPatch) async throws {
        _ = try await dispatch(method: "PATCH", path: "/admin/config", body: JSONEncoder().encode(patch))
    }

    /// `POST /admin/inference/decision-backends/:key/verify` — one small
    /// invented decision through a decision backend's model.
    public func verifyDecisionBackend(key: String, model: String) async throws -> DecisionVerifyResult {
        try await postDecisionVerify(path: "/admin/inference/decision-backends/\(Self.pathSegment(key))/verify", model: model)
    }

    /// `POST /admin/inference/typesafe/verify` — the same for TypeSafe.
    public func verifyTypeSafeDecision(model: String) async throws -> DecisionVerifyResult {
        try await postDecisionVerify(path: "/admin/inference/typesafe/verify", model: model)
    }

    /// `POST /admin/inference/decision-backends/:key/probe` — the models a
    /// local decision server lists. A saved backend only.
    public func probeDecisionBackend(key: String) async throws -> DecisionProbeResult {
        let (data, _) = try await dispatch(
            method: "POST",
            path: "/admin/inference/decision-backends/\(Self.pathSegment(key))/probe",
            body: Data("{}".utf8)
        )
        return try decodeOrThrow(DecisionProbeResult.self, from: data)
    }

    /// `POST /admin/inference/decision-backends/probe` — the models a server
    /// lists before it is saved as a backend. Fields left nil are not sent.
    public func probeDecisionURL(
        url: String,
        auth: String? = nil,
        apiKey: String? = nil,
        protocol: String? = nil,
        preset: String? = nil
    ) async throws
        -> DecisionProbeResult {
        struct Body: Encodable {
            let url: String
            let auth: String?
            let apiKey: String?
            let `protocol`: String?
            let preset: String?
        }
        let body = try JSONEncoder().encode(Body(url: url, auth: auth, apiKey: apiKey, protocol: `protocol`, preset: preset))
        let (data, _) = try await dispatch(method: "POST", path: "/admin/inference/decision-backends/probe", body: body)
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
