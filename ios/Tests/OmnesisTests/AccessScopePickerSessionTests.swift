// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessScopePickerSessionTests: XCTestCase {
    func testPickerBookmarksAreBoundToAccountKindQueryAndFullFolderTrail() {
        let parent = ScopeOption(ref: .init(kind: "folder", id: "project-root"), label: "Projects", count: 20)
        var session = ScopePickerSession(
            kind: "folder",
            query: "plan",
            parentId: "project-root",
            ancestors: [parent],
            sourceId: "drive:team@example.org"
        )
        let key = session.location(for: "drive:team@example.org")
        let position = ScopePickerPosition(
            itemId: .item(.init(.init(kind: "folder", id: "visible-item"))),
            index: 24
        )
        session.positions[key] = position
        XCTAssertEqual(session.retained(for: "drive:team@example.org").positions[key], position)
        var differentSearch = session
        differentSearch.query = "invoice"
        XCTAssertNil(differentSearch.positions[differentSearch.location(for: "drive:team@example.org")])
        var differentKind = session
        differentKind.changeKind("participant", scopes: nil)
        XCTAssertNil(differentKind.positions[differentKind.location(for: "drive:team@example.org")])
        var differentTrail = session
        differentTrail.ancestors = []
        XCTAssertNil(differentTrail.positions[differentTrail.location(for: "drive:team@example.org")])
        let anotherAccount = session.retained(for: "drive:other@example.org")
        XCTAssertTrue(anotherAccount.positions.isEmpty)
        XCTAssertTrue(anotherAccount.catalogues.isEmpty)
        XCTAssertTrue(anotherAccount.query.isEmpty)
    }
}
