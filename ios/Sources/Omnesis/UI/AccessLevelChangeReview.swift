// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// How much of an account one filter leaves shared and hidden, with the gateway's sentences for records it keeps
/// hidden whatever it says.
struct AccessFilterTotals: Equatable {
    var shared: Int
    var hidden: Int
    var undecided: [String] = []
}

/// What an account shares on one side of a change, as that side's Before or After line shows it.
struct AccessAccountSide: Equatable {
    /// The pill: "Not granted" when the capability is off, "Not shared" when the account is not selected,
    /// "All content", "Share matching content", "Hide matching content", or "Saved filter" for a filter this
    /// editor cannot express.
    var status: AccessAccountStatus
    /// "83 shared · 37 hidden", for a side holding a filter whose counts are known.
    var counts: String?
    /// The items of this side's filter, listed unmarked directly under its line. Empty when the side holds no filter,
    /// and when both sides hold a filter the editor can express, whose items are listed once after both lines.
    var items: [ScopeRef]
    /// The gateway's sentences for records this side's filter keeps hidden whatever it says, shown under its line as
    /// the filter editor's result shows them.
    var undecided: [String] = []
}

/// One account whose share changed. A filter's items are shown under the side that holds them: when only one side
/// holds a filter, or either side's filter is one this editor cannot express, each holding side lists its own items;
/// when both sides hold an editable filter, one list after both lines marks what the change adds and removes.
struct AccessAccountChange: Equatable {
    var before: AccessAccountSide
    var after: AccessAccountSide
    /// Every item of both editable filters, once: what the change adds, then what it removes, then what it keeps.
    var merged: [ScopeRefDelta]
}

/// What one account shares under a capability on one side of a change.
struct AccessAccountDecision: Equatable {
    var capabilityEnabled: Bool
    var allowed: Bool
    /// The account's filter with its items in a fixed order, so that listing them differently is not a change.
    var policy: ScopePolicy?

    init(_ decisions: AccessDraftDecisions, capability: String, sourceId: String) {
        capabilityEnabled = decisions.holds(capability)
        allowed = decisions.isAllowed(sourceId, capability: capability)
        policy = decisions.policy(sourceId, capability: capability).map(canonicalAccessPolicy)
    }
}

/// The review of an edited access level: which decisions changed, which did not, and how each changed account's
/// share reads before and after.
struct AccessLevelChangeReview {
    let original: AccessLevelDraft
    let draft: AccessLevelDraft
    let overview: AccessOverview
    /// Counts of the saved and drafted filters, keyed by canonical policy.
    var totals: [ScopePolicy: AccessFilterTotals] = [:]

    var before: AccessDraftDecisions {
        AccessDraftDecisions(draft: original, overview: overview, original: original)
    }

    var after: AccessDraftDecisions {
        AccessDraftDecisions(draft: draft, overview: overview, original: original)
    }

    /// The titles of the decisions the draft changes, in the order the review lists them.
    var changedTitles: [String] {
        var titles: [String] = []
        if draft.name.trimmingCharacters(in: .whitespacesAndNewlines) != original.name.trimmingCharacters(in: .whitespacesAndNewlines) {
            titles.append(AccessDecisionTitle.name)
        }
        if before.capabilityHoldings != after.capabilityHoldings { titles.append(AccessDecisionTitle.permissions) }
        if !changedAccounts("answer").isEmpty { titles.append(AccessDecisionTitle.answerData) }
        // A Direct that follows Answer before and after reads as "Same sources and filters as Answer" on both sides;
        // what changed is Answer's data.
        if !(before.directFollowsAnswer && after.directFollowsAnswer), !changedAccounts("direct").isEmpty {
            titles.append(AccessDecisionTitle.directData)
        }
        if newSourcesChanged { titles.append(AccessDecisionTitle.newSources) }
        if before.releaseSummary != after.releaseSummary { titles.append(AccessDecisionTitle.release) }
        return titles
    }

    /// Whether a capability that reads sources is granted or withdrawn, or changes what happens to a source connected
    /// later. Direct following Answer or keeping its own list words the decision differently without changing it.
    private var newSourcesChanged: Bool {
        ["answer", "direct"].contains { capability in
            before.holds(capability) != after.holds(capability)
                || before.allowsNewSources(capability) != after.allowsNewSources(capability)
        }
    }

    /// The decisions the level held before and still holds unchanged, as they read now. A decision the level gains
    /// with a newly granted capability is never listed as unchanged.
    var unchangedLines: [AccessDecisionLine] {
        let changed = changedTitles
        let held = Set(before.decisionLines.map(\.title)).union([AccessDecisionTitle.name])
        return ([AccessDecisionLine(title: AccessDecisionTitle.name, value: draft.name)] + after.decisionLines)
            .filter { !changed.contains($0.title) && held.contains($0.title) }
    }

    /// The accounts whose share under a capability differs: the connected ones first, then any either side still
    /// names that is no longer connected. An account neither side shares is not a change, even when the capability
    /// itself is switched on or off.
    func changedAccounts(_ capability: String) -> [AccessSourceInstance] {
        let known = Set(overview.sources.map(\.id))
        let listed = overview.sources + (before.sources(capability) + after.sources(capability)).filter { !known.contains($0.id) }
        var seen: Set<String> = []
        return listed.filter { seen.insert($0.id).inserted }.filter { source in
            let old = AccessAccountDecision(before, capability: capability, sourceId: source.id)
            let new = AccessAccountDecision(after, capability: capability, sourceId: source.id)
            return (old.allowed || new.allowed) && old != new
        }
    }

    func accountChange(_ capability: String, sourceId: String) -> AccessAccountChange {
        let saved = side(before, capability, sourceId)
        let drafted = side(after, capability, sourceId)
        var change = AccessAccountChange(before: saved.side, after: drafted.side, merged: [])
        if let old = saved.filter, let new = drafted.filter, old.editable, new.editable {
            change.before.items = []
            change.after.items = []
            change.merged = scopeRefDeltas(before: old, after: new)
        }
        return change
    }

    /// One side's line, and the filter that side holds: only a shared account under a granted capability holds one.
    private func side(_ decisions: AccessDraftDecisions, _ capability: String, _ sourceId: String)
        -> (side: AccessAccountSide, filter: ScopePolicy?) {
        guard decisions.holds(capability) else {
            return (.init(status: .init(kind: .notShared, text: accessNotGrantedText), counts: nil, items: []), nil)
        }
        let allowed = decisions.isAllowed(sourceId, capability: capability)
        guard allowed, let policy = decisions.policy(sourceId, capability: capability) else {
            return (.init(status: AccessAccountStatus(allowed: allowed, policy: nil), counts: nil, items: []), nil)
        }
        let total = totals[canonicalAccessPolicy(policy)]
        let counts = total.map { "\($0.shared.formatted()) shared · \($0.hidden.formatted()) hidden" }
        let side = AccessAccountSide(
            status: accessFilterModeStatus(policy),
            counts: counts,
            items: policy.rules.flatMap(\.match),
            undecided: total?.undecided ?? []
        )
        return (side, policy)
    }
}
