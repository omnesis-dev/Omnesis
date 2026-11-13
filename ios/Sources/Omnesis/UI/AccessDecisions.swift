// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One decision as a list names it: its title, its value in a line or two, and the step that changes it.
struct AccessDecisionLine: Identifiable, Equatable {
    var title: String
    var value: String
    var step: AccessFlowStep = .overview
    /// The capabilities to show as pills under the value; a line with no value shows only the pills.
    var holdings: AccessCapabilityHoldings?

    var id: String {
        title
    }
}

/// The names the decisions of a level go by, on its page and in its reviews.
enum AccessDecisionTitle {
    static let name = "Name"
    static let permissions = "Permissions"
    static let answerData = "Answer data"
    static let directData = "Direct data"
    static let newSources = "New sources"
    static let release = "Answer release"
}

/// What a decision reads as when the level does not hold the capability it belongs to.
let accessNotGrantedText = "Not granted"

/// What stops the release decision: no privacy policy chosen, and no explicit choice to release without one.
let accessReleaseProblem = "Choose a privacy policy for Answer, or explicitly choose unreviewed release."

/// What a source list says when there is no account to list.
let accessNoConnectedAccountsMessage = "No connected accounts are available. Connect a source before granting data access."

/// What a source account shares under one capability, as the pill under the account says it.
struct AccessAccountStatus: Equatable {
    enum Kind: Equatable { case all, only, except, notShared }

    var kind: Kind
    var text: String

    init(kind: Kind, text: String) {
        self.kind = kind
        self.text = text
    }

    init(allowed: Bool, policy: ScopePolicy?) {
        guard allowed else {
            self.kind = .notShared
            self.text = "Not shared"
            return
        }
        text = accessBoundaryStatus(policy)
        kind = policy.map(Self.kind(of:)) ?? .all
    }

    /// What a pill calls a filter this editor cannot express.
    static let savedFilter = "Saved filter"

    /// How a filter's pill is toned: by whether it shares or hides what it matches, or neutrally for a filter this
    /// editor cannot express.
    static func kind(of policy: ScopePolicy) -> Kind {
        guard policy.editable else { return .all }
        return policy.rules[0].action == "share" ? .only : .except
    }
}

/// A filter as one pill names it: "Share matching content", "Hide matching content", or "Saved filter" for a filter
/// this editor cannot express.
func accessFilterModeStatus(_ policy: ScopePolicy) -> AccessAccountStatus {
    switch AccessAccountStatus.kind(of: policy) {
    case .only: AccessAccountStatus(kind: .only, text: accessShareMatchingText)
    case .except: AccessAccountStatus(kind: .except, text: accessHideMatchingText)
    case .all, .notShared: AccessAccountStatus(kind: .all, text: AccessAccountStatus.savedFilter)
    }
}

/// The decisions an access level is made of, as the decision screens read and change them: a draft of the level over
/// the gateway's overview. The level editor and the approval of a new level both show their screens through it.
struct AccessDraftDecisions {
    var draft: AccessLevelDraft
    let overview: AccessOverview
    /// The level as it was saved or opened, which decides which accounts a changed list may still name.
    let original: AccessLevelDraft
    /// Whether Answer cannot be switched off, because the agent asking needs it.
    var answerRequired = false

    /// The level a new filter names as its audience.
    var levelId: String {
        draft.id
    }

    func holds(_ capability: String) -> Bool {
        draft.rule(capability) != nil
    }

    mutating func setHeld(_ capability: String, _ held: Bool) {
        guard held || capability != "answer" || !answerRequired else { return }
        draft.setEnabled(capability, held, overview: overview)
    }

    /// Whether Direct reads Answer's sources and filters rather than its own. Read only while both are held.
    var directSameAsAnswer: Bool {
        draft.directSameAsAnswer
    }

    var canUseAnswerSourcesForDirect: Bool {
        draft.canCopyAnswer(authoringEnabled: overview.sourceFilters?.enabled)
    }

    mutating func setDirectSameAsAnswer(_ same: Bool) {
        draft.setDirectSameAsAnswer(same, authoringEnabled: overview.sourceFilters?.enabled)
    }

    private func rule(_ capability: String) -> AccessGrantRule? {
        draft.serializedRules.first { $0.capability == capability }
    }

    /// The source accounts a capability reads, or nil when the capability is not held.
    func sourceSelection(_ capability: String) -> AccessSourceSelectionState? {
        rule(capability).map { AccessSourceSelectionState(boundary: $0.boundary, knownSourceIds: overview.availableSourceIds) }
    }

    func canSetSourceSelection(_ selection: AccessSourceSelectionState, capability: String) -> Bool {
        draft.canSetBoundary(
            selection.boundary(knownSourceIds: overview.availableSourceIds),
            capability: capability,
            authoringEnabled: overview.sourceFilters?.enabled
        )
    }

    mutating func setSourceSelection(_ selection: AccessSourceSelectionState, capability: String) {
        draft.setBoundary(
            selection.boundary(knownSourceIds: overview.availableSourceIds),
            capability: capability,
            authoringEnabled: overview.sourceFilters?.enabled
        )
    }

    func policies(_ capability: String) -> [ScopePolicy] {
        rule(capability)?.scopePolicies ?? []
    }

    mutating func setPolicy(_ policy: ScopePolicy?, sourceId: String, capability: String) {
        draft.setPolicy(policy, sourceId: sourceId, capability: capability)
    }

    var release: AccessAnswerRelease? {
        draft.rule("answer")?.release
    }

    mutating func setRelease(_ release: AccessAnswerRelease) {
        if let rule = draft.rule("answer") { draft.setRule(rule.replacing(release: release)) }
    }

    /// What stops a step from being left as it stands, or nil. The level's name is checked where it is typed.
    func problem(_ step: AccessFlowStep) -> String? {
        switch step {
        case .permissions: draft.rules.isEmpty ? accessNoCapabilityMessage : nil
        case .answerData: draft.sourceProblem("answer", overview: overview, original: original)
        case .directData: draft.sourceProblem("direct", overview: overview, original: original)
        case .release: draft.releaseIsValid(overview: overview) ? nil : accessReleaseProblem
        case .overview, .name, .directChoice, .future, .review: nil
        }
    }

    /// What stops either source list from being sent, or nil.
    var sourcesProblem: String? {
        problem(.answerData) ?? problem(.directData)
    }

    /// What stops the level's rules from being sent as they stand, or nil.
    var blockingProblem: String? {
        problem(.permissions) ?? sourcesProblem ?? problem(.release)
    }

    /// Whether the level carries source filters on a gateway that does not offer writing them.
    var filtersNeedAuthoring: Bool {
        !authoringEnabled && draft.serializedRules.contains { !$0.scopePolicies.isEmpty }
    }

    /// The rules a new level is sent with, or nil while a decision still has a problem or the level carries filters
    /// the gateway would not take.
    var sendableRules: [AccessGrantRule]? {
        blockingProblem == nil && !filtersNeedAuthoring ? draft.serializedRules : nil
    }
}

extension AccessDraftDecisions {
    var authoringEnabled: Bool {
        overview.sourceFilters?.enabled == true
    }

    /// Whether one source list stands for both reading capabilities.
    var directFollowsAnswer: Bool {
        holds("answer") && holds("direct") && directSameAsAnswer
    }

    /// Every account a capability's list shows: the connected ones, then any it still names that are no longer connected.
    func sources(_ capability: String) -> [AccessSourceInstance] {
        let known = Set(overview.sources.map(\.id))
        let boundary = sourceSelection(capability)?.boundary(knownSourceIds: overview.availableSourceIds)
        let referenced = Set((boundary?.sourceIds ?? []) + policies(capability).map(\.sourceId))
        return overview.sources + referenced.subtracting(known).sorted().map { accessDisconnectedSource($0, overview: overview) }
    }

    func isAllowed(_ sourceId: String, capability: String) -> Bool {
        sourceSelection(capability)?.allowedSourceIds.contains(sourceId) ?? false
    }

    func policy(_ sourceId: String, capability: String) -> ScopePolicy? {
        policies(capability).first { $0.sourceId == sourceId }
    }

    func status(_ source: AccessSourceInstance, capability: String) -> AccessAccountStatus {
        AccessAccountStatus(allowed: isAllowed(source.id, capability: capability), policy: policy(source.id, capability: capability))
    }

    func filterEntryVisible(_ source: AccessSourceInstance, capability: String) -> Bool {
        accessFilterEntryVisible(
            authoringEnabled: overview.sourceFilters?.enabled,
            sourceAllowed: isAllowed(source.id, capability: capability),
            hasDeclaration: source.filterable == true,
            hasSavedPolicy: policy(source.id, capability: capability) != nil
        )
    }

    /// The selection after ticking or clearing one account, or nil when the account cannot change.
    func selection(toggling source: AccessSourceInstance, capability: String) -> AccessSourceSelectionState? {
        guard var selection = sourceSelection(capability) else { return nil }
        let allowed = selection.allowedSourceIds.contains(source.id)
        guard source.available || allowed else { return nil }
        selection.setAllowed(!allowed, sourceId: source.id)
        return canSetSourceSelection(selection, capability: capability) ? selection : nil
    }

    /// The selection after sharing or blocking every listed account at once. Accounts not listed keep their
    /// decision, and an account that is no longer connected is never turned on.
    func selection(settingAllowed allowed: Bool, for listed: [AccessSourceInstance], capability: String) -> AccessSourceSelectionState? {
        guard var selection = sourceSelection(capability) else { return nil }
        for source in listed where selection.allowedSourceIds.contains(source.id) != allowed && (source.available || !allowed) {
            selection.setAllowed(allowed, sourceId: source.id)
        }
        return canSetSourceSelection(selection, capability: capability) ? selection : nil
    }

    /// "2 of 3 allowed": how many connected accounts a capability reads.
    func allowedCountLabel(_ capability: String) -> String {
        let available = overview.availableSourceIds
        let allowed = sourceSelection(capability)?.allowedSourceIds.intersection(available).count ?? 0
        return "\(allowed) of \(available.count) allowed"
    }

    /// The capabilities that each decide what happens to a source connected later.
    var newSourceCapabilities: [String] {
        ["answer", "direct"].filter { holds($0) && !($0 == "direct" && directFollowsAnswer) }
    }

    func newSourcesHeading(_ capability: String) -> String {
        capability == "answer" && directFollowsAnswer ? "Answer and Direct" : accessCapabilityName(capability)
    }

    func allowsNewSources(_ capability: String) -> Bool {
        sourceSelection(capability)?.allowsFutureSources ?? false
    }

    /// The selection after deciding whether new sources join a capability, or nil when that cannot change.
    func selection(allowingNewSources allowed: Bool, capability: String) -> AccessSourceSelectionState? {
        guard var selection = sourceSelection(capability) else { return nil }
        selection.setFutureSourcesAllowed(allowed, knownSourceIds: overview.availableSourceIds)
        return canSetSourceSelection(selection, capability: capability) ? selection : nil
    }

    /// Which of Answer, Direct and Notes the level allows, as the pill row shows it.
    var capabilityHoldings: AccessCapabilityHoldings {
        AccessCapabilityHoldings(answer: holds("answer"), direct: holds("direct"), notes: holds("notes"))
    }

    /// "3 accounts selected · 2 filtered": a data decision in one line.
    func dataSummary(_ capability: String) -> String {
        if capability == "direct", directFollowsAnswer { return "Same sources and filters as Answer" }
        let selected = sources(capability).filter { isAllowed($0.id, capability: capability) }
        let filtered = selected.filter { policy($0.id, capability: capability) != nil }.count
        return "\(selected.count) \(selected.count == 1 ? "account" : "accounts") selected"
            + (filtered > 0 ? " · \(filtered) filtered" : selected.isEmpty ? "" : " · all content")
    }

    var newSourcesSummary: String {
        let capabilities = newSourceCapabilities
        guard !capabilities.isEmpty else { return accessNotGrantedText }
        return capabilities
            .map { newSourcesHeading($0) + ": " + (allowsNewSources($0) ? "Automatic" : "Blocked") }
            .joined(separator: "\n")
    }

    var releaseSummary: String {
        switch release {
        case .reviewed(let family):
            "Privacy review · " + (overview.policyFamilies.first { $0.id == family }?.name ?? "Saved policy unavailable")
        case .unreviewed: "No privacy review"
        case nil: accessNotGrantedText
        }
    }

    /// Every decision the level holds after its name, in the order the flow asks them.
    var decisionLines: [AccessDecisionLine] {
        // Direct is changed where the flow last asks about it: on its own list, or on the choice to follow Answer.
        let directStep = draft.creationSteps.last { $0 == .directChoice || $0 == .directData } ?? .directData
        return draft.creationSteps.compactMap { step -> AccessDecisionLine? in
            switch step {
            case .permissions:
                AccessDecisionLine(title: AccessDecisionTitle.permissions, value: "", step: step, holdings: capabilityHoldings)
            case .answerData: AccessDecisionLine(title: AccessDecisionTitle.answerData, value: dataSummary("answer"), step: step)
            case directStep: AccessDecisionLine(title: AccessDecisionTitle.directData, value: dataSummary("direct"), step: step)
            case .future: AccessDecisionLine(title: AccessDecisionTitle.newSources, value: newSourcesSummary, step: step)
            case .release: AccessDecisionLine(title: AccessDecisionTitle.release, value: releaseSummary, step: step)
            default: nil
            }
        }
    }
}

/// A source's name and its account, for lists that put each on its own line.
/// An account that is no longer connected says so in place of its address.
func accessSourceNameParts(_ source: AccessSourceInstance) -> (source: String, account: String?) {
    let pieces = source.name.components(separatedBy: " · ")
    let name = pieces[0]
    guard source.available else { return (name, "no longer connected") }
    if pieces.count > 1 { return (name, pieces.dropFirst().joined(separator: " · ")) }
    let account = sourceAccountOf(source.id)
    return (name, account.isEmpty || name.localizedCaseInsensitiveContains(account) ? nil : account)
}

/// "Source · account" on one line.
func accessAccountLineText(_ source: AccessSourceInstance) -> String {
    let name = accessSourceNameParts(source)
    return [name.source, name.account].compactMap { $0 }.joined(separator: " · ")
}

/// An account a level still names that the gateway no longer lists, named after its source.
func accessDisconnectedSource(_ id: String, overview: AccessOverview) -> AccessSourceInstance {
    let type = sourceTypeOf(id)
    let sibling = overview.sources.first { sourceTypeOf($0.id) == type }.map { accessSourceNameParts($0).source }
    let fallback = type.replacingOccurrences(of: "-", with: " ")
    var source = AccessSourceInstance(id: id, name: sibling ?? fallback.prefix(1).uppercased() + fallback.dropFirst(), available: false)
    source.sourceType = type
    return source
}
