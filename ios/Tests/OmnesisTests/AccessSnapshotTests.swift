// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import SwiftUI
import XCTest

extension PreviewSnapshotTests {
    /// The review of a changed filter on a wide phone, where each side's counts and its pill share one line.
    /// The gallery draws the same review at 393 points, where they do not fit and the pill sits under the counts.
    func testAccessReviewOfAChangedFilterOnAWidePhone() {
        let overview = PreviewMocks.accessCanonicalOverview
        snapshot(
            AccessLevelEditorView(
                level: overview.levels[0],
                overview: overview,
                previewStep: .review,
                previewChange: PreviewMocks.accessFilterChange,
                previewLabels: PreviewMocks.accessCanonicalLabels,
                previewTotals: PreviewMocks.accessCanonicalTotals
            )
            .environment(AppStore.preview(sourceIconByType: PreviewMocks.accessGalleryIcons)),
            name: "access-review-changed-filter-wide",
            size: CGSize(width: 440, height: 1100),
            ignoresSafeArea: true,
            standardRange: true
        )
    }

    /// A typed address that names no address of its type, with what to enter said under the field.
    func testAccessFilterPickerRefusesATypedAddress() {
        snapshot(
            SourceFilterPickerView(source: PreviewMocks.accessWhatsApp, typedInput: "maya@example.org") { _ in }
                .background(Theme.bgPrimary)
                .environment(AppStore.preview(sourceIconByType: PreviewMocks.accessGalleryIcons)),
            name: "access-filter-typed-address-refused",
            size: CGSize(width: 393, height: 852),
            ignoresSafeArea: true,
            standardRange: true
        )
    }

    /// A tree whose source names its levels, opened one level down: the trail starts at the source's word for
    /// its roots, and the open item is offered by its own level's noun.
    func testAccessFilterPickerNamesTheLevelsOfATree() {
        let scopes = SourceScopes(items: [
            .init(
                kind: "folder",
                noun: .init(one: "shelf or binder", many: "shelves and binders"),
                levels: [.init(one: "shelf", many: "shelves"), .init(one: "binder", many: "binders")],
                picker: "tree",
                link: "hierarchy"
            ),
        ])
        let readiness = [ScopeKindReadiness(kind: "folder", ready: true)]
        var source = AccessSourceInstance(id: "shelves:reader@example.org", name: "Shelves · reader@example.org")
        source.sourceType = "shelves"
        source.scopes = scopes
        source.scopeReadiness = readiness
        let shelf = ScopeOption(
            ref: .init(kind: "folder", id: "shelf-travel"), label: "Travel plans", count: 12, hasChildren: true, depth: 0
        )
        let binders = [("binder-spring", "Spring itinerary", 7), ("binder-rail", "Rail passes", 5)].map {
            ScopeOption(ref: .init(kind: "folder", id: $0.0), label: $0.1, count: $0.2, parentId: "shelf-travel", depth: 1)
        }
        var session = ScopePickerSession(kind: "folder", sourceId: source.id)
        session.ancestors = [shelf]
        session.parentId = shelf.ref.id
        session.catalogues[session.location(for: source.id)] = ScopeOptions(
            sourceId: source.id, sourceType: "shelves", scopes: scopes, readiness: readiness, items: binders
        )
        snapshot(
            SourceFilterPickerView(source: source, session: session) { _ in }
                .background(Theme.bgPrimary)
                .environment(AppStore.preview(sourceIconByType: PreviewMocks.accessGalleryIcons)),
            name: "access-filter-tree-levels",
            size: CGSize(width: 393, height: 852),
            ignoresSafeArea: true,
            standardRange: true
        )
    }

    /// The filter of two accounts whose trees are not plain folders, each at its choices and at its review:
    /// a coding agent's sessions by project folder, and repositories under their owners.
    func testAccessGalleryTrees() {
        let sessions = PreviewMocks.accessSessions
        let work = PreviewMocks.accessHomeFolders[0]
        accessTreeGallery("filter-picker-project-folders") {
            PreviewMocks.accessTreeFilter(
                sessions, sharing: work, total: 46, openOn: PreviewMocks.accessHomeFolder, listing: PreviewMocks.accessHomeFolders
            )
        }
        accessTreeGallery("filter-review-project-folders") { PreviewMocks.accessTreeFilter(sessions, sharing: work, total: 46) }
        let repositories = PreviewMocks.accessRepositories
        let owner = PreviewMocks.accessOwner
        accessTreeGallery("filter-picker-repositories") {
            PreviewMocks.accessTreeFilter(
                repositories, sharing: owner, total: 42, openOn: owner, listing: PreviewMocks.accessOwnerRepositories
            )
        }
        accessTreeGallery("filter-review-repositories") { PreviewMocks.accessTreeFilter(repositories, sharing: owner, total: 42) }
    }

    private func accessTreeGallery(_ slug: String, @ViewBuilder _ content: () -> some View) {
        snapshot(
            content().environment(AppStore.preview(sourceIconByType: PreviewMocks.accessTreeIcons)),
            name: "gallery-\(slug)",
            size: CGSize(width: 393, height: 852),
            ignoresSafeArea: true,
            standardRange: true
        )
    }
}
