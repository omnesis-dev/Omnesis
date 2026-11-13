// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class ScopeLevelNounTests: XCTestCase {
    private let shelves = SourceScopes(items: [
        .init(
            kind: "folder",
            noun: .init(one: "shelf or binder", many: "shelves and binders"),
            levels: [.init(one: "shelf", many: "shelves"), .init(one: "binder", many: "binders")],
            picker: "tree",
            link: "hierarchy"
        ),
        .init(kind: "label", noun: .init(one: "label", many: "labels"), picker: "search", link: "changes"),
    ])
    private let folders = SourceScopes(items: [
        .init(kind: "folder", noun: .init(one: "folder", many: "folders"), picker: "tree", link: "hierarchy"),
    ])
    private let item = ScopeRef(kind: "folder", id: "invented")

    func testATreeItemIsNamedByItsLevelAndTheLastLevelStandsForEveryDeeperOne() {
        XCTAssertEqual(accessScopeKindName(item, scopes: shelves, depth: 0), "Shelf")
        XCTAssertEqual(accessScopeKindName(item, scopes: shelves, depth: 1), "Binder")
        XCTAssertEqual(accessScopeKindName(item, scopes: shelves, depth: 6), "Binder")
        XCTAssertEqual(scopeSavedItemNoun(item, scopes: shelves, depth: 1), "binder")
    }

    func testAnItemOfUnknownDepthAndASourceWithOneNounKeepTheKindsOwnWord() {
        XCTAssertEqual(accessScopeKindName(item, scopes: shelves), "Shelf or binder")
        XCTAssertEqual(accessScopeKindName(item, scopes: shelves, depth: -1), "Shelf or binder")
        XCTAssertEqual(accessScopeKindName(.init(kind: "label", id: "l"), scopes: shelves, depth: 1), "Label")
        XCTAssertEqual(accessScopeKindName(item, scopes: folders, depth: 1), "Folder")
        XCTAssertEqual(accessScopeKindName(item, scopes: nil, depth: 1), "Folder")
    }

    func testTheNestingHintSpeaksTheSourcesWordsAndPromisesNothingBelowTheLastLevel() {
        XCTAssertEqual(scopeNestingHint(shelves.items[0], depth: 0), "Selecting shelves includes their binders.")
        XCTAssertNil(scopeNestingHint(shelves.items[0], depth: 1))
        XCTAssertNil(scopeNestingHint(shelves.items[0], depth: nil))
        XCTAssertEqual(scopeNestingHint(folders.items[0], depth: 3), "Includes the folders inside.")
    }

    func testLevelsAndDepthDecodeFromTheGatewayAndAreOptionalForAnOlderOne() throws {
        let options = try JSONDecoder().decode(ScopeOptions.self, from: Data("""
        {"sourceId":"invented:one","sourceType":"invented","readiness":[],
         "scopes":{"items":[{"kind":"folder","noun":{"one":"shelf or binder","many":"shelves and binders"},
           "levels":[{"one":"shelf","many":"shelves"},{"one":"binder","many":"binders"}],"picker":"tree","link":"hierarchy"}]},
         "items":[{"ref":{"kind":"folder","id":"a"},"label":"Invented shelf","count":2,"hasChildren":true,"depth":0},
                  {"ref":{"kind":"folder","id":"b"},"label":"Invented binder","count":1}]}
        """.utf8))
        XCTAssertEqual(options.scopes.items[0].levels?.map(\.one), ["shelf", "binder"])
        XCTAssertEqual(options.items.map(\.depth), [0, nil])
        let older = try JSONDecoder().decode(SourceScopes.self, from: Data("""
        {"items":[{"kind":"folder","noun":{"one":"folder","many":"folders"},"picker":"tree","link":"hierarchy"}]}
        """.utf8))
        XCTAssertNil(older.items[0].levels)
    }

    func testARememberedNameKeepsTheDepthALaterHintDoesNotCarry() {
        let listed = ScopePreview.Item(ref: item, label: "Invented binder", count: 1, depth: 1)
        let counted = ScopePreview.Item(ref: item, label: "Invented binder", count: 4)
        let merged = mergingScopeLabelHints([listed], [counted])
        XCTAssertEqual(merged.map(\.depth), [1])
        XCTAssertEqual(merged.map(\.count), [4])
    }
}
