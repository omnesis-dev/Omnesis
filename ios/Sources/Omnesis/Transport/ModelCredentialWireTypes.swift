// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

// Wire types for the gateway's model-provider credentials
// (`/admin/model-credentials`), decoded by `AdminClient`.

/// One row of `GET /admin/model-credentials` — a model-provider credential
/// entry. Mirrors `ModelCredentialEntry` in
/// `packages/gateway/src/model-credentials.ts`: the stable `fileKey`, the
/// provider's type/name, the field spec the form renders, and whether
/// credentials are currently configured. No secret value is ever included —
/// only `configured`.
public struct ModelCredentialEntry: Decodable, Equatable, Sendable, Identifiable {
    public let fileKey: String
    public let providerType: String
    public let providerName: String
    public let spec: CredentialSpec
    public let configured: Bool
    /// Whether the gateway's environment supplies the key. Absent on older gateways.
    public let environment: Bool?

    public var id: String {
        fileKey
    }

    public init(
        fileKey: String,
        providerType: String,
        providerName: String,
        spec: CredentialSpec,
        configured: Bool,
        environment: Bool? = nil
    ) {
        self.fileKey = fileKey
        self.providerType = providerType
        self.providerName = providerName
        self.spec = spec
        self.configured = configured
        self.environment = environment
    }
}

/// The JSON-safe credential spec from a provider entry. Only the fields the
/// credential form renders are decoded; the setup `wizard` blob is ignored
/// (the phone shows a compact inline form, not the full CLI/portal wizard).
/// Mirrors `SerializedProviderCredentialsSpec` in `@omnesis/core`.
public struct CredentialSpec: Decodable, Equatable, Sendable {
    public let fields: [CredentialField]

    public init(fields: [CredentialField]) {
        self.fields = fields
    }
}

/// One field a provider's credentials require (e.g. `apiKey`). Mirrors
/// `ProviderCredentialsField` in `@omnesis/core`. `secret` fields render as
/// masked inputs and their values are never read back or logged.
public struct CredentialField: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let label: String
    public let placeholder: String?
    public let secret: Bool?
    public let pattern: String?
    public let patternHint: String?

    public var id: String {
        name
    }

    public init(
        name: String,
        label: String,
        placeholder: String? = nil,
        secret: Bool? = nil,
        pattern: String? = nil,
        patternHint: String? = nil
    ) {
        self.name = name
        self.label = label
        self.placeholder = placeholder
        self.secret = secret
        self.pattern = pattern
        self.patternHint = patternHint
    }
}
