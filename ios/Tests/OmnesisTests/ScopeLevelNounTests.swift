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

    private func gmail(_ labels: FilterFieldState, _ people: FilterFieldState, resync: FilterAccountResync?) -> SourceFilterEditor {
        var person = self.people
        person.state = people
        let label = FilterEditorField(
            field: "extra.labelIds", capability: "tree", noun: .init(one: "label", many: "labels"), picker: "tree", state: labels
        )
        return SourceFilterEditor(sourceId: "gmail:reader@example.org", sourceType: "gmail", fields: [person, label], resync: resync)
    }

    func testFieldsCoveredByTheAccountsResyncShowItsOneSentenceAndNoTabs() {
        let rest = " filters need Gmail to be resynced. Your mail stays searchable meanwhile."
        let combined = "Label and people" + rest
        let editor = gmail(
            .needsResync(cost: nil, text: "Label" + rest),
            .needsResync(cost: nil, text: "People" + rest),
            resync: .init(state: "needs-resync", fields: [FilterEditorField.peopleField, "extra.labelIds"], text: combined)
        )
        XCTAssertEqual(
            editor.fields.map(editor.shownState),
            [.needsResync(cost: nil, text: combined), .needsResync(cost: nil, text: combined)]
        )
        XCTAssertTrue(editor.resyncCoversEveryField)
        XCTAssertFalse(editor.settling)

        let progress = FilterAccountResync(
            state: "resyncing", fields: ["extra.labelIds"], text: "Resyncing Gmail: 212 of about 900.", processed: 212, total: 900
        )
        let running = gmail(.resyncing(processed: 212, total: 900, text: "Resyncing Gmail: 212 of about 900."), .ready, resync: progress)
        XCTAssertEqual(
            running.shownState(running.fields[1]),
            .resyncing(processed: 212, total: 900, text: "Resyncing Gmail: 212 of about 900.")
        )
        XCTAssertEqual(running.shownState(running.fields[0]), .ready, "A field the resync does not cover keeps its own state")
        XCTAssertFalse(running.resyncCoversEveryField)
        XCTAssertTrue(running.settling)
    }

    func testWithoutASharedResyncEachFieldShowsItsOwnState() {
        let labels = FilterFieldState.needsResync(cost: nil, text: "Label filters need Gmail to be resynced.")
        let editor = gmail(labels, .ready, resync: nil)
        XCTAssertEqual(editor.shownState(editor.fields[1]), labels)
        XCTAssertFalse(editor.resyncCoversEveryField)
        let future = gmail(labels, .ready, resync: .init(state: "a-later-state", fields: ["extra.labelIds"], text: "Later"))
        XCTAssertEqual(future.shownState(future.fields[1]), labels, "A shared state this app does not know falls back to the field's")
    }

    func testAnEmptyListSaysWhetherASearchFoundNothing() {
        XCTAssertEqual(scopePickerEmptyText("labels", searching: true), "No labels match this search.")
        XCTAssertEqual(scopePickerEmptyText("folders", searching: false), "No folders here.")
    }
}
