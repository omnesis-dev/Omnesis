// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessScopePickerSessionTests: XCTestCase {
    func testPickerBookmarksAreBoundToAccountFieldQueryDeviceAndFullFolderTrail() {
        let parent = ScopeOption(ref: .tree(field: "extra.folderIds", id: "project-root"), label: "Projects", count: 20)
        var session = ScopePickerSession(
            field: "extra.folderIds",
            query: "plan",
            parentId: "project-root",
            ancestors: [parent],
            sourceId: "drive:team@example.org"
        )
        let key = session.location(for: "drive:team@example.org")
        let position = ScopePickerPosition(
            itemId: .item(.init(.tree(field: "extra.folderIds", id: "visible-item"))),
            index: 24
        )
        session.positions[key] = position
        XCTAssertEqual(session.retained(for: "drive:team@example.org").positions[key], position)
        var differentSearch = session
        differentSearch.query = "invoice"
        XCTAssertNil(differentSearch.positions[differentSearch.location(for: "drive:team@example.org")])
        var differentField = session
        differentField.changeField(FilterEditorField.peopleField, fields: [])
        XCTAssertNil(differentField.positions[differentField.location(for: "drive:team@example.org")])
        var differentDevice = session
        differentDevice.device = "device-travel-laptop"
        XCTAssertNil(differentDevice.positions[differentDevice.location(for: "drive:team@example.org")])
        var differentTrail = session
        differentTrail.ancestors = []
        XCTAssertNil(differentTrail.positions[differentTrail.location(for: "drive:team@example.org")])
        let anotherAccount = session.retained(for: "drive:other@example.org")
        XCTAssertTrue(anotherAccount.positions.isEmpty)
        XCTAssertTrue(anotherAccount.catalogues.isEmpty)
        XCTAssertTrue(anotherAccount.query.isEmpty)
    }

    func testOpeningADeviceBrowsesItsTreeAndGoingUpLeavesIt() {
        let field = "extra.projectFolder"
        let device = ScopeOption(
            ref: .tree(field: field, id: "", device: "device-studio-mac"),
            label: "Studio Mac",
            count: 46,
            hasChildren: true
        )
        let home = ScopeOption(
            ref: .tree(field: field, id: "~", device: "device-studio-mac"), label: "~", count: 46, hasChildren: true, depth: 0
        )
        var session = ScopePickerSession(field: field)
        session.open(device)
        XCTAssertEqual(session.device, "device-studio-mac")
        XCTAssertNil(session.parentId)
        session.open(home)
        XCTAssertEqual(session.device, "device-studio-mac")
        XCTAssertEqual(session.parentId, "~")
        session.openAncestor(depth: 1)
        XCTAssertEqual(session.ancestors, [device])
        XCTAssertEqual(session.device, "device-studio-mac")
        XCTAssertNil(session.parentId)
        session.openAncestor(depth: 0)
        XCTAssertTrue(session.ancestors.isEmpty)
        XCTAssertNil(session.device)
        XCTAssertNil(session.parentId)
    }
}
