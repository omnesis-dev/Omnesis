// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AccessScopeDisplayHintsTests: XCTestCase {
    func testReturningFromGmailLabelAndDriveFolderPickerKeepsNamesOutsideWirePolicy() throws {
        for (sourceId, kind, id, name) in [
            ("gmail:mail@example.org", "label", "Label_design", "Design"),
            ("google-drive:files@example.org", "folder", "projects", "Projects"),
        ] {
            let ref = ScopeRef(kind: kind, id: id)
            let source = kind == "folder"
                ? SourceScopes(
                    revision: 3,
                    items: [.init(kind: "folder", noun: .init(one: "folder", many: "folders"), picker: "tree", link: "hierarchy")]
                )
                : SourceScopes(revision: 2, items: [
                    .init(kind: "participant", identifiers: ["email", "domain"], link: "fixed"),
                    .init(kind: "label", noun: .init(one: "label", many: "labels"), picker: "search", link: "changes"),
                ])
            let options = ScopeOptions(
                sourceId: sourceId,
                sourceType: kind == "folder" ? "google-drive" : "gmail",
                scopes: source,
                readiness: source.items.map { .init(kind: $0.kind, ready: true) },
                items: [.init(ref: ref, label: name, count: 8)]
            )
            var session = ScopePickerSession(kind: kind, sourceId: sourceId)
            session.catalogues[session.location(for: sourceId)] = options
            let hints = scopeCatalogueLabelHints(session, sourceId: sourceId)
            var policy = ScopePolicy.empty(sourceId: sourceId, levelId: "example-level", capability: "answer")
            policy.rules[0].match = [ref]
            let encoder = JSONEncoder()
            encoder.outputFormatting = .sortedKeys
            let before = try encoder.encode(policy)
            XCTAssertEqual(scopeDisplayLabel(ref, previewItem: scopeLabelHint(for: ref, in: hints)), name)
            XCTAssertEqual(try encoder.encode(policy), before, "Manage/review display must not alter persisted references")
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(ref)) as? [String: Any])
            XCTAssertEqual(Set(object.keys), ["kind", "id"])
            let unvalidated = ScopeFilterCommitState(
                mode: .except,
                policy: policy,
                sourceId: sourceId,
                authoringEnabled: true,
                preview: nil,
                previewedPolicy: nil,
                loading: false,
                hasError: true
            )
            XCTAssertEqual(unvalidated.decision, .blocked, "Catalogue names and counts must never authorize Apply")
            let preview = ScopePreview(
                sourceId: sourceId,
                total: 100,
                visible: 90,
                hidden: 10,
                unknown: 0,
                items: hints,
                samples: [],
                readiness: source.items.map { .init(kind: $0.kind, ready: true) }
            )
            let validated = ScopeFilterCommitState(
                mode: .except,
                policy: policy,
                sourceId: sourceId,
                authoringEnabled: true,
                preview: preview,
                previewedPolicy: policy,
                loading: false,
                hasError: false
            )
            XCTAssertEqual(validated.decision, .apply(policy))
            var changed = policy
            changed.rules[0].match = [.init(kind: kind, id: id + "-different")]
            var stale = validated
            stale.policy = changed
            XCTAssertEqual(stale.decision, .blocked, "A same-count hint or another selection does not validate the changed policy")
        }
    }

    func testMissingRefRetainsKnownNameAndFlagButNeverUsesRawIdAsPrimaryName() {
        let ref = ScopeRef(kind: "folder", id: "opaque-folder")
        let known = ScopePreview.Item(ref: ref, label: "Projects", count: 8)
        let missing = ScopePreview.Item(ref: ref, label: "opaque-folder", count: 0, missing: true)
        let retained = mergingScopeLabelHints([known], [missing])
        XCTAssertEqual(scopeDisplayLabel(ref, previewItem: scopeLabelHint(for: ref, in: retained)), "Projects (unavailable)")
        XCTAssertEqual(retained.first?.missing, true)
        XCTAssertEqual(retained.first?.count, 0)
        XCTAssertEqual(scopeDisplayLabel(ref, previewItem: missing), "Saved folder selection")
        XCTAssertTrue(scopeNameUnavailable(ref, previewItem: missing))
        let catalogue = ScopePreview.Item(ref: ref, label: "Project plans", count: 9)
        XCTAssertEqual(
            mergingScopeLabelHints(retained, [catalogue], preserveMissing: true).first?.missing,
            true,
            "A retained catalogue name is not fresh availability validation"
        )
        let refreshed = ScopePreview.Item(ref: ref, label: "Project plans", count: 9)
        XCTAssertEqual(scopeDisplayLabel(ref, previewItem: mergingScopeLabelHints(retained, [refreshed]).first), "Project plans")
    }

    func testCatalogueHintsCannotCrossSourceAccountsEvenWhenIdsMatch() {
        let ref = ScopeRef(kind: "folder", id: "shared-looking-id")
        let current = "google-drive:files@example.org", another = "google-drive:another@example.org"
        var session = ScopePickerSession(kind: "folder", sourceId: current)
        let wrong = ScopeOptions(
            sourceId: another,
            sourceType: "google-drive",
            scopes: .init(items: []),
            readiness: [],
            items: [.init(ref: ref, label: "Another account folder", count: 8)]
        )
        session.catalogues[session.location(for: current)] = wrong
        XCTAssertTrue(scopeCatalogueLabelHints(session, sourceId: current).isEmpty)
        session.catalogues[session.location(for: another)] = wrong
        XCTAssertTrue(scopeCatalogueLabelHints(session, sourceId: current).isEmpty)
    }
}
