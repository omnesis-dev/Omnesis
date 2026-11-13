// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class ScopeLevelNounTests: XCTestCase {
    private let repositories = FilterEditorField(
        field: "extra.repositoryIds",
        capability: "tree",
        noun: .init(one: "repository", many: "repositories"),
        levels: [.init(one: "owner", many: "owners"), .init(one: "repository", many: "repositories")],
        inside: .init(one: "repository", many: "repositories"),
        insideText: "Includes the repositories inside.",
        picker: "tree"
    )
    private let chats = FilterEditorField(
        field: "extra.chatJid", capability: "membership", noun: .init(one: "chat", many: "chats"), picker: "search"
    )
    private let people = FilterEditorField(
        field: FilterEditorField.peopleField, capability: "person", noun: .init(one: "person", many: "people"), picker: "search"
    )

    func testATreeItemIsNamedByItsLevelAndTheLastLevelStandsForEveryDeeperOne() {
        let item = ScopeRef.tree(field: "extra.repositoryIds", id: "owner:1")
        XCTAssertEqual(scopeFieldNoun(item, fields: [repositories], depth: 0), "owner")
        XCTAssertEqual(scopeFieldNoun(item, fields: [repositories], depth: 1), "repository")
        XCTAssertEqual(scopeFieldNoun(item, fields: [repositories], depth: 6), "repository")
        XCTAssertEqual(scopeFieldNoun(item, fields: [repositories]), "repository")
        XCTAssertEqual(scopeFieldNoun(item, fields: [repositories], depth: -1), "repository")
    }

    func testEachEntryIsNamedByItsOwnField() {
        XCTAssertEqual(scopeFieldNoun(.membership(field: "extra.chatJid", id: "c"), fields: [repositories, chats, people]), "chat")
        let person = ScopeRef.person(label: "Maya Reeves", identifiers: [.init(type: "phone", value: "+15550100142")])
        XCTAssertEqual(scopeFieldNoun(person, fields: [chats, people]), "person")
        XCTAssertEqual(scopeFieldNoun(person, fields: []), "person")
        XCTAssertNil(scopeFieldNoun(.membership(field: "extra.unknown", id: "x"), fields: [chats]))
        XCTAssertEqual(scopeFieldNoun(.tree(field: "extra.projectFolder", id: "", device: "device-studio"), fields: []), "device")
    }

    func testTabsAreTheFieldsWordForSeveralItems() {
        XCTAssertEqual([repositories, chats, people].map(scopeFieldTabTitle), ["Repositories", "Chats", "People"])
        let folders = FilterEditorField(
            field: "extra.projectFolder", capability: "tree", noun: .init(one: "project folder", many: "project folders"), picker: "tree"
        )
        XCTAssertEqual(scopeFieldTabTitle(folders), "Project folders")
    }

    func testRowsInsideATreeUseTheLastPartOfTheirNameAndSearchResultsTheWholeName() {
        let repository = ScopeOption(
            ref: .tree(field: "extra.repositoryIds", id: "repo:5201"),
            label: "northstar-labs/atlas-api",
            shortLabel: "atlas-api",
            count: 19
        )
        XCTAssertEqual(scopePickerRowTitle(repository, inTree: true, searching: false), "atlas-api")
        XCTAssertEqual(scopePickerRowTitle(repository, inTree: true, searching: true), "northstar-labs/atlas-api")
        XCTAssertEqual(scopePickerRowTitle(repository, inTree: false, searching: false), "northstar-labs/atlas-api")
    }

    func testARememberedNameKeepsTheWordALaterHintDoesNotCarry() {
        let item = ScopeRef.tree(field: "extra.repositoryIds", id: "repo:5201")
        let listed = ScopeItemHint(ref: item, label: "northstar-labs/atlas-api", count: 19, noun: "repository")
        let counted = ScopeItemHint(ref: item, label: "northstar-labs/atlas-api", count: 21)
        let merged = mergingScopeLabelHints([listed], [counted])
        XCTAssertEqual(merged.map(\.noun), ["repository"])
        XCTAssertEqual(merged.map(\.count), [21])
    }

    private func gmail(_ labels: FilterFieldState, _ people: FilterFieldState) -> [FilterEditorField] {
        var person = self.people
        person.state = people
        let label = FilterEditorField(
            field: "extra.labelIds", capability: "tree", noun: .init(one: "label", many: "labels"), picker: "tree", state: labels
        )
        return [person, label]
    }

    func testFieldsWaitingForTheSameResyncShowOneStateNamingThemTogether() {
        let cost = "This reads about 75,000 messages a day."
        let rest = " filters need Gmail to be resynced. Your mail stays searchable meanwhile. " + cost
        let fields = gmail(.needsResync(cost: cost, text: "Label" + rest), .needsResync(cost: cost, text: "People" + rest))
        let shared = FilterFieldState.needsResync(cost: cost, text: "Label and people" + rest)
        XCTAssertEqual(scopeFieldShownState(fields[0], in: fields), shared)
        XCTAssertEqual(scopeFieldShownState(fields[1], in: fields), shared)
        XCTAssertTrue(scopeAccountWaitsForResync(fields))

        let progress = FilterFieldState.resyncing(processed: 212, total: 900, text: "Resyncing Gmail: 212 of about 900.")
        let resyncing = gmail(progress, progress)
        XCTAssertEqual(scopeFieldShownState(resyncing[1], in: resyncing), progress)
        XCTAssertTrue(scopeAccountWaitsForResync(resyncing))
    }

    func testFieldsInDifferentStatesEachShowTheirOwn() {
        let labels = FilterFieldState.needsResync(cost: nil, text: "Label filters need Gmail to be resynced.")
        let fields = gmail(labels, .ready)
        XCTAssertEqual(scopeFieldShownState(fields[1], in: fields), labels)
        XCTAssertFalse(scopeAccountWaitsForResync(fields))
        XCTAssertFalse(scopeAccountWaitsForResync([fields[1]]), "One field alone keeps its own screen")
        let odd = gmail(labels, .needsResync(cost: nil, text: "Resync Gmail to filter on people."))
        XCTAssertEqual(scopeFieldShownState(odd[1], in: odd), labels, "A sentence that cannot be joined is shown as the gateway wrote it")
    }

    func testAnEmptyListSaysWhetherASearchFoundNothing() {
        XCTAssertEqual(scopePickerEmptyText("labels", searching: true), "No labels match this search.")
        XCTAssertEqual(scopePickerEmptyText("folders", searching: false), "No folders here.")
    }
}
