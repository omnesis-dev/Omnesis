// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Wire types for setting up the Decision model: the decision API a provider
// preset offers (`presets[].decision` of `GET /admin/models`), the decision
// API a backend has (`inference.backends[key].decision`), and the results of
// the verify, probe and calibration routes. Mirrors `provider-presets.ts`,
// `decision-api.ts`, `decision-calibration.ts` and `backends.ts` in
// `@omnesis/core`, and `decision-tools.ts` in the gateway. Every field the
// setup flow can live without decodes as optional, so a newer gateway's
// additions and an older gateway's omissions both decode.

/// A model a decision provider offers. Mirrors `DecisionModelOption`.
public struct DecisionModelOption: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    /// Context window in tokens, when models.dev knows it.
    public let contextTokens: Int?
    /// USD per million input tokens, when models.dev knows it.
    public let inputCostPerMillion: Double?
    /// `preset` or `models.dev`; `probe` for a model a local server listed.
    public let source: String?

    public init(id: String, contextTokens: Int? = nil, inputCostPerMillion: Double? = nil, source: String? = nil) {
        self.id = id
        self.contextTokens = contextTokens
        self.inputCostPerMillion = inputCostPerMillion
        self.source = source
    }
}

/// A value the operator supplies to complete a preset's decision URL, written
/// `{key}` in it (a Cloudflare account id, a Microsoft Foundry resource name).
public struct DecisionPresetURLParam: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let key: String
    public let label: String
    public let placeholder: String?
    public var id: String {
        key
    }

    public init(key: String, label: String, placeholder: String? = nil) {
        self.key = key
        self.label = label
        self.placeholder = placeholder
    }
}

extension ModelsOverview {
    /// Every provider the gateway describes: those with an OpenAI-compatible
    /// API, then those serving only decision models.
    public var allProviders: [ProviderPreset] {
        presets + decisionProviders
    }
}

/// A provider preset's decision API with the models to offer for it. Mirrors
/// `ProviderPresetView.decision`.
public struct ProviderDecisionPreset: Decodable, Equatable, Hashable, Sendable {
    /// The endpoint, complete except for the `{key}` placeholders in `urlParams`.
    public let url: String
    public let `protocol`: String?
    /// The header that carries the backend's API key.
    public let auth: String?
    public let scoreField: String?
    /// Whether the provider refuses decision requests without a key.
    public let keyRequired: Bool
    /// The provider's id in the models.dev decision catalog.
    public let modelsDevId: String?
    public let docsUrl: String?
    public let keyUrl: String?
    public let note: String?
    public let urlParams: [DecisionPresetURLParam]
    /// The preset's own models first, then those models.dev adds.
    public let models: [DecisionModelOption]

    public init(
        url: String,
        protocol: String? = "systemone",
        auth: String? = "bearer",
        scoreField: String? = nil,
        keyRequired: Bool = false,
        modelsDevId: String? = nil,
        docsUrl: String? = nil,
        keyUrl: String? = nil,
        note: String? = nil,
        urlParams: [DecisionPresetURLParam] = [],
        models: [DecisionModelOption] = []
    ) {
        self.url = url
        self.protocol = `protocol`
        self.auth = auth
        self.scoreField = scoreField
        self.keyRequired = keyRequired
        self.modelsDevId = modelsDevId
        self.docsUrl = docsUrl
        self.keyUrl = keyUrl
        self.note = note
        self.urlParams = urlParams
        self.models = models
    }

    private enum CodingKeys: String, CodingKey {
        case url, `protocol`, auth, scoreField, keyRequired, modelsDevId, docsUrl, keyUrl, note, urlParams, models
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        url = try values.decodeIfPresent(String.self, forKey: .url) ?? ""
        self.protocol = try values.decodeIfPresent(String.self, forKey: .protocol)
        auth = try values.decodeIfPresent(String.self, forKey: .auth)
        scoreField = try values.decodeIfPresent(String.self, forKey: .scoreField)
        keyRequired = try values.decodeIfPresent(Bool.self, forKey: .keyRequired) ?? false
        modelsDevId = try values.decodeIfPresent(String.self, forKey: .modelsDevId)
        docsUrl = try values.decodeIfPresent(String.self, forKey: .docsUrl)
        keyUrl = try values.decodeIfPresent(String.self, forKey: .keyUrl)
        note = try values.decodeIfPresent(String.self, forKey: .note)
        urlParams = try values.decodeIfPresent([DecisionPresetURLParam].self, forKey: .urlParams) ?? []
        models = try values.decodeIfPresent([DecisionModelOption].self, forKey: .models) ?? []
    }
}

/// A calibration onto Jev's score scale stored for one model. Mirrors
/// `DecisionCalibration`; the fitted knots themselves are not needed here.
public struct DecisionCalibration: Decodable, Equatable, Hashable, Sendable {
    public let reference: String?
    /// ISO time of the fit.
    public let fittedAt: String?
    public let samples: Int?
    /// Share (0–1) of reference items where the calibrated model agrees with Jev.
    public let agreement: Double?
    /// The same share before calibration.
    public let agreementBefore: Double?
    /// Share (0–1) of the reference items Jev keeps that the calibrated model keeps.
    public let keeps: Double?
    /// The same share before calibration.
    public let keepsBefore: Double?
    /// Share (0–1) of the reference items Jev skips that the calibrated model skips.
    public let skips: Double?
    /// The same share before calibration.
    public let skipsBefore: Double?

    public init(
        reference: String? = nil,
        fittedAt: String? = nil,
        samples: Int? = nil,
        agreement: Double? = nil,
        agreementBefore: Double? = nil,
        keeps: Double? = nil,
        keepsBefore: Double? = nil,
        skips: Double? = nil,
        skipsBefore: Double? = nil
    ) {
        self.reference = reference
        self.fittedAt = fittedAt
        self.samples = samples
        self.agreement = agreement
        self.agreementBefore = agreementBefore
        self.keeps = keeps
        self.keepsBefore = keepsBefore
        self.skips = skips
        self.skipsBefore = skipsBefore
    }
}

/// A backend's decision API (`inference.backends.<key>.decision`) as
/// `/admin/models` reports it. Mirrors `BackendDecisionStatus`; the API key is
/// the backend's own.
public struct BackendDecisionStatus: Decodable, Equatable, Hashable, Sendable {
    public let url: String
    public let `protocol`: String?
    public let auth: String?
    /// Whether the endpoint is on the gateway's host (needs no cloud consent).
    public let onHost: Bool
    /// Whether the backend has an API key; the key itself is never sent.
    public let hasApiKey: Bool
    /// Why the backend's key could not be read, when it could not.
    public let apiKeySecretError: String?
    /// Calibrations stored for this backend, by model id.
    public let calibrations: [String: DecisionCalibration]

    public init(
        url: String,
        protocol: String? = "systemone",
        auth: String? = "bearer",
        onHost: Bool = false,
        hasApiKey: Bool = false,
        apiKeySecretError: String? = nil,
        calibrations: [String: DecisionCalibration] = [:]
    ) {
        self.url = url
        self.protocol = `protocol`
        self.auth = auth
        self.onHost = onHost
        self.hasApiKey = hasApiKey
        self.apiKeySecretError = apiKeySecretError
        self.calibrations = calibrations
    }

    private enum CodingKeys: String, CodingKey {
        case url, `protocol`, auth, onHost, hasApiKey, apiKeySecretError, calibrations
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        url = try values.decodeIfPresent(String.self, forKey: .url) ?? ""
        self.protocol = try values.decodeIfPresent(String.self, forKey: .protocol)
        auth = try values.decodeIfPresent(String.self, forKey: .auth)
        onHost = try values.decodeIfPresent(Bool.self, forKey: .onHost) ?? false
        hasApiKey = try values.decodeIfPresent(Bool.self, forKey: .hasApiKey) ?? false
        apiKeySecretError = try values.decodeIfPresent(String.self, forKey: .apiKeySecretError)
        calibrations = try values.decodeIfPresent([String: DecisionCalibration].self, forKey: .calibrations) ?? [:]
    }
}

/// Where the built-in TypeSafe slot sends its requests
/// (`inference.typesafe`): the public API, or an endpoint of the operator's own.
public struct TypeSafeEndpointStatus: Decodable, Equatable, Hashable, Sendable {
    public let url: String?
    public let selfHosted: Bool?
    public let onHost: Bool?

    public init(url: String? = nil, selfHosted: Bool? = nil, onHost: Bool? = nil) {
        self.url = url
        self.selfHosted = selfHosted
        self.onHost = onHost
    }
}

/// `POST /admin/inference/backends/:key/decision/verify` and
/// `POST /admin/inference/typesafe/verify`: one small invented decision.
/// `reason` is written for the operator and is shown as is.
public struct DecisionVerifyResult: Decodable, Equatable, Sendable {
    public let ok: Bool
    /// The model id the server answered with, which may resolve an alias.
    public let answeredBy: String?
    public let latencyMs: Int?
    /// HTTP status of a refused request.
    public let status: Int?
    public let reason: String?

    public init(ok: Bool, answeredBy: String? = nil, latencyMs: Int? = nil, status: Int? = nil, reason: String? = nil) {
        self.ok = ok
        self.answeredBy = answeredBy
        self.latencyMs = latencyMs
        self.status = status
        self.reason = reason
    }
}

/// `POST /admin/inference/backends/:key/decision/probe` and
/// `POST /admin/inference/decision/probe`: the models a local decision server
/// lists. `listed == false` with `ok` means the server was not asked
/// (a hosted provider), so the preset's models are the suggestions.
public struct DecisionProbeResult: Decodable, Equatable, Sendable {
    public let ok: Bool
    public let models: [String]
    public let listed: Bool
    public let reason: String?

    public init(ok: Bool, models: [String] = [], listed: Bool = false, reason: String? = nil) {
        self.ok = ok
        self.models = models
        self.listed = listed
        self.reason = reason
    }

    private enum CodingKeys: String, CodingKey {
        case ok, models, listed, reason
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        ok = try values.decode(Bool.self, forKey: .ok)
        models = try values.decodeIfPresent([String].self, forKey: .models) ?? []
        listed = try values.decodeIfPresent(Bool.self, forKey: .listed) ?? false
        reason = try values.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// `GET|POST|DELETE /admin/models/decision/calibration`: the gateway's one
/// calibration job. `state` is `idle`, `running`, `done`, `failed` or
/// `cancelled`; an unknown state decodes as is.
public struct DecisionCalibrationStatus: Decodable, Equatable, Sendable {
    public let state: String
    /// The assignment being (or last) calibrated, `<backend>/<model>`.
    public let assignment: String?
    public let done: Int
    public let total: Int
    public let failed: Int
    public let startedAt: String?
    public let finishedAt: String?
    public let result: DecisionCalibration?
    public let error: String?

    public var isRunning: Bool {
        state == "running"
    }

    public init(
        state: String,
        assignment: String? = nil,
        done: Int = 0,
        total: Int = 0,
        failed: Int = 0,
        startedAt: String? = nil,
        finishedAt: String? = nil,
        result: DecisionCalibration? = nil,
        error: String? = nil
    ) {
        self.state = state
        self.assignment = assignment
        self.done = done
        self.total = total
        self.failed = failed
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.result = result
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case state, assignment, done, total, failed, startedAt, finishedAt, result, error
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        state = try values.decodeIfPresent(String.self, forKey: .state) ?? "idle"
        assignment = try values.decodeIfPresent(String.self, forKey: .assignment)
        done = try values.decodeIfPresent(Int.self, forKey: .done) ?? 0
        total = try values.decodeIfPresent(Int.self, forKey: .total) ?? 0
        failed = try values.decodeIfPresent(Int.self, forKey: .failed) ?? 0
        startedAt = try values.decodeIfPresent(String.self, forKey: .startedAt)
        finishedAt = try values.decodeIfPresent(String.self, forKey: .finishedAt)
        result = try values.decodeIfPresent(DecisionCalibration.self, forKey: .result)
        error = try values.decodeIfPresent(String.self, forKey: .error)
    }
}
