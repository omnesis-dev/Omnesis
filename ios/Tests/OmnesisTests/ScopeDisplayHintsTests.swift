// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessScopeDisplayHintsTests: XCTestCase {
    private func tree(_ field: String, _ noun: FilterNoun) -> FilterEditorField {
        FilterEditorField(field: field, capability: "tree", noun: noun, levels: [noun], picker: "tree")
    }

    func testReturningFromGmailLabelAndDriveFolderPickerKeepsNamesOutsideWirePolicy() throws {
        for (sourceId, field, noun, id, name) in [
            ("gmail:mail@example.org", "extra.labelIds", FilterNoun(one: "label", many: "labels"), "Label_design", "Design"),
            ("google-drive:files@example.org", "extra.folderIds", FilterNoun(one: "folder", many: "folders"), "projects", "Projects"),
        ] {
            let ref = ScopeRef.tree(field: field, id: id)
            let options = ScopeOptions(sourceId: sourceId, field: field, items: [.init(ref: ref, label: name, count: 8, depth: 0)])
            var session = ScopePickerSession(field: field, sourceId: sourceId)
            session.catalogues[session.location(for: sourceId)] = options
            let hints = scopeCatalogueLabelHints(session, sourceId: sourceId, fields: [tree(field, noun)])
            var policy = ScopePolicy.empty(sourceId: sourceId, levelId: "example-level", capability: "answer")
            policy.rules[0].match = [ref]
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            let before = try encoder.encode(policy)
            let hint = scopeLabelHint(for: ref, in: hints)
            XCTAssertEqual(scopeDisplayLabel(ref, hint: hint), name)
            XCTAssertEqual(accessScopeKindName(ref, hint: hint), noun.one.capitalized)
            XCTAssertEqual(try encoder.encode(policy), before, "Manage/review display must not alter persisted references")
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(ref)) as? [String: Any])
            XCTAssertEqual(Set(object.keys), ["capability", "field", "id"])
        }
    }

    func testMissingRefRetainsKnownNameAndFlagButNeverUsesRawIdAsPrimaryName() {
        let ref = ScopeRef.tree(field: "extra.folderIds", id: "opaque-folder")
        let known = ScopeItemHint(ref: ref, label: "Projects", count: 8, noun: "folder")
        let missing = ScopeItemHint(ref: ref, label: "opaque-folder", count: 0, missing: true)
        let retained = mergingScopeLabelHints([known], [missing])
        XCTAssertEqual(scopeDisplayLabel(ref, hint: scopeLabelHint(for: ref, in: retained)), "Projects")
        XCTAssertEqual(retained.first?.missing, true)
        XCTAssertEqual(retained.first?.count, 0)
        XCTAssertEqual(retained.first?.noun, "folder")
        XCTAssertEqual(scopeDisplayLabel(ref, hint: missing), "Saved item selection")
        XCTAssertTrue(scopeNameUnavailable(ref, hint: missing))
        let catalogue = ScopeItemHint(ref: ref, label: "Project plans", count: 9)
        XCTAssertEqual(
            mergingScopeLabelHints(retained, [catalogue], preserveMissing: true).first?.missing,
            true,
            "A retained catalogue name is not fresh availability validation"
        )
        XCTAssertEqual(scopeDisplayLabel(ref, hint: mergingScopeLabelHints(retained, [catalogue]).first), "Project plans")
    }

    func testCatalogueHintsCannotCrossSourceAccountsEvenWhenIdsMatch() {
        let ref = ScopeRef.tree(field: "extra.folderIds", id: "shared-looking-id")
        let current = "google-drive:files@example.org", another = "google-drive:another@example.org"
        var session = ScopePickerSession(field: "extra.folderIds", sourceId: current)
        let wrong = ScopeOptions(
            sourceId: another,
            field: "extra.folderIds",
            items: [.init(ref: ref, label: "Another account folder", count: 8)]
        )
        session.catalogues[session.location(for: current)] = wrong
        XCTAssertTrue(scopeCatalogueLabelHints(session, sourceId: current, fields: []).isEmpty)
        session.catalogues[session.location(for: another)] = wrong
        XCTAssertTrue(scopeCatalogueLabelHints(session, sourceId: current, fields: []).isEmpty)
    }

    func testPreviewNamesCarryTheWordOfEachEntrysField() {
        let chat = ScopeRef.membership(field: "extra.chatJid", id: "chat-workshop-planning")
        let person = ScopeRef.person(label: "Maya Reeves", identifiers: [.init(type: "phone", value: "+15550100142")])
        let preview = ScopePreview(sourceId: "whatsapp-messages:+15550100123", total: 120, visible: 83, hidden: 37, items: [
            .init(ref: chat, label: "Workshop planning", count: 24),
            .init(ref: person, label: "Maya Reeves", count: 17),
            .init(ref: .membership(field: "extra.chatJid", id: "chat-gone"), label: "chat-gone", count: 0, missing: true),
        ])
        let fields = [
            FilterEditorField(field: "extra.chatJid", capability: "membership", noun: .init(one: "chat", many: "chats"), picker: "search"),
        ]
        let hints = scopeItemHints(preview, fields: fields)
        XCTAssertEqual(hints.map(\.noun), ["chat", "person", "chat"])
        XCTAssertEqual(hints.map(\.missing), [false, false, true])
        XCTAssertEqual(hints.map(\.count), [24, 17, 0])
    }

    /// A missing entry says one thing, the same on every Omnesis app: that the account's list no longer holds it,
    /// or that its name is unavailable.
    func testAMissingEntrysNoteFollowsTheGatewaysReason() {
        let ref = ScopeRef.membership(field: "extra.labelIds", id: "Label_40")
        let named = ScopeItemHint(ref: ref, label: "Finance", count: 4, noun: "label")
        XCTAssertNil(scopeItemNote(ref, hint: named))
        let gone = ScopeItemHint(ref: ref, label: "Finance", noun: "label", missing: true, reason: "not-in-list")
        XCTAssertEqual(scopeItemNote(ref, hint: gone), "No longer in this account")
        XCTAssertEqual(scopeDisplayLabel(ref, hint: gone), "Finance")
        let noList = ScopeItemHint(ref: ref, label: "Label_40", noun: "label", missing: true, reason: "list-gone")
        XCTAssertEqual(scopeItemNote(ref, hint: noList), "Name unavailable")
        XCTAssertEqual(scopeDisplayLabel(ref, hint: noList), "Saved label selection")
        let noReason = ScopeItemHint(ref: ref, label: "Label_40", missing: true)
        XCTAssertEqual(scopeItemNote(ref, hint: noReason), "Name unavailable")
        XCTAssertEqual(scopeItemNote(ref, hint: nil), "Name unavailable", "An id nothing has named yet")
        let retained = mergingScopeLabelHints([gone], [ScopeItemHint(ref: ref, label: "Finance", count: 9)], preserveMissing: true)
        XCTAssertEqual(retained.first?.reason, "not-in-list")
    }

    func testAGoneAccountsPreviewNamesItsEntriesWithoutCounts() {
        let chat = ScopeRef.membership(field: "extra.chatJid", id: "chat-workshop-planning")
        let preview = ScopePreview(
            sourceId: "whatsapp-messages:+15550100123",
            total: 0,
            visible: 0,
            hidden: 0,
            connected: false,
            items: [.init(ref: chat, label: "Workshop planning", count: 0)]
        )
        XCTAssertEqual(scopeItemHints(preview, fields: []).map(\.label), ["Workshop planning"])
        XCTAssertEqual(scopeItemHints(preview, fields: []).map(\.count), [nil])
    }
}
