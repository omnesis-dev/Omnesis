// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Provider-owned scope contract and stable saved identifiers. No people-row identity is persisted.
public struct ScopeIdentifier: Codable, Equatable, Hashable, Sendable {
    public var type: String
    public var value: String
}

public struct ScopeRef: Codable, Equatable, Hashable, Sendable {
    public var kind: String
    public var id: String?
    public var label: String?
    public var identifiers: [ScopeIdentifier]?
}

public struct ScopePolicy: Codable, Equatable, Hashable, Sendable {
    public struct Audience: Codable, Equatable, Hashable, Sendable {
        public var accessLevel: String
        public var capability: String
    }

    public struct Rule: Codable, Equatable, Hashable, Sendable {
        public var match: [ScopeRef]
        public var action: String
    }

    public var sourceId: String
    public var audience: Audience
    public var rules: [Rule]
    public var otherwise: String
    public var maxAge: String?

    public var editable: Bool {
        rules.count == 1 && ["share", "hide"].contains(otherwise)
            && rules[0].action != otherwise && ["share", "hide"].contains(rules[0].action)
            && maxAge == nil && rules[0].match.allSatisfy {
                ["conversation", "participant", "label", "folder"].contains($0.kind)
            }
    }

    public var withinLimits: Bool {
        rules.count == 1 && rules[0].match.reduce(0) { $0 + ($1.identifiers?.count ?? 1) } <= 256
    }

    public func readyToSave(_ readiness: [ScopeKindReadiness]) -> Bool {
        !readiness.contains { $0.reason == "backfill" } && (rules.first?.match ?? []).allSatisfy { ref in
            readiness.first { $0.kind == ref.kind }?.ready == true
        }
    }

    public static func empty(sourceId: String, levelId: String, capability: String) -> Self {
        Self(
            sourceId: sourceId,
            audience: .init(accessLevel: levelId, capability: capability),
            rules: [.init(match: [], action: "hide")],
            otherwise: "share"
        )
    }
}

public struct SourceScopeNoun: Codable, Equatable, Sendable {
    public var one: String
    public var many: String
}

public struct SourceScopes: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public var kind: String
        public var identifiers: [String]?
        public var noun: SourceScopeNoun?
        /// What the source calls an item at each depth of its tree, roots first; the last names every deeper level.
        public var levels: [SourceScopeNoun]?
        public var picker: String?
        public var link: String
    }

    public var revision: Int?
    public var items: [Item]
}

public struct ScopeKindReadiness: Codable, Equatable, Sendable {
    public struct Collector: Codable, Equatable, Sendable {
        public var deviceId: String
        public var name: String
    }

    public var kind: String
    public var ready: Bool
    public var reason: String?
    public var message: String?
    public var processed: Int?
    public var pending: Int?
    public var behindCollectors: [Collector]?
}

public struct ScopeOption: Codable, Equatable, Sendable {
    public var ref: ScopeRef
    public var label: String
    public var count: Int
    public var parentId: String?
    public var hasChildren: Bool?
    public var personId: String?
    /// How many ancestors the item has, when its source names the levels of its tree.
    public var depth: Int?
}

public struct ScopeOptions: Codable, Equatable, Sendable {
    public var sourceId: String
    public var sourceType: String
    public var scopes: SourceScopes
    public var readiness: [ScopeKindReadiness]
    public var items: [ScopeOption]
    public var nextCursor: String?
}

public struct ScopePreview: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Sendable {
        public var ref: ScopeRef
        public var label: String
        public var count: Int
        public var parentId: String?
        public var missing: Bool?
        /// How many ancestors the item has, when its source names the levels of its tree.
        public var depth: Int?
    }

    public struct Sample: Codable, Equatable, Sendable {
        public var documentId: String
        public var title: String
        public var visible: Bool
        public var unknown: Bool
    }

    public struct Proposal: Codable, Equatable, Sendable {
        public var itemIndex: Int
        public var label: String
        public var identifiers: [ScopeIdentifier]
    }

    public var sourceId: String
    public var total: Int
    public var visible: Int
    public var hidden: Int
    public var unknown: Int
    public var items: [Item]
    public var samples: [Sample]
    public var identifierProposals: [Proposal]?
    public var readiness: [ScopeKindReadiness]
}
