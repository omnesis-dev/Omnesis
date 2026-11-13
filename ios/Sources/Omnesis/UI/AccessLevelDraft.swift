// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

func accessFilterEntryVisible(authoringEnabled: Bool?, sourceAllowed: Bool, hasDeclaration: Bool, hasSavedPolicy: Bool) -> Bool {
    hasSavedPolicy || (authoringEnabled == true && sourceAllowed && hasDeclaration)
}

func accessBoundaryPreservesFilters(_ boundary: AccessSourceBoundary, policies: [ScopePolicy], authoringEnabled: Bool?) -> Bool {
    authoringEnabled == true || policies.allSatisfy { !accessBoundaryLeavesOut(boundary, $0.sourceId) }
}

/// Whether a boundary leaves an account out by name: absent from an allow list, or on a deny list.
func accessBoundaryLeavesOut(_ boundary: AccessSourceBoundary, _ sourceId: String) -> Bool {
    switch boundary.mode {
    case .all: false
    case .allowlist: !boundary.sourceIds.contains(sourceId)
    case .denylist: boundary.sourceIds.contains(sourceId)
    }
}

/// The filters a boundary sends: an account the boundary leaves out shares nothing, so its filter is not sent.
func accessFiltersOfSharedAccounts(_ policies: [ScopePolicy], boundary: AccessSourceBoundary) -> [ScopePolicy] {
    policies.filter { !accessBoundaryLeavesOut(boundary, $0.sourceId) }
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

/// Whether a saved level's Direct reads exactly what its Answer reads: the same accounts, the same choice for new
/// sources and the same filters. Saved levels record no link, so a level that mirrors Answer opens with Direct linked.
/// A level holding only one of the two has nothing to keep apart, so Direct starts linked once it is added.
func accessDirectMirrorsAnswer(_ rules: [AccessGrantRule]) -> Bool {
    guard let answer = rules.first(where: { $0.capability == "answer" }),
          let direct = rules.first(where: { $0.capability == "direct" }) else { return true }
    func filters(_ rule: AccessGrantRule) -> [ScopePolicy] {
        rule.scopePolicies.map { policy in
            var copy = canonicalAccessPolicy(policy)
            copy.audience = .init(accessLevel: "", capability: "")
            return copy
        }
        .sorted { $0.sourceId < $1.sourceId }
    }
    return canonicalAccessBoundary(answer.boundary) == canonicalAccessBoundary(direct.boundary) && filters(answer) == filters(direct)
}

extension AccessOverview {
    /// The policy a reviewed Answer starts on: the gateway's default, or the first policy it lists.
    var startingPolicyFamilyId: String {
        defaultPolicyFamilyId ?? policyFamilies.first?.id ?? ""
    }
}

/// An access level while it is being decided: the level editor's draft of a new or saved level, and the new level an
/// approval draws for a connection.
struct AccessLevelDraft: Equatable {
    var id: String
    var name: String
    var rules: [AccessGrantRule]
    var expectedRevision: Int?
    var expectedFilterRevisions: [String: Int]
    var directSameAsAnswer: Bool
    /// The rule each capability held when it was switched off, restored when it is switched back on.
    private var removedRules: [String: AccessGrantRule] = [:]
    /// The Direct rule that using Answer's data replaced, restored when Direct is chosen separately again.
    private var separateDirect: AccessGrantRule?

    init(level: AccessLevelSummary?, overview: AccessOverview) {
        id = level?.id ?? "new"
        name = level?.name ?? ""
        expectedRevision = level?.revision
        rules = level?.rules ?? [.answer(
            sources: .init(mode: .allowlist, sourceIds: []),
            release: .reviewed(policyFamilyId: overview.startingPolicyFamilyId)
        )]
        expectedFilterRevisions = Dictionary(uniqueKeysWithValues: rules.filter { $0.capability != "notes" }
            .map { ($0.capability, $0.filterRevision ?? 0) })
        directSameAsAnswer = level == nil || accessDirectMirrorsAnswer(rules)
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
            removedRules[capability] = rule(capability)
            rules.removeAll { $0.capability == capability }
            return
        }
        guard rule(capability) == nil else { return }
        // Answer added beside a Direct that already has its own accounts leaves them as they are rather than linking
        // Direct to Answer's still-empty list.
        if capability == "answer", rule("direct") != nil { directSameAsAnswer = false }
        if let restored = removedRules.removeValue(forKey: capability) {
            rules.append(restored)
            return
        }
        // A new Direct beside Answer reads what Answer reads, never more. On its own, or beside a filtered Answer on a
        // gateway that does not offer filter editing, it starts with no accounts.
        if capability == "direct" {
            directSameAsAnswer = rule("answer") != nil && canCopyAnswer(authoringEnabled: overview.sourceFilters?.enabled)
            separateDirect = nil
        }
        // The gateway fences filter edits on the revision the saved level holds for this capability.
        let savedRevision = expectedFilterRevisions[capability].flatMap { $0 == 0 ? nil : $0 }
        if capability == "notes" {
            rules.append(.notes)
        } else if capability == "direct" {
            rules.append(.direct(sources: .init(mode: .allowlist, sourceIds: []), filterRevision: savedRevision))
        } else {
            rules.append(.answer(
                sources: .init(mode: .allowlist, sourceIds: []),
                release: .reviewed(policyFamilyId: overview.startingPolicyFamilyId),
                filterRevision: savedRevision
            ))
        }
    }

    func canCopyAnswer(authoringEnabled: Bool?) -> Bool {
        authoringEnabled == true || (rule("answer")?.scopePolicies.isEmpty != false && rule("direct")?.scopePolicies.isEmpty != false)
    }

    func canSetBoundary(_ boundary: AccessSourceBoundary, capability: String, authoringEnabled: Bool?) -> Bool {
        accessBoundaryPreservesFilters(boundary, policies: rule(capability)?.scopePolicies ?? [], authoringEnabled: authoringEnabled)
    }

    /// A deselected source keeps its filter while the draft is open, so selecting it again brings the filter back;
    /// `serializedRules` does not send it.
    mutating func setBoundary(_ boundary: AccessSourceBoundary, capability: String, authoringEnabled: Bool?) {
        guard let rule = rule(capability),
              canSetBoundary(boundary, capability: capability, authoringEnabled: authoringEnabled) else { return }
        setRule(rule.replacing(boundary: boundary))
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
        if linked, !directSameAsAnswer { separateDirect = rule("direct") }
        if !linked, directSameAsAnswer {
            if let separateDirect, rule("direct") != nil {
                setRule(separateDirect)
            } else {
                guard canCopyAnswer(authoringEnabled: authoringEnabled) else { return }
                copyAnswer(authoringEnabled: authoringEnabled)
            }
            separateDirect = nil
        }
        directSameAsAnswer = linked
    }

    /// The rules a save sends: Direct copied from Answer while it follows Answer, and no filter for an account that
    /// is not shared.
    var serializedRules: [AccessGrantRule] {
        var copy = self
        if directSameAsAnswer { copy.copyAnswer() }
        return copy.rules.map { $0.replacing(policies: accessFiltersOfSharedAccounts($0.scopePolicies, boundary: $0.boundary)) }
    }

    mutating func setPolicy(_ policy: ScopePolicy?, sourceId: String, capability: String) {
        guard let rule = rule(capability) else { return }
        var policies = rule.scopePolicies.filter { $0.sourceId != sourceId }
        if let policy { policies.append(policy) }
        setRule(rule.replacing(policies: policies))
    }
}

/// Navigation never mutates permissions; only explicit decisions change the draft.
enum AccessFlowStep: String, Hashable {
    case overview, name, permissions, answerData, directChoice, directData, future, release, review
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
}

/// How much of a shared account a filter leaves: "All content", or what the filter does and how many items it names,
/// "Share matching content · 3 items".
func accessBoundaryStatus(_ policy: ScopePolicy?) -> String {
    guard let policy else { return "All content" }
    guard policy.editable else { return AccessAccountStatus.savedFilter }
    let count = policy.rules[0].match.count
    let mode = policy.rules[0].action == "share" ? accessShareMatchingText : accessHideMatchingText
    return "\(mode) · \(count) \(count == 1 ? "item" : "items")"
}

let accessShareMatchingText = "Share matching content"
let accessHideMatchingText = "Hide matching content"

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

/// Shown for a level name another level already has, whether this app or the gateway noticed.
let accessLevelNameTakenMessage = "An access level already uses this name. Choose another."

/// Why a name cannot be given to the level `id`, or nil when it can: it is empty, longer than the gateway accepts, or
/// the name of another level in `levels`, ignoring case and surrounding spaces as the gateway does. The gateway's own
/// refusal still backs this up for a level created after the levels were read.
func accessLevelNameProblem(_ value: String, id: String, levels: [AccessLevelSummary]) -> String? {
    let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if name.isEmpty { return "Enter a name for this access level." }
    if name.utf16.count > accessConnectionNameMaxLength { return "Use at most \(accessConnectionNameMaxLength) characters." }
    if levels
        .contains(where: {
            $0.id != id && $0.name.trimmingCharacters(in: .whitespacesAndNewlines).localizedCaseInsensitiveCompare(name) == .orderedSame
        }) {
        return accessLevelNameTakenMessage
    }
    return nil
}

/// The most source decisions one rule can record on the wire.
let accessMaxSourceSelections = 256

extension AccessLevelDraft {
    /// What stops a capability's source list from being sent, or nil: it records more accounts than a rule can hold,
    /// it names an account that is no longer connected and that the level as it was opened did not name, or it
    /// shares no account at all.
    func sourceProblem(_ capability: String, overview: AccessOverview, original: AccessLevelDraft) -> String? {
        guard let rule = serializedRules.first(where: { $0.capability == capability }), capability != "notes" else { return nil }
        let name = accessCapabilityName(capability)
        let referenced = Set(rule.boundary.sourceIds)
        if referenced.count > accessMaxSourceSelections {
            return "\(name) can record at most \(accessMaxSourceSelections) source selections."
        }
        let known = Set(overview.sources.map(\.id))
        let previous = original.rule(capability)?.boundary
        let retained = previous?.mode == rule.boundary.mode ? Set(previous?.sourceIds ?? []) : []
        if !referenced.subtracting(known.union(retained)).isEmpty {
            return "A saved account is no longer connected. Keep it as it was saved or choose a connected account."
        }
        let noneShared = "Select at least one source for \(name)."
        // A level that is not saved yet has nothing to keep as it was: it has to read an account that is connected.
        let connected = overview.availableSourceIds
        if expectedRevision == nil,
           !AccessSourceSelectionState(boundary: rule.boundary, knownSourceIds: connected).permitsAnyKnownSource(connected) {
            return noneShared
        }
        switch rule.boundary.mode {
        case .all: return nil
        case .allowlist: return referenced.isEmpty || referenced.isDisjoint(with: known.union(retained)) ? noneShared : nil
        case .denylist: return known.subtracting(referenced).isEmpty ? noneShared : nil
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

    /// Counts never hold a filter back: the gateway enforces whatever it saves, and a count still being worked out
    /// says nothing about whether the filter is right.
    var decision: ScopeFilterCommit {
        guard authoringEnabled, policy.editable, policy.sourceId == sourceId else { return .blocked }
        // Hiding nothing shares everything, which is the account without a filter.
        if mode == .all || (mode == .except && policy.rules.allSatisfy(\.match.isEmpty)) { return .apply(nil) }
        // Sharing only what matches nothing would block the account; that is refused rather than saved.
        guard !policy.rules.allSatisfy(\.match.isEmpty), policy.withinLimits else { return .blocked }
        return .apply(policy)
    }
}

/// What applying a filter does for an account that is no longer connected. Nothing can be counted for it,
/// so its saved filter can only lose items: a filter that lost none is not applied, a hiding filter with
/// none left is removed, and a sharing filter with none left is refused because it would share nothing.
func scopeDisconnectedFilterCommit(mode: ScopeFilterMode, policy: ScopePolicy, initial: ScopePolicy?) -> ScopeFilterCommit {
    let kept = policy.rules.first?.match ?? []
    guard policy.editable, kept != initial?.rules.first?.match ?? [] else { return .blocked }
    if kept.isEmpty { return mode == .except ? .apply(nil) : .blocked }
    return .apply(policy)
}

struct AccessFlowNavigation: Equatable {
    var step: AccessFlowStep = .permissions
    var started = false
    var returnToReview = false
    private var targetedQuestions = false
    private var originalSteps: Set<AccessFlowStep> = []
    private var originalRules: [AccessGrantRule] = []
    private var visited: Set<AccessFlowStep> = []
    private var entered: AccessLevelDraft?

    init(step: AccessFlowStep = .permissions, started: Bool = false, returnToReview: Bool = false) {
        self.step = step
        self.started = started
        self.returnToReview = returnToReview
    }

    /// The questions a draft asks, in order. A level being edited asks whether Direct follows Answer on the Direct
    /// data screen itself, so it shows that screen whether or not Direct is linked.
    private static func questions(_ draft: AccessLevelDraft, isEditing: Bool) -> [AccessFlowStep] {
        guard isEditing else { return draft.creationSteps }
        var seen: Set<AccessFlowStep> = []
        return draft.creationSteps.map { $0 == .directChoice ? .directData : $0 }.filter { seen.insert($0).inserted }
    }

    func current(isEditing: Bool) -> AccessFlowStep {
        isEditing && !started ? .overview : step
    }

    /// `entered` is the draft to hand back on cancelling when opening the decision already changed `draft`.
    mutating func open(_ destination: AccessFlowStep, isEditing: Bool, draft: AccessLevelDraft, entered: AccessLevelDraft? = nil) {
        self.entered = entered ?? draft
        returnToReview = current(isEditing: isEditing) == .review
        targetedQuestions = returnToReview || (isEditing && destination == .permissions)
        originalSteps = Set(Self.questions(draft, isEditing: isEditing))
        originalRules = draft.serializedRules
        visited = []
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
            let next = Self.questions(draft, isEditing: isEditing).first { candidate in
                guard candidate != .review, candidate != .permissions, !visited.contains(candidate) else { return false }
                if !originalSteps.contains(candidate) { return true }
                if candidate == .future { return addedReading }
                if candidate == .release { return answerReleaseChanged }
                if candidate == .answerData || candidate == .directData {
                    let capability = candidate == .answerData ? "answer" : "direct"
                    return draft.rule(capability)?.boundary == AccessSourceBoundary(mode: .allowlist, sourceIds: [])
                }
                return false
            }
            if let next { step = next } else { step = returnToReview ? .review : .overview
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

    /// Returns to the page the open decision was entered from, with the draft as it stood on entering it.
    mutating func cancelDecision() -> AccessLevelDraft? {
        let restored = entered
        step = returnToReview ? .review : .overview
        entered = nil
        targetedQuestions = false
        returnToReview = false
        visited = []
        started = true
        return restored
    }

    /// Steps back from a page of the flow itself; a decision opened with Change is left through `cancelDecision`.
    mutating func back(draft: AccessLevelDraft, isEditing: Bool) {
        step = isEditing ? .overview : draft.previousStep(before: current(isEditing: isEditing))
        started = true
    }
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

extension AccessLevelDraft {
    func releaseIsValid(overview: AccessOverview) -> Bool {
        if case .reviewed(let family) = rule("answer")?.release { return overview.policyFamilies.contains { $0.id == family } }
        return true
    }
}

/// The code of the gateway's refusal to create, change or delete an access level, which it sends as a conflict.
func accessLevelMutationCode(_ error: Error) -> String? {
    guard let error = error as? GatewayClient.Error, case .serverError(let status, _) = error, status == 409 else { return nil }
    return accessRefusalCode(error)
}

/// How a refused access-level save is presented.
enum AccessLevelSaveFailure: Equatable { case nameTaken, levelInUse, missingLevel, revisionConflict, other }

func accessLevelSaveFailure(_ error: Error, isEditing: Bool) -> AccessLevelSaveFailure {
    if isEditing, error as? GatewayClient.Error == .notFound { return .missingLevel }
    switch accessLevelMutationCode(error) {
    case "level-name-taken": return .nameTaken
    case "level-in-use": return .levelInUse
    default: break
    }
    if case GatewayClient.Error.serverError(let status, let body) = error, status == 409,
       body.contains("stale") || body.contains("revision") { return .revisionConflict }
    return .other
}

extension AccessLevelDraft {
    mutating func restoreAnswer(from original: AccessLevelDraft) -> Bool {
        guard let answer = original.rule("answer") else { return false }
        removedRules["answer"] = nil
        setRule(answer)
        return true
    }
}

func scopeReferenceLessThan(_ lhs: ScopeRef, _ rhs: ScopeRef) -> Bool {
    let left = (lhs.capability, lhs.field ?? "", lhs.device ?? "", lhs.id ?? "")
    let right = (rhs.capability, rhs.field ?? "", rhs.device ?? "", rhs.id ?? "")
    if left != right { return left < right }
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

    /// Selects an item, or deselects it when it is already selected.
    mutating func toggleMatch(_ ref: ScopeRef) {
        guard editable else { return }
        let count = rules[0].match.count
        rules[0].match.removeAll { scopeRefIdentityMatches($0, ref) }
        if rules[0].match.count == count { rules[0].match.append(ref) }
    }
}

let scopeFilterEmptySelectionMessage = "Select at least one item."

enum ScopeRefChange: Equatable { case added, removed, kept }

struct ScopeRefDelta: Equatable {
    var ref: ScopeRef
    var change: ScopeRefChange
}

/// One list of the items a change between two filters involves: what it adds, then what it removes, then what it keeps.
func scopeRefDeltas(before: ScopePolicy, after: ScopePolicy) -> [ScopeRefDelta] {
    let old = before.rules.flatMap(\.match)
    let new = after.rules.flatMap(\.match)
    let isOld = { (ref: ScopeRef) in old.contains { scopeRefIdentityMatches($0, ref) } }
    let removed = old.filter { ref in !new.contains { scopeRefIdentityMatches($0, ref) } }
    return new.filter { !isOld($0) }.map { .init(ref: $0, change: .added) }
        + removed.map { .init(ref: $0, change: .removed) }
        + new.filter(isOld).map { .init(ref: $0, change: .kept) }
}

func accessSourcesMatching(_ sources: [AccessSourceInstance], query: String) -> [AccessSourceInstance] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return sources }
    return sources.filter { (accessAccountLineText($0) + " " + sourceAccountOf($0.id)).localizedCaseInsensitiveContains(needle) }
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

/// What the review says when the counts cannot be read. The editor keeps asking by itself while another try may
/// succeed.
func scopePreviewFailureMessage(_ error: Error) -> String {
    if case GatewayClient.Error.unauthorized = error {
        return "Your gateway connection changed. Check your connection, then close and reopen this filter."
    }
    if case GatewayClient.Error.notFound = error {
        return "This account is unavailable. Close this filter and return to data selection."
    }
    return "Counts unavailable"
}
