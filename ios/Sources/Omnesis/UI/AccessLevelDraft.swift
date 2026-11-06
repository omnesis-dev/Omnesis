// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

func accessFilterEntryVisible(authoringEnabled: Bool?, sourceAllowed: Bool, hasDeclaration: Bool, hasSavedPolicy: Bool) -> Bool {
    hasSavedPolicy || (authoringEnabled == true && sourceAllowed && hasDeclaration)
}

func accessBoundaryPreservesFilters(_ boundary: AccessSourceBoundary, policies: [ScopePolicy], authoringEnabled: Bool?) -> Bool {
    authoringEnabled == true || policies.allSatisfy { policy in
        switch boundary.mode {
        case .all: true
        case .allowlist: boundary.sourceIds.contains(policy.sourceId)
        case .denylist: !boundary.sourceIds.contains(policy.sourceId)
        }
    }
}

extension AccessGrantRule {
    var capability: String {
        switch self {
        case .notes: "notes"
        case .answer: "answer"
        case .direct: "direct"
        }
    }

    var scopePolicies: [ScopePolicy] {
        switch self {
        case .notes: []
        case .answer(_, _, _, let policies), .direct(_, _, let policies): policies
        }
    }

    var filterRevision: Int? {
        switch self {
        case .notes: nil
        case .answer(_, _, let revision, _), .direct(_, let revision, _): revision
        }
    }

    var boundary: AccessSourceBoundary {
        switch self {
        case .notes: .init(mode: .all, sourceIds: [])
        case .direct(let sources, _, _), .answer(let sources, _, _, _): sources
        }
    }

    var release: AccessAnswerRelease? {
        if case .answer(_, let release, _, _) = self { release } else { nil }
    }

    func replacing(
        boundary: AccessSourceBoundary? = nil,
        policies: [ScopePolicy]? = nil,
        release: AccessAnswerRelease? = nil
    )
        -> Self {
        switch self {
        case .notes: .notes
        case .direct(let old, let revision, let previous):
            .direct(sources: boundary ?? old, filterRevision: revision, scopePolicies: policies ?? previous)
        case .answer(let old, let oldRelease, let revision, let previous):
            .answer(
                sources: boundary ?? old,
                release: release ?? oldRelease,
                filterRevision: revision,
                scopePolicies: policies ?? previous
            )
        }
    }
}

/// The same draft mechanics back ongoing editing and new connection permissions.
struct AccessLevelDraft: Equatable {
    var id: String
    var name: String
    var rules: [AccessGrantRule]
    var expectedRevision: Int?
    var expectedFilterRevisions: [String: Int]
    var directSameAsAnswer: Bool

    init(level: AccessLevelSummary?, overview: AccessOverview) {
        id = level?.id ?? "new"
        name = level?.name ?? ""
        expectedRevision = level?.revision
        rules = level?.rules ?? [.answer(
            sources: .init(mode: .allowlist, sourceIds: []),
            release: .reviewed(policyFamilyId: overview.defaultPolicyFamilyId ?? overview.policyFamilies.first?.id ?? "")
        )]
        expectedFilterRevisions = Dictionary(uniqueKeysWithValues: rules.filter { $0.capability != "notes" }
            .map { ($0.capability, $0.filterRevision ?? 0) })
        directSameAsAnswer = level == nil
    }

    func rule(_ capability: String) -> AccessGrantRule? {
        rules.first { $0.capability == capability }
    }

    mutating func setRule(_ rule: AccessGrantRule) {
        rules.removeAll { $0.capability == rule.capability }
        rules.append(rule)
    }

    mutating func setEnabled(_ capability: String, _ enabled: Bool, overview: AccessOverview) {
        if !enabled {
            if capability == "answer", directSameAsAnswer, rule("direct") != nil {
                copyAnswer()
                directSameAsAnswer = false
            }
            rules.removeAll { $0.capability == capability }
            return
        }
        guard rule(capability) == nil else { return }
        if capability == "notes" {
            rules.append(.notes)
        } else if capability == "direct" {
            rules.append(.direct(sources: .init(mode: .allowlist, sourceIds: [])))
        } else {
            rules.append(.answer(
                sources: .init(mode: .allowlist, sourceIds: []),
                release: .reviewed(policyFamilyId: overview.defaultPolicyFamilyId ?? overview.policyFamilies.first?.id ?? "")
            ))
        }
    }

    func canCopyAnswer(authoringEnabled: Bool?) -> Bool {
        authoringEnabled == true || (rule("answer")?.scopePolicies.isEmpty != false && rule("direct")?.scopePolicies.isEmpty != false)
    }

    func canSetBoundary(_ boundary: AccessSourceBoundary, capability: String, authoringEnabled: Bool?) -> Bool {
        accessBoundaryPreservesFilters(boundary, policies: rule(capability)?.scopePolicies ?? [], authoringEnabled: authoringEnabled)
    }

    mutating func setBoundary(_ boundary: AccessSourceBoundary, capability: String, authoringEnabled: Bool?) {
        guard let rule = rule(capability),
              canSetBoundary(boundary, capability: capability, authoringEnabled: authoringEnabled) else { return }
        let policies = rule.scopePolicies.filter { accessBoundaryPreservesFilters(boundary, policies: [$0], authoringEnabled: false) }
        setRule(rule.replacing(boundary: boundary, policies: policies))
    }

    mutating func copyAnswer(authoringEnabled: Bool? = true) {
        guard canCopyAnswer(authoringEnabled: authoringEnabled) else { return }
        guard let answer = rule("answer"), let direct = rule("direct") else { return }
        let copied = answer.scopePolicies.map { policy in
            var copy = policy
            copy.audience = .init(accessLevel: id, capability: "direct")
            return copy
        }
        setRule(direct.replacing(boundary: answer.boundary, policies: copied))
    }

    mutating func setDirectSameAsAnswer(_ linked: Bool, authoringEnabled: Bool? = true) {
        guard !linked || canCopyAnswer(authoringEnabled: authoringEnabled) else { return }
        if !linked, directSameAsAnswer { copyAnswer() }
        directSameAsAnswer = linked
    }

    var serializedRules: [AccessGrantRule] {
        var copy = self
        if directSameAsAnswer { copy.copyAnswer() }
        return copy.rules
    }

    mutating func setPolicy(_ policy: ScopePolicy?, sourceId: String, capability: String) {
        guard let rule = rule(capability) else { return }
        var policies = rule.scopePolicies.filter { $0.sourceId != sourceId }
        if let policy { policies.append(policy) }
        setRule(rule.replacing(policies: policies))
    }

    var valid: Bool {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 120, !rules.isEmpty else { return false }
        if case .reviewed(let family) = rule("answer")?.release { return !family.isEmpty }
        return true
    }
}

func scopeTypedIdentifier(_ value: String, type: String) -> ScopeIdentifier? {
    guard ["phone", "email", "domain"].contains(type) else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = type == "phone" ? trimmed.replacingOccurrences(of: "[\\s().-]", with: "", options: .regularExpression) : trimmed
        .lowercased()
    let pattern = type == "phone" ? "^\\+[1-9][0-9]{6,14}$" : type == "domain"
        ? "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$" : "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"
    guard normalized.range(of: pattern, options: .regularExpression) != nil else { return nil }
    return ScopeIdentifier(type: type, value: normalized)
}
