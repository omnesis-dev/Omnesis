// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The review of an edited access level: a filter's items are shown under the side that holds them, marked only
/// when both sides hold a filter, and each side's line says what that side shares.
final class AccessLevelChangeReviewTests: XCTestCase {
    private let mail = AccessSourceInstance(id: "scope-mail:reader@example.org", name: "Mail · reader@example.org")
    private let files = AccessSourceInstance(id: "scope-files:reader@example.org", name: "Files · reader@example.org")
    private let chat = AccessSourceInstance(id: "scope-chat:+15550100123", name: "Chat · +1 (555) 010-0123")
    private let projects = ScopeRef.tree(field: "extra.folderIds", id: "projects")
    private let workshop = ScopeRef.membership(field: "extra.chatJid", id: "conversation-workshop")
    private let maya = ScopeRef.person(label: "Maya Reeves", identifiers: [.init(type: "phone", value: "+15550100141")])
    private let jamie = ScopeRef.person(label: "Jamie Lopez", identifiers: [.init(type: "phone", value: "+15550100142")])

    private var overview: AccessOverview {
        var overview = AccessOverview(principals: [], sources: [mail, files, chat], policyFamilies: [family], levels: [])
        overview.sourceFilters = .init(enabled: true)
        return overview
    }

    private let family = AccessPolicyFamilySummary(id: "policy-everyday", name: "Everyday privacy", revision: "policy-version-1")

    private func filter(_ source: AccessSourceInstance, _ refs: [ScopeRef], share: Bool, capability: String = "answer") -> ScopePolicy {
        ScopePolicy(
            sourceId: source.id,
            audience: .init(accessLevel: "level-example", capability: capability),
            rules: [.init(match: refs, action: share ? "share" : "hide")],
            otherwise: share ? "hide" : "share"
        )
    }

    private func accounts(_ sources: [AccessSourceInstance]) -> AccessSourceBoundary {
        .init(mode: .allowlist, sourceIds: sources.map(\.id))
    }

    private var filesFilter: ScopePolicy {
        filter(files, [projects], share: true)
    }

    private var chatFilter: ScopePolicy {
        filter(chat, [workshop, maya], share: false)
    }

    /// Direct reading what Answer reads, as a saved level records it: the same accounts and the same filters.
    private var linkedDirect: AccessGrantRule {
        .direct(
            sources: accounts([mail, files, chat]),
            scopePolicies: [
                filter(files, [projects], share: true, capability: "direct"),
                filter(chat, [workshop, maya], share: false, capability: "direct"),
            ]
        )
    }

    /// Answer reads all three accounts, with the files account narrowed to one folder and the chat account hiding a
    /// conversation and a person.
    private var answer: AccessGrantRule {
        .answer(
            sources: accounts([mail, files, chat]),
            release: .reviewed(policyFamilyId: family.id),
            filterRevision: 3,
            scopePolicies: [filesFilter, chatFilter]
        )
    }

    private func reviewing(
        _ rules: [AccessGrantRule],
        totals: [ScopePolicy: AccessFilterTotals] = [:],
        change: (inout AccessLevelDraft) -> Void
    )
        -> AccessLevelChangeReview {
        let level = AccessLevelSummary(
            id: "level-example", name: "Research assistant", revision: 4, rules: rules, connectionCount: 0, createdAt: 1, updatedAt: 2
        )
        let original = AccessLevelDraft(level: level, overview: overview)
        var draft = original
        change(&draft)
        return AccessLevelChangeReview(original: original, draft: draft, overview: overview, totals: totals)
    }

    private func side(_ text: String, counts: String? = nil, items: [ScopeRef] = []) -> AccessAccountSide {
        let kind: AccessAccountStatus.Kind = switch text {
        case "Share matching content": .only
        case "Hide matching content": .except
        case "All content", "Saved filter": .all
        default: .notShared
        }
        return AccessAccountSide(status: .init(kind: kind, text: text), counts: counts, items: items)
    }

    private func totals(_ pairs: (ScopePolicy, AccessFilterTotals)...) -> [ScopePolicy: AccessFilterTotals] {
        Dictionary(uniqueKeysWithValues: pairs.map { (canonicalAccessPolicy($0.0), $0.1) })
    }

    private func counted(_ policy: ScopePolicy, _ shared: Int, _ hidden: Int) -> (ScopePolicy, AccessFilterTotals) {
        (policy, AccessFilterTotals(shared: shared, hidden: hidden))
    }

    func testDirectSwitchedOffListsEachFilterUnderBeforeAndLeavesNotGrantedAlone() {
        let directTotals = totals(
            counted(filter(files, [projects], share: true, capability: "direct"), 18, 102),
            counted(filter(chat, [workshop, maya], share: false, capability: "direct"), 5547, 406)
        )
        let review = reviewing([answer, linkedDirect], totals: directTotals) { $0.setEnabled("direct", false, overview: overview) }

        XCTAssertEqual(review.changedTitles, ["Permissions", "Direct data", "New sources"])
        XCTAssertEqual(review.changedAccounts("direct").map(\.id), [mail.id, files.id, chat.id])
        XCTAssertEqual(review.accountChange("direct", sourceId: mail.id), .init(
            before: side("All content"), after: side("Not granted"), merged: []
        ))
        XCTAssertEqual(review.accountChange("direct", sourceId: files.id), .init(
            before: side("Share matching content", counts: "18 shared · 102 hidden", items: [projects]),
            after: side("Not granted"),
            merged: []
        ))
        XCTAssertEqual(review.accountChange("direct", sourceId: chat.id), .init(
            before: side("Hide matching content", counts: "\(5547.formatted()) shared · 406 hidden", items: [workshop, maya]),
            after: side("Not granted"),
            merged: []
        ))
        XCTAssertEqual(review.unchangedLines.map(\.title), ["Name", "Answer data", "Answer release"])
    }

    func testAnAccountReadableOnNeitherSideIsNotAChange() {
        let off = reviewing([answer, .direct(sources: accounts([mail]))]) { $0.setEnabled("direct", false, overview: overview) }
        XCTAssertEqual(off.changedAccounts("direct").map(\.id), [mail.id], "Not shared to Not granted is left out")

        let on = reviewing([.notes]) { draft in
            draft.setEnabled("direct", true, overview: overview)
            draft.setBoundary(accounts([files]), capability: "direct", authoringEnabled: true)
        }
        XCTAssertEqual(on.changedAccounts("direct").map(\.id), [files.id], "Not granted to Not shared is left out")
        let change = on.accountChange("direct", sourceId: files.id)
        XCTAssertEqual(change, .init(before: side("Not granted"), after: side("All content"), merged: []))
    }

    func testDirectSwitchedOnListsItsFiltersUnderAfter() {
        let review = reviewing([answer]) { $0.setEnabled("direct", true, overview: overview) }
        XCTAssertEqual(review.changedTitles, ["Permissions", "Direct data", "New sources"])
        XCTAssertEqual(review.accountChange("direct", sourceId: files.id), .init(
            before: side("Not granted"),
            after: side("Share matching content", items: [projects]),
            merged: []
        ))
        XCTAssertEqual(review.accountChange("direct", sourceId: chat.id).after.items, [workshop, maya])
        XCTAssertEqual(review.unchangedLines.map(\.title), ["Name", "Answer data", "Answer release"])
    }

    func testAFilterAddedToAnAccountSharingEverythingIsListedUnderAfter() {
        let added = filter(mail, [jamie], share: false)
        let review = reviewing([answer], totals: totals(counted(added, 40, 9))) {
            $0.setPolicy(added, sourceId: mail.id, capability: "answer")
        }
        XCTAssertEqual(review.changedTitles, ["Answer data"])
        XCTAssertEqual(review.accountChange("answer", sourceId: mail.id), .init(
            before: side("All content"),
            after: side("Hide matching content", counts: "40 shared · 9 hidden", items: [jamie]),
            merged: []
        ))
    }

    func testASidesCountsCarryTheGatewaysSentencesForRecordsItKeepsHidden() {
        let added = filter(mail, [jamie], share: false)
        let tooOld = "3 older items could not be resynced and stay hidden from agents using this filter."
        let review = reviewing([answer], totals: totals((added, AccessFilterTotals(shared: 40, hidden: 9, undecided: [tooOld])))) {
            $0.setPolicy(added, sourceId: mail.id, capability: "answer")
        }
        let change = review.accountChange("answer", sourceId: mail.id)
        XCTAssertEqual(change.before.undecided, [])
        XCTAssertEqual(change.after.undecided, [tooOld])
        XCTAssertEqual(change.after.counts, "40 shared · 9 hidden")
    }

    func testAFilterRemovedIsListedUnderBeforeAndTheAccountSharesAllContentAfter() {
        let review = reviewing([answer], totals: totals(counted(filesFilter, 18, 102))) {
            $0.setPolicy(nil, sourceId: files.id, capability: "answer")
        }
        XCTAssertEqual(review.accountChange("answer", sourceId: files.id), .init(
            before: side("Share matching content", counts: "18 shared · 102 hidden", items: [projects]),
            after: side("All content"),
            merged: []
        ))
    }

    func testItemsAddedAndRemovedOnOneAccountAreMarkedInOneListAfterBothLines() {
        let changed = filter(chat, [maya, jamie], share: false)
        let review = reviewing([answer], totals: totals(counted(chatFilter, 83, 37), counted(changed, 98, 22))) {
            $0.setPolicy(changed, sourceId: chat.id, capability: "answer")
        }
        XCTAssertEqual(review.changedAccounts("answer").map(\.id), [chat.id])
        XCTAssertEqual(review.accountChange("answer", sourceId: chat.id), .init(
            before: side("Hide matching content", counts: "83 shared · 37 hidden"),
            after: side("Hide matching content", counts: "98 shared · 22 hidden"),
            merged: [.init(ref: jamie, change: .added), .init(ref: workshop, change: .removed), .init(ref: maya, change: .kept)]
        ))
    }

    func testSwitchingTheModeKeepsTheItemsUnmarkedAndEachSideReadsItsOwnModeAndCounts() {
        let shared = filter(chat, [workshop, maya], share: true)
        let review = reviewing([answer], totals: totals(counted(chatFilter, 83, 37), counted(shared, 37, 83))) {
            $0.setPolicy(shared, sourceId: chat.id, capability: "answer")
        }
        XCTAssertEqual(review.accountChange("answer", sourceId: chat.id), .init(
            before: side("Hide matching content", counts: "83 shared · 37 hidden"),
            after: side("Share matching content", counts: "37 shared · 83 hidden"),
            merged: [.init(ref: workshop, change: .kept), .init(ref: maya, change: .kept)]
        ))
    }

    func testSwitchingTheModeAndTheItemsTogetherMarksTheItems() {
        let shared = filter(chat, [maya, jamie], share: true)
        let review = reviewing([answer]) { $0.setPolicy(shared, sourceId: chat.id, capability: "answer") }
        let change = review.accountChange("answer", sourceId: chat.id)
        XCTAssertEqual(change.before.status.text, "Hide matching content")
        XCTAssertEqual(change.after.status.text, "Share matching content")
        XCTAssertNil(change.after.counts, "A side whose counts are not known yet shows none")
        XCTAssertEqual(change.merged.map(\.change), [.added, .removed, .kept])
    }

    func testAnUnselectedAccountListsItsFilterUnderBeforeAndANewlySelectedOneUnderAfter() {
        let rules: [AccessGrantRule] = [.answer(
            sources: accounts([mail, chat]),
            release: .reviewed(policyFamilyId: family.id),
            scopePolicies: [chatFilter]
        )]
        let review = reviewing(rules) { draft in
            draft.setBoundary(accounts([mail, files]), capability: "answer", authoringEnabled: true)
            draft.setPolicy(filesFilter, sourceId: files.id, capability: "answer")
        }
        XCTAssertEqual(review.changedAccounts("answer").map(\.id), [files.id, chat.id])
        // The unselected account's filter stays in the draft but is neither saved nor shown under Not shared.
        XCTAssertEqual(review.draft.rule("answer")?.scopePolicies.map(\.sourceId), [chat.id, files.id])
        XCTAssertEqual(review.draft.serializedRules.first?.scopePolicies.map(\.sourceId), [files.id])
        XCTAssertNil(review.draft.sourceProblem("answer", overview: overview, original: review.original))
        XCTAssertEqual(review.accountChange("answer", sourceId: chat.id), .init(
            before: side("Hide matching content", items: [workshop, maya]),
            after: side("Not shared"),
            merged: []
        ))
        XCTAssertEqual(review.accountChange("answer", sourceId: files.id), .init(
            before: side("Not shared"),
            after: side("Share matching content", items: [projects]),
            merged: []
        ))
    }
}

/// Decisions changed together, linked Direct, saved filters this editor cannot express, and accounts no longer
/// connected.
extension AccessLevelChangeReviewTests {
    func testAnswerSwitchedOffWithDirectLinkedLeavesDirectsDataUnchanged() {
        let review = reviewing([answer, linkedDirect]) { $0.setEnabled("answer", false, overview: overview) }
        XCTAssertEqual(review.changedTitles, ["Permissions", "Answer data", "New sources", "Answer release"])
        XCTAssertEqual(review.accountChange("answer", sourceId: chat.id), .init(
            before: side("Hide matching content", items: [workshop, maya]),
            after: side("Not granted"),
            merged: []
        ))
        XCTAssertEqual(review.unchangedLines.map(\.title), ["Name", "Direct data"])
        XCTAssertEqual(review.unchangedLines.last?.value, "3 accounts selected · 2 filtered")
    }

    func testAnswerSwitchedOnBesideDirectsOwnListIsNeverListedAsUnchanged() {
        let review = reviewing([.direct(sources: accounts([mail]))]) { $0.setEnabled("answer", true, overview: overview) }
        XCTAssertEqual(review.changedTitles, ["Permissions", "New sources", "Answer release"])
        XCTAssertEqual(review.unchangedLines.map(\.title), ["Name", "Direct data"])
    }

    func testAnAnswerFilterChangeIsShownUnderAnswerWhileTheDirectFollowingItReadsAsUnchanged() {
        let narrowed = filter(chat, [maya], share: false)
        let review = reviewing([answer, linkedDirect]) { $0.setPolicy(narrowed, sourceId: chat.id, capability: "answer") }
        XCTAssertEqual(review.changedTitles, ["Answer data"])
        XCTAssertEqual(review.accountChange("answer", sourceId: chat.id).merged.map(\.change), [.removed, .kept])
        let direct = review.unchangedLines.first { $0.title == "Direct data" }
        XCTAssertEqual(direct?.value, "Same sources and filters as Answer")
    }

    func testDirectLeavingAnswersLinkWithItsOwnChangeIsListed() {
        let review = reviewing([answer, linkedDirect]) { draft in
            draft.setDirectSameAsAnswer(false)
            draft.setBoundary(accounts([mail, files]), capability: "direct", authoringEnabled: true)
        }
        XCTAssertEqual(review.changedTitles, ["Direct data"], "New sources reads differently but decides the same")
        XCTAssertEqual(review.changedAccounts("direct").map(\.id), [chat.id])
        XCTAssertEqual(review.accountChange("direct", sourceId: chat.id), .init(
            before: side("Hide matching content", items: [workshop, maya]),
            after: side("Not shared"),
            merged: []
        ))
    }

    func testSeveralChangedDecisionsKeepTheFlowsOrderAndNoneIsAlsoUnchanged() {
        let review = reviewing([answer, .direct(sources: accounts([mail]))]) { draft in
            draft.name = "Updated helper"
            draft.setEnabled("notes", true, overview: overview)
            draft.setPolicy(nil, sourceId: files.id, capability: "answer")
            if let rule = draft.rule("answer") { draft.setRule(rule.replacing(release: .unreviewed)) }
        }
        XCTAssertEqual(review.changedTitles, ["Name", "Permissions", "Answer data", "Answer release"])
        XCTAssertEqual(review.unchangedLines.map(\.title), ["Direct data", "New sources"])
    }

    func testAFilterThisEditorCannotExpressListsItsOwnItemsUnderEachSide() {
        var advanced = filter(chat, [workshop], share: false)
        advanced.rules.append(.init(match: [maya], action: "share"))
        let rules: [AccessGrantRule] = [.answer(
            sources: accounts([mail, files, chat]),
            release: .reviewed(policyFamilyId: family.id),
            scopePolicies: [advanced, filesFilter]
        )]
        let review = reviewing(rules) { $0.setPolicy(filter(chat, [jamie], share: false), sourceId: chat.id, capability: "answer") }
        XCTAssertEqual(review.changedAccounts("answer").map(\.id), [chat.id], "The other filters are not repeated")
        XCTAssertEqual(review.accountChange("answer", sourceId: chat.id), .init(
            before: side("Saved filter", items: [workshop, maya]),
            after: side("Hide matching content", items: [jamie]),
            merged: []
        ))
    }

    func testAnItemRemovedFromTheFilterOfAnAccountNoLongerConnectedIsMarked() {
        let gone = AccessSourceInstance(id: "scope-chat:+15550100199", name: "Chat")
        let saved = filter(gone, [workshop, maya], share: false)
        let rules: [AccessGrantRule] = [.answer(
            sources: .init(mode: .allowlist, sourceIds: [mail.id, gone.id]),
            release: .reviewed(policyFamilyId: family.id),
            scopePolicies: [saved]
        )]
        let review = reviewing(rules) { $0.setPolicy(filter(gone, [maya], share: false), sourceId: gone.id, capability: "answer") }
        XCTAssertEqual(review.changedAccounts("answer").map(\.id), [gone.id])
        XCTAssertEqual(
            review.accountChange("answer", sourceId: gone.id).merged,
            [.init(ref: workshop, change: .removed), .init(ref: maya, change: .kept)]
        )
    }

    func testLinkingOrUnlinkingDirectWithoutChangingWhatItReadsIsNotAChange() {
        let unlinked = reviewing([answer, linkedDirect]) { draft in
            draft.name = "Updated helper"
            draft.setDirectSameAsAnswer(false)
        }
        XCTAssertEqual(unlinked.changedTitles, ["Name"])
        let relinked = reviewing([answer, linkedDirect]) { draft in
            draft.name = "Updated helper"
            draft.setDirectSameAsAnswer(false)
            draft.setDirectSameAsAnswer(true)
        }
        XCTAssertEqual(relinked.changedTitles, ["Name"])
        let own = AccessGrantRule.direct(sources: accounts([mail]))
        let linked = reviewing([.answer(sources: accounts([mail]), release: .unreviewed), own]) { $0.name = "Updated helper" }
        XCTAssertEqual(linked.changedTitles, ["Name"])
        XCTAssertEqual(linked.unchangedLines.first { $0.title == "Direct data" }?.value, "Same sources and filters as Answer")
    }

    func testOnlyTheNameChangedLeavesEveryOtherDecisionUnchanged() {
        let review = reviewing([answer, .direct(sources: accounts([mail]))]) { $0.name = "Updated helper" }
        XCTAssertEqual(review.changedTitles, ["Name"])
        XCTAssertEqual(review.unchangedLines.map(\.title), ["Permissions", "Answer data", "Direct data", "New sources", "Answer release"])
    }
}
