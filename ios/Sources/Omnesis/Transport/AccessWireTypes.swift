// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public enum AccessSourceMode: String, Codable, CaseIterable, Equatable, Sendable {
    case all
    case allowlist
    case denylist
}

public struct AccessSourceBoundary: Codable, Equatable, Sendable {
    public let mode: AccessSourceMode
    public let sourceIds: [String]

    public init(mode: AccessSourceMode, sourceIds: [String]) {
        self.mode = mode
        self.sourceIds = sourceIds
    }
}

public enum AccessAnswerRelease: Equatable, Sendable {
    case reviewed(policyFamilyId: String)
    case unreviewed
}

extension AccessAnswerRelease: Codable {
    private enum CodingKeys: String, CodingKey { case mode, policyFamilyId }
    private enum Mode: String, Codable { case reviewed, unreviewed }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Mode.self, forKey: .mode) {
        case .reviewed:
            self = try .reviewed(
                policyFamilyId: values.decode(String.self, forKey: .policyFamilyId)
            )
        case .unreviewed:
            self = .unreviewed
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .reviewed(let policyFamilyId):
            try values.encode(Mode.reviewed, forKey: .mode)
            try values.encode(policyFamilyId, forKey: .policyFamilyId)
        case .unreviewed:
            try values.encode(Mode.unreviewed, forKey: .mode)
        }
    }
}

public enum AccessGrantRule: Equatable, Sendable {
    case notes
    case direct(sources: AccessSourceBoundary)
    case answer(sources: AccessSourceBoundary, release: AccessAnswerRelease)
}

extension AccessGrantRule: Codable {
    private enum CodingKeys: String, CodingKey { case capability, sources, release }
    private enum Capability: String, Codable { case direct, answer, notes }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let sources = try values.decode(AccessSourceBoundary.self, forKey: .sources)
        switch try values.decode(Capability.self, forKey: .capability) {
        case .notes:
            guard sources == AccessSourceBoundary(mode: .all, sourceIds: []), !values.contains(.release) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .sources,
                    in: values,
                    debugDescription: "Notes has no source boundary or release policy"
                )
            }
            self = .notes
        case .direct:
            self = .direct(sources: sources)
        case .answer:
            self = try .answer(
                sources: sources,
                release: values.decode(AccessAnswerRelease.self, forKey: .release)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .notes:
            try values.encode(Capability.notes, forKey: .capability)
            try values.encode(AccessSourceBoundary(mode: .all, sourceIds: []), forKey: .sources)
        case .direct(let sources):
            try values.encode(Capability.direct, forKey: .capability)
            try values.encode(sources, forKey: .sources)
        case .answer(let sources, let release):
            try values.encode(Capability.answer, forKey: .capability)
            try values.encode(sources, forKey: .sources)
            try values.encode(release, forKey: .release)
        }
    }
}

public struct AccessSourceInstance: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let icon: String?
    public let available: Bool

    public init(id: String, name: String, icon: String? = nil, available: Bool = true) {
        self.id = id
        self.name = name
        self.icon = icon
        self.available = available
    }
}

public struct AccessPolicyFamilySummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let revision: String

    public init(id: String, name: String, revision: String) {
        self.id = id
        self.name = name
        self.revision = revision
    }
}

public struct AccessCredentialSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let label: String
    public let status: String
    public let revokedAt: Int64?
    /// When this sign-in last reached the gateway; nil until it has.
    public let lastUsedAt: Int64?
    /// The name the signed-in app reported for itself, when known.
    public let clientName: String?

    public init(
        id: String,
        label: String,
        status: String,
        revokedAt: Int64?,
        lastUsedAt: Int64? = nil,
        clientName: String? = nil
    ) {
        self.id = id
        self.label = label
        self.status = status
        self.revokedAt = revokedAt
        self.lastUsedAt = lastUsedAt
        self.clientName = clientName
    }
}

public struct AccessGrantSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let revision: Int
    public let rules: [AccessGrantRule]
    public let credentials: [AccessCredentialSummary]
    public let expiresAt: Int64?
    public let revokedAt: Int64?
    /// The access level this connection uses. Nil for a revoked or legacy
    /// grant, and absent from a gateway that predates access levels.
    public let levelId: String?

    public init(
        id: String,
        name: String,
        revision: Int,
        rules: [AccessGrantRule],
        credentials: [AccessCredentialSummary],
        expiresAt: Int64?,
        revokedAt: Int64?,
        levelId: String? = nil
    ) {
        self.id = id
        self.name = name
        self.revision = revision
        self.rules = rules
        self.credentials = credentials
        self.expiresAt = expiresAt
        self.revokedAt = revokedAt
        self.levelId = levelId
    }
}

/// A named, reusable set of permissions several connections can share.
public struct AccessLevelSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let revision: Int
    public let rules: [AccessGrantRule]
    /// How many live connections use this level.
    public let connectionCount: Int
    public let createdAt: Int64
    public let updatedAt: Int64

    public init(
        id: String,
        name: String,
        revision: Int,
        rules: [AccessGrantRule],
        connectionCount: Int,
        createdAt: Int64,
        updatedAt: Int64
    ) {
        self.id = id
        self.name = name
        self.revision = revision
        self.rules = rules
        self.connectionCount = connectionCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct AccessPrincipalSummary: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let kind: String
    public let grants: [AccessGrantSummary]
    public let revokedAt: Int64?
}

/// An authorization request still waiting for the owner's decision, as the
/// overview lists it. The id addresses the request directly, so a listed
/// request is opened without the code the requesting client displays.
public struct AccessPendingRequest: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let clientName: String
    public let createdAt: Int64
    public let expiresAt: Int64

    public init(id: String, clientName: String, createdAt: Int64, expiresAt: Int64) {
        self.id = id
        self.clientName = clientName
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }
}

public struct AccessOverview: Equatable, Sendable {
    public let principals: [AccessPrincipalSummary]
    public let sources: [AccessSourceInstance]
    public let policyFamilies: [AccessPolicyFamilySummary]
    public let defaultPolicyFamilyId: String?
    /// Requests waiting for a decision, newest first. Nil from a gateway
    /// that does not report them, which reads the same as none waiting.
    public let pendingRequests: [AccessPendingRequest]?
    /// The live access levels. Empty from a gateway that has none, or that
    /// predates them.
    public let levels: [AccessLevelSummary]

    public init(
        principals: [AccessPrincipalSummary],
        sources: [AccessSourceInstance],
        policyFamilies: [AccessPolicyFamilySummary],
        defaultPolicyFamilyId: String? = nil,
        pendingRequests: [AccessPendingRequest]? = nil,
        levels: [AccessLevelSummary] = []
    ) {
        self.principals = principals
        self.sources = sources
        self.policyFamilies = policyFamilies
        self.defaultPolicyFamilyId = defaultPolicyFamilyId
        self.pendingRequests = pendingRequests
        self.levels = levels
    }

    /// The sources a grant can be drawn over right now. A listed source that
    /// is unavailable is shown for the decision it retains, never offered.
    public var availableSourceIds: Set<String> {
        Set(sources.filter(\.available).map(\.id))
    }
}

extension AccessOverview: Codable {
    private enum CodingKeys: String, CodingKey {
        case principals, sources, policyFamilies, privacyPolicies, defaultPolicyFamilyId, pendingRequests, levels
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        principals = try values.decode([AccessPrincipalSummary].self, forKey: .principals)
        sources = try values.decode([AccessSourceInstance].self, forKey: .sources)
        policyFamilies = try values.decodeIfPresent(
            [AccessPolicyFamilySummary].self,
            forKey: .policyFamilies
        ) ?? values.decode([AccessPolicyFamilySummary].self, forKey: .privacyPolicies)
        defaultPolicyFamilyId = try values.decodeIfPresent(
            String.self,
            forKey: .defaultPolicyFamilyId
        )
        pendingRequests = try values.decodeIfPresent([AccessPendingRequest].self, forKey: .pendingRequests)
        levels = try values.decodeIfPresent([AccessLevelSummary].self, forKey: .levels) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(principals, forKey: .principals)
        try values.encode(sources, forKey: .sources)
        try values.encode(policyFamilies, forKey: .policyFamilies)
        try values.encodeIfPresent(defaultPolicyFamilyId, forKey: .defaultPolicyFamilyId)
        try values.encodeIfPresent(pendingRequests, forKey: .pendingRequests)
        try values.encode(levels, forKey: .levels)
    }
}

public struct AccessAuthorizationRequest: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let approvalId: String
    public let status: String
    public let clientId: String
    public let clientName: String
    public let clientUri: String?
    public let redirectOrigin: String
    public let resource: String
    public let scope: String
    public let expiresAt: Int64
    public let requiresAnswer: Bool
}

/// The access level a new connection uses: one created from the rules the
/// approval sends, or an existing one at the revision the owner reviewed.
public enum AccessConnectionLevelSelection: Equatable, Sendable {
    case new(name: String, rules: [AccessGrantRule])
    case existing(levelId: String, expectedLevelRevision: Int)
}

extension AccessConnectionLevelSelection: Encodable {
    private enum CodingKeys: String, CodingKey { case kind, name, rules, levelId, expectedLevelRevision }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .new(let name, let rules):
            try values.encode("new", forKey: .kind)
            try values.encode(name, forKey: .name)
            try values.encode(rules, forKey: .rules)
        case .existing(let levelId, let revision):
            try values.encode("existing", forKey: .kind)
            try values.encode(levelId, forKey: .levelId)
            try values.encode(revision, forKey: .expectedLevelRevision)
        }
    }
}

/// What approval asks the gateway to do.
///
/// `newConnection` and `replaceConnection` name the connection the approval
/// produces. `connect` is what a gateway without connection proposals
/// accepts: it hands the gateway the rules and lets it choose the connection.
public enum AccessAuthorizationSelection: Equatable, Sendable {
    case newConnection(name: String, level: AccessConnectionLevelSelection)
    case replaceConnection(connectionId: String, expectedGrantRevision: Int)
    case connect(rules: [AccessGrantRule], credentialLabel: String)
}

extension AccessAuthorizationSelection: Encodable {
    private enum CodingKeys: String, CodingKey {
        case kind, rules, credentialLabel, name, level, connectionId, expectedGrantRevision
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .newConnection(let name, let level):
            try values.encode("new-connection", forKey: .kind)
            try values.encode(name, forKey: .name)
            try values.encode(level, forKey: .level)
        case .replaceConnection(let connectionId, let revision):
            try values.encode("replace-connection", forKey: .kind)
            try values.encode(connectionId, forKey: .connectionId)
            try values.encode(revision, forKey: .expectedGrantRevision)
        case .connect(let rules, let label):
            try values.encode("connect", forKey: .kind)
            try values.encode(rules, forKey: .rules)
            try values.encode(label, forKey: .credentialLabel)
        }
    }
}

public enum AccessAuthorizationDecision: Encodable, Equatable, Sendable {
    case approve(AccessAuthorizationSelection)
    case deny

    private enum CodingKeys: String, CodingKey { case decision, selection }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .approve(let selection):
            try values.encode("approve", forKey: .decision)
            try values.encode(selection, forKey: .selection)
        case .deny:
            try values.encode("deny", forKey: .decision)
        }
    }
}

/// The access a connecting client already holds, as a gateway without
/// connection proposals reports it: approving with `connect` reconnects the
/// client to this principal's grant, with the rules as adjusted in the wizard.
public struct AccessReconnectProposal: Decodable, Equatable, Sendable {
    public struct Principal: Decodable, Equatable, Sendable {
        public let id: String
        public let name: String
    }

    public let matchedBy: String
    public let principal: Principal
    public let grant: AccessGrantSummary
}

/// How the gateway suggests approving a request: the names a new connection
/// and a new access level would take, the live connection from the same app
/// it found, if any, and which approval path it recommends.
public struct AccessConnectionProposal: Decodable, Equatable, Sendable {
    public enum Recommendation: String, Decodable, Equatable, Sendable {
        case existingLevel = "existing-level"
        case newLevel = "new-level"
        case replace

        /// A recommendation this build does not know opens on the path that
        /// assumes nothing: a new access level.
        public init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Recommendation(rawValue: raw) ?? .newLevel
        }
    }

    public struct Match: Decodable, Equatable, Sendable {
        public let connectionId: String
        public let connectionName: String
        /// "device", "client" or "name".
        public let matchedBy: String
        public let levelId: String?
        public let grant: AccessGrantSummary

        public init(
            connectionId: String,
            connectionName: String,
            matchedBy: String,
            levelId: String?,
            grant: AccessGrantSummary
        ) {
            self.connectionId = connectionId
            self.connectionName = connectionName
            self.matchedBy = matchedBy
            self.levelId = levelId
            self.grant = grant
        }
    }

    public let defaultName: String
    public let defaultLevelName: String
    public let match: Match?
    public let recommended: Recommendation

    public init(defaultName: String, defaultLevelName: String, match: Match?, recommended: Recommendation) {
        self.defaultName = defaultName
        self.defaultLevelName = defaultLevelName
        self.match = match
        self.recommended = recommended
    }
}

public struct AccessAuthorizationLookupEnvelope: Decodable, Equatable, Sendable {
    public let request: AccessAuthorizationRequest
    public let reconnect: AccessReconnectProposal?
    /// Present from a gateway that offers the Connection step; nil from one
    /// that predates it, which is approved with `connect`.
    public let connection: AccessConnectionProposal?
}

/// UI state keeps effective access, while the wire boundary stores the compact
/// allow/deny rule. This is why a checked source always means "allowed" in all
/// three modes even though a denylist serializes the unchecked rows.
public struct AccessSourceSelectionState: Equatable, Sendable {
    public var mode: AccessSourceMode
    public var allowedSourceIds: Set<String>
    private var unavailableReferencedIds: Set<String>
    /// The denylist wire stores explicit denials, not the complement of a
    /// potentially stale UI snapshot. Keeping those decisions separately is
    /// what makes source accounts connected later default to allowed.
    private var explicitlyDeniedIds: Set<String>

    public init(
        boundary: AccessSourceBoundary,
        knownSourceIds: Set<String>
    ) {
        mode = boundary.mode
        let referenced = Set(boundary.sourceIds)
        unavailableReferencedIds = referenced.subtracting(knownSourceIds)
        explicitlyDeniedIds = boundary.mode == .denylist ? referenced : []
        switch boundary.mode {
        case .all:
            allowedSourceIds = knownSourceIds
        case .allowlist:
            allowedSourceIds = referenced
        case .denylist:
            allowedSourceIds = knownSourceIds.subtracting(referenced)
        }
    }

    public static func newGrant(knownSourceIds: Set<String>) -> Self {
        Self(
            boundary: AccessSourceBoundary(mode: .allowlist, sourceIds: []),
            knownSourceIds: knownSourceIds
        )
    }

    public mutating func setMode(_ newMode: AccessSourceMode, knownSourceIds: Set<String>) {
        mode = newMode
        switch newMode {
        case .all:
            allowedSourceIds.formUnion(knownSourceIds)
            explicitlyDeniedIds.subtract(knownSourceIds)
        case .allowlist:
            break
        case .denylist:
            explicitlyDeniedIds = knownSourceIds.subtracting(allowedSourceIds)
                .union(unavailableReferencedIds)
        }
    }

    /// Whether a source connected after this grant is written inherits access.
    ///
    /// This is the one thing the mode decides that the per-source decisions
    /// cannot express, so it is the only part of the mode the owner is asked
    /// about directly.
    public var allowsFutureSources: Bool {
        mode != .allowlist
    }

    /// Change only whether sources connected later inherit access, leaving
    /// every currently connected source's decision exactly as it stands.
    public mutating func setFutureSourcesAllowed(
        _ allowed: Bool,
        knownSourceIds: Set<String>
    ) {
        guard allowed else {
            setMode(.allowlist, knownSourceIds: knownSourceIds)
            return
        }
        // "All sources" can admit the future only when it has no exception to
        // record; otherwise the denylist carries the exceptions and admits the
        // future just the same.
        setMode(
            allowedSourceIds.isSuperset(of: knownSourceIds) ? .all : .denylist,
            knownSourceIds: knownSourceIds
        )
    }

    public mutating func setAllowed(_ allowed: Bool, sourceId: String) {
        if allowed {
            allowedSourceIds.insert(sourceId)
            explicitlyDeniedIds.remove(sourceId)
            unavailableReferencedIds.remove(sourceId)
        } else {
            allowedSourceIds.remove(sourceId)
            // "All sources" has no way to record an exception, so blocking one
            // under it becomes the denylist that does — which still admits
            // sources connected later, the separate choice this leaves alone.
            if mode == .all { mode = .denylist }
            if mode == .denylist { explicitlyDeniedIds.insert(sourceId) }
        }
    }

    public mutating func allowAll(_ knownSourceIds: Set<String>) {
        allowedSourceIds.formUnion(knownSourceIds)
        explicitlyDeniedIds.subtract(knownSourceIds)
        unavailableReferencedIds.subtract(knownSourceIds)
    }

    public mutating func blockAll(_ knownSourceIds: Set<String>) {
        allowedSourceIds.subtract(knownSourceIds)
        if mode == .all { mode = .denylist }
        if mode == .denylist { explicitlyDeniedIds.formUnion(knownSourceIds) }
    }

    public func boundary(knownSourceIds: Set<String>) -> AccessSourceBoundary {
        let ids: Set<String> = switch mode {
        case .all:
            []
        case .allowlist:
            allowedSourceIds
        case .denylist:
            explicitlyDeniedIds.union(unavailableReferencedIds)
        }
        return AccessSourceBoundary(mode: mode, sourceIds: ids.sorted())
    }

    /// Approval is meaningless when no currently connected source can be read.
    public func permitsAnyKnownSource(_ knownSourceIds: Set<String>) -> Bool {
        switch mode {
        case .all:
            !knownSourceIds.isEmpty
        case .allowlist, .denylist:
            !allowedSourceIds.isDisjoint(with: knownSourceIds)
        }
    }
}
