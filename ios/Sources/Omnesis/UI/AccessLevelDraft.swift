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
        if !linked, directSameAsAnswer {
            guard canCopyAnswer(authoringEnabled: authoringEnabled) else { return }
            copyAnswer(authoringEnabled: authoringEnabled)
        }
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
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              name.trimmingCharacters(in: .whitespacesAndNewlines).count <= 120, !rules.isEmpty else { return false }
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

/// Navigation never mutates permissions; only explicit decisions change the draft.
enum AccessFlowStep: String, Hashable {
    case overview, permissions, answerData, directChoice, directData, future, release, review
}

extension AccessLevelDraft {
    var creationSteps: [AccessFlowStep] {
        var result: [AccessFlowStep] = [.permissions]
        if rule("answer") != nil { result.append(.answerData) }
        if rule("direct") != nil {
            if rule("answer") != nil { result.append(.directChoice) }
            if rule("answer") == nil || !directSameAsAnswer { result.append(.directData) }
        }
        if rule("answer") != nil || rule("direct") != nil { result.append(.future) }
        if rule("answer") != nil { result.append(.release) }
        return result + [.review]
    }

    func nextStep(after step: AccessFlowStep) -> AccessFlowStep {
        let steps = creationSteps
        guard let index = steps.firstIndex(of: step), index + 1 < steps.count else { return .review }
        return steps[index + 1]
    }

    func previousStep(before step: AccessFlowStep) -> AccessFlowStep {
        let steps = creationSteps
        guard let index = steps.firstIndex(of: step), index > 0 else { return .permissions }
        return steps[index - 1]
    }

    func changedCapabilities(from original: AccessLevelDraft) -> [String] {
        ["answer", "direct", "notes"].filter { capability in
            original.comparisonRules.first { $0.capability == capability } != comparisonRules.first { $0.capability == capability }
        }
    }
}

func accessRestrictionSummary(_ policy: ScopePolicy?) -> String {
    guard let policy else { return "All content" }
    guard policy.editable else { return "Saved advanced restriction" }
    let refs = policy.rules[0].match
    let labels = refs.map { $0.label ?? $0.identifiers?.map(\.value).joined(separator: ", ") ?? "Unavailable saved item" }
    if labels.isEmpty { return policy.otherwise == "share" ? "All content" : "No content" }
    let prefix = policy.rules[0].action == "share" ? "Only: " : "Except: "
    return prefix + labels.prefix(3).joined(separator: ", ") + (labels.count > 3 ? " and \(labels.count - 3) more" : "")
}

enum ScopeFilterStep: Equatable { case mode, matches, review }

enum ScopeFilterMode: String, CaseIterable {
    case all, only, except

    func applying(to policy: ScopePolicy) -> ScopePolicy {
        var copy = policy
        copy.rules = [.init(match: self == .all ? [] : policy.rules.first?.match ?? [], action: self == .only ? "share" : "hide")]
        copy.otherwise = self == .only ? "hide" : "share"
        return copy
    }

    init(policy: ScopePolicy, hasSavedPolicy: Bool) {
        self = !hasSavedPolicy ? .all : policy.rules.first?.action == "share" ? .only : .except
    }
}

func accessLevelNameProblem(_ value: String, id: String, levels: [AccessLevelSummary]) -> String? {
    let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if name.isEmpty { return "Enter a name before saving." }
    if name.count > 120 { return "Use at most 120 characters." }
    if levels
        .contains(where: {
            $0.id != id && $0.name.trimmingCharacters(in: .whitespacesAndNewlines).localizedCaseInsensitiveCompare(name) == .orderedSame
        }) {
        return "An access level already uses this name. Choose another."
    }
    return nil
}

func accessSourceDisplayName(_ source: AccessSourceInstance) -> String {
    let account = sourceAccountOf(source.id)
    if account.hasPrefix("+"), account.dropFirst().allSatisfy(\.isNumber) {
        let displayedDigits = source.name.filter(\.isNumber)
        if displayedDigits.contains(String(account.dropFirst())) { return source.name }
    }
    guard source.name != "Unavailable saved account", !account.isEmpty,
          !source.name.localizedCaseInsensitiveContains(account) else { return source.name }
    return source.name + " · " + account
}

struct AccessAccountDecision: Equatable {
    var capabilityEnabled: Bool
    var allowed: Bool
    var policy: ScopePolicy?

    init(draft: AccessLevelDraft, capability: String, sourceId: String, knownIds: Set<String>) {
        let rule = draft.serializedRules.first { $0.capability == capability }
        capabilityEnabled = rule != nil
        allowed = rule
            .map { AccessSourceSelectionState(boundary: $0.boundary, knownSourceIds: knownIds).allowedSourceIds.contains(sourceId) } ??
            false
        policy = rule?.scopePolicies.first { $0.sourceId == sourceId }
        policy = policy.map(canonicalAccessPolicy)
    }
}

extension AccessLevelDraft {
    func sourceProblem(_ capability: String, overview: AccessOverview, original: AccessLevelDraft) -> String? {
        guard let rule = serializedRules.first(where: { $0.capability == capability }), capability != "notes" else { return nil }
        let known = Set(overview.sources.map(\.id))
        let previous = original.rule(capability)?.boundary
        let retained = previous?.mode == rule.boundary.mode ? Set(previous?.sourceIds ?? []) : []
        let referenced = Set(rule.boundary.sourceIds)
        if !referenced.subtracting(known.union(retained)).isEmpty {
            return "A saved account is unavailable. Keep its original source boundary or choose an available account."
        }
        switch rule.boundary.mode {
        case .all: return nil
        case .allowlist:
            return referenced.isEmpty || referenced
                .isDisjoint(with: known.union(retained)) ? "Choose at least one account for \(capability.capitalized)." : nil
        case .denylist:
            return known.subtracting(referenced).isEmpty ? "Choose at least one account for \(capability.capitalized)." : nil
        }
    }
}

enum ScopeFilterCommit: Equatable {
    case blocked
    case apply(ScopePolicy?)
}

struct ScopeFilterCommitState {
    var mode: ScopeFilterMode
    var policy: ScopePolicy
    var sourceId: String
    var authoringEnabled: Bool
    var preview: ScopePreview?
    var previewedPolicy: ScopePolicy?
    var loading: Bool
    var hasError: Bool

    var decision: ScopeFilterCommit {
        guard authoringEnabled, policy.editable, policy.sourceId == sourceId else { return .blocked }
        if mode == .all { return .apply(nil) }
        guard !loading, !hasError, policy.withinLimits, let preview,
              preview.sourceId == sourceId, previewedPolicy == policy, policy.readyToSave(preview.readiness) else { return .blocked }
        return .apply(policy)
    }
}

struct AccessFlowNavigation: Equatable {
    var step: AccessFlowStep = .permissions
    var started = false
    var returnToReview = false
    private var targetedQuestions = false
    private var originalSteps: Set<AccessFlowStep> = []
    private var originalRules: [AccessGrantRule] = []
    private var visited: Set<AccessFlowStep> = []
    private var history: [AccessFlowStep] = []

    init(step: AccessFlowStep = .permissions, started: Bool = false, returnToReview: Bool = false) {
        self.step = step
        self.started = started
        self.returnToReview = returnToReview
    }

    func current(isEditing: Bool) -> AccessFlowStep {
        isEditing && !started ? .overview : step
    }

    mutating func open(_ destination: AccessFlowStep, isEditing: Bool, draft: AccessLevelDraft) {
        returnToReview = current(isEditing: isEditing) == .review
        targetedQuestions = returnToReview || (isEditing && destination == .permissions)
        originalSteps = Set(draft.creationSteps.filter { !isEditing || $0 != .directChoice })
        originalRules = draft.serializedRules
        visited = []
        history = []
        step = destination
        started = true
    }

    mutating func advance(draft: AccessLevelDraft, isEditing: Bool) {
        let current = current(isEditing: isEditing)
        if targetedQuestions {
            visited.insert(current)
            let oldReading = Set(originalRules.filter { $0.capability != "notes" }.map(\.capability))
            let newReading = Set(draft.serializedRules.filter { $0.capability != "notes" }.map(\.capability))
            let addedReading = !newReading.subtracting(oldReading).isEmpty
            let answerReleaseChanged = draft.rule("answer") != nil
                && originalRules.first { $0.capability == "answer" }?.release != draft.rule("answer")?.release
            let next = draft.creationSteps.first { candidate in
                guard candidate != .review, candidate != .permissions, !visited.contains(candidate),
                      !isEditing || candidate != .directChoice else { return false }
                if !originalSteps.contains(candidate) { return true }
                if candidate == .future { return addedReading }
                if candidate == .release { return answerReleaseChanged }
                if candidate == .answerData || candidate == .directData {
                    let capability = candidate == .answerData ? "answer" : "direct"
                    return draft.rule(capability)?.boundary == AccessSourceBoundary(mode: .allowlist, sourceIds: [])
                }
                return false
            }
            if let next { history.append(current)
                step = next
            } else { step = returnToReview ? .review : .overview
                targetedQuestions = false
                returnToReview = false
            }
        } else if current == .overview {
            step = .review
        } else if isEditing {
            step = .overview
        } else {
            step = draft.nextStep(after: current)
        }
        started = true
    }

    mutating func back(draft: AccessLevelDraft, isEditing: Bool) {
        if targetedQuestions, let previous = history.popLast() {
            visited.remove(previous)
            step = previous
        } else {
            step = returnToReview ? .review : (isEditing ? .overview : draft.previousStep(before: current(isEditing: isEditing)))
            targetedQuestions = false
            returnToReview = false
        }
        started = true
    }
}

func mergingScopeLabelHints(_ existing: [ScopePreview.Item], _ incoming: [ScopePreview.Item]) -> [ScopePreview.Item] {
    var result = existing
    for item in incoming {
        if let index = result.firstIndex(where: { scopeRefIdentityMatches($0.ref, item.ref) }) {
            result[index] = item
        } else {
            result.append(item)
        }
    }
    return result
}

func canonicalAccessPolicy(_ value: ScopePolicy) -> ScopePolicy {
    var result = value
    for index in result.rules.indices {
        let references = result.rules[index].match.map { reference in
            var ref = reference
            ref.label = nil
            ref.identifiers = ref.identifiers.map { Array(Set($0)) }?.sorted { ($0.type, $0.value) < ($1.type, $1.value) }
            return ref
        }
        result.rules[index].match = references.sorted(by: scopeReferenceLessThan)
    }
    return result
}

extension AccessLevelDraft {
    var comparisonRules: [AccessGrantRule] {
        let rules = serializedRules.map { rule in
            rule.replacing(
                boundary: canonicalAccessBoundary(rule.boundary),
                policies: rule.scopePolicies.map(canonicalAccessPolicy).sorted { $0.sourceId < $1.sourceId }
            )
        }
        return rules.sorted { $0.capability < $1.capability }
    }

    func hasChanges(from original: AccessLevelDraft) -> Bool {
        name.trimmingCharacters(in: .whitespacesAndNewlines) != original.name.trimmingCharacters(in: .whitespacesAndNewlines)
            || comparisonRules != original.comparisonRules
    }
}

func scopeDisplayLabel(_ ref: ScopeRef, previewItem: ScopePreview.Item?) -> String {
    let saved = ref.label ?? ref.identifiers?.map(\.value).joined(separator: ", ") ?? "Saved item"
    guard let previewItem else { return saved }
    return previewItem.missing == true ? saved + " (unavailable)" : previewItem.label
}

extension AccessLevelDraft {
    func releaseIsValid(overview: AccessOverview) -> Bool {
        if case .reviewed(let family) = rule("answer")?.release { return overview.policyFamilies.contains { $0.id == family } }
        return true
    }
}

extension AccessLevelDraft {
    mutating func prepareDirectEditing(authoringEnabled: Bool?) -> Bool {
        guard rule("direct") != nil else { return false }
        if directSameAsAnswer, rule("answer") != nil {
            guard canCopyAnswer(authoringEnabled: authoringEnabled) else { return false }
            setDirectSameAsAnswer(false, authoringEnabled: authoringEnabled)
        }
        return true
    }
}

func accessLevelMutationCode(_ error: Error) -> String? {
    guard let error = error as? GatewayClient.Error, case .serverError(let status, let body) = error, status == 409 else { return nil }
    struct Payload: Decodable { var error: String? }
    return (try? JSONDecoder().decode(Payload.self, from: Data(body.utf8)))?.error
}

extension AccessLevelDraft {
    mutating func restoreAnswer(from original: AccessLevelDraft) -> Bool {
        guard let answer = original.rule("answer") else { return false }
        setRule(answer)
        return true
    }
}

extension AccessLevelDraft {
    func questionIsValid(_ step: AccessFlowStep, overview: AccessOverview, original: AccessLevelDraft) -> Bool {
        switch step {
        case .permissions: !rules.isEmpty
        case .answerData: sourceProblem("answer", overview: overview, original: original) == nil
        case .directData: sourceProblem("direct", overview: overview, original: original) == nil
        case .release: releaseIsValid(overview: overview)
        case .overview, .directChoice, .future, .review: true
        }
    }
}

func scopeReferenceLessThan(_ lhs: ScopeRef, _ rhs: ScopeRef) -> Bool {
    if lhs.kind != rhs.kind { return lhs.kind < rhs.kind }
    if lhs.id != rhs.id { return (lhs.id == nil ? 0 : 1, lhs.id ?? "") < (rhs.id == nil ? 0 : 1, rhs.id ?? "") }
    return (lhs.identifiers ?? []).lexicographicallyPrecedes(rhs.identifiers ?? []) { ($0.type, $0.value) < ($1.type, $1.value) }
}

func canonicalAccessBoundary(_ boundary: AccessSourceBoundary) -> AccessSourceBoundary {
    if boundary.mode == .all || (boundary.mode == .denylist && boundary.sourceIds.isEmpty) {
        return .init(mode: .all, sourceIds: [])
    }
    return .init(mode: boundary.mode, sourceIds: boundary.sourceIds.sorted())
}

extension ScopePolicy {
    mutating func appendMatchIfMissing(_ ref: ScopeRef) {
        guard editable, !rules[0].match.contains(where: { scopeRefIdentityMatches($0, ref) }) else { return }
        rules[0].match.append(ref)
    }
}

func scopeFilterHasChanges(initial: ScopePolicy?, policy: ScopePolicy, mode: ScopeFilterMode) -> Bool {
    let openingMode = initial.map { ScopeFilterMode(policy: $0, hasSavedPolicy: true) } ?? .all
    if mode != openingMode { return true }
    return mode == .all ? initial != nil : policy != initial
}

func scopePreviewCanRetry(_ error: Error) -> Bool {
    if case GatewayClient.Error.unauthorized = error { return false }
    if case GatewayClient.Error.notFound = error { return false }
    return true
}

func scopePreviewFailureMessage(_ error: Error) -> String {
    if case GatewayClient.Error.unauthorized = error {
        return "Your gateway connection changed. Check your connection, then close and reopen this restriction."
    }
    if case GatewayClient.Error.notFound = error {
        return "This account is unavailable. Close this restriction and return to data selection."
    }
    return "Couldn’t check this restriction. Your selections are kept."
}
