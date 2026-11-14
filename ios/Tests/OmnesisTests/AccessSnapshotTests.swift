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

    /// A typed number the gateway refuses, with its sentence under the field.
    func testAccessFilterPickerRefusesATypedAddress() {
        snapshot(
            SourceFilterPickerView(
                source: PreviewMocks.accessWhatsApp,
                editor: PreviewMocks.accessWhatsAppEditor,
                typedInput: "+44 (0)7700 900123",
                typedProblem: "Enter a valid phone number. Include the international country code."
            ) { _ in }
                .background(Theme.bgPrimary)
                .environment(AppStore.preview(sourceIconByType: PreviewMocks.accessGalleryIcons)),
            name: "access-filter-typed-address-refused",
            size: CGSize(width: 393, height: 852),
            ignoresSafeArea: true,
            standardRange: true
        )
    }

    /// The filter of the trees beyond plain folders, at their choices and at their review: a coding agent's sessions
    /// by project folder on two devices, and repositories under their owners. The device level shows the devices;
    /// inside a tree each row is named by the last part of its name.
    func testAccessGalleryTrees() {
        let sessions = PreviewMocks.accessSessions
        let studio = PreviewMocks.accessSessionDevices[0]
        let work = PreviewMocks.accessHomeFolders[0]
        accessTreeGallery("filter-picker-devices") {
            PreviewMocks.accessTreeFilter(
                sessions, editor: PreviewMocks.accessSessionsEditor, sharing: nil, openAlong: [], listing: PreviewMocks.accessSessionDevices
            )
        }
        accessTreeGallery("filter-picker-project-folders") {
            PreviewMocks.accessTreeFilter(
                sessions,
                editor: PreviewMocks.accessSessionsEditor,
                sharing: work,
                total: 58,
                openAlong: [studio, PreviewMocks.accessHomeFolder],
                listing: PreviewMocks.accessHomeFolders
            )
        }
        accessTreeGallery("filter-review-project-folders") {
            PreviewMocks.accessTreeFilter(sessions, editor: PreviewMocks.accessSessionsEditor, sharing: work, total: 58)
        }
        accessTreeGallery("filter-collector-behind") {
            PreviewMocks.accessTreeFilter(sessions, editor: PreviewMocks.accessSessionsBehindEditor, sharing: nil, openAlong: [])
        }
        let repositories = PreviewMocks.accessRepositories
        let owner = PreviewMocks.accessOwner
        accessTreeGallery("filter-picker-repositories") {
            PreviewMocks.accessTreeFilter(
                repositories,
                editor: PreviewMocks.accessRepositoriesEditor,
                sharing: owner,
                total: 42,
                openAlong: [owner],
                listing: PreviewMocks.accessOwnerRepositories
            )
        }
        accessTreeGallery("filter-review-repositories") {
            PreviewMocks.accessTreeFilter(repositories, editor: PreviewMocks.accessRepositoriesEditor, sharing: owner, total: 42)
        }
    }

    /// A WhatsApp day's inspector, with what a filter can see on it and the way to who can read it, and that page.
    func testAccessGalleryDocument() {
        let doc = PreviewMocks.accessDocumentDetail
        accessTreeGallery("document-details", icons: PreviewMocks.accessGalleryIcons, sources: [PreviewMocks.accessDocumentSource]) {
            DocumentInspectorSheet(
                doc: doc, people: [], refs: nil, attachments: [], previewFilterDetails: PreviewMocks.accessDocumentFilterDetails
            )
        }
        accessTreeGallery("document-access", height: 1080, icons: PreviewMocks.accessGalleryIcons) {
            DocumentAccessView(documentId: doc.id, previewAudit: PreviewMocks.accessDocumentAudit)
        }
        accessTreeGallery("document-access-loading", height: 600, icons: PreviewMocks.accessGalleryIcons) {
            DocumentAccessView(documentId: doc.id)
        }
    }

    private func accessTreeGallery(
        _ slug: String,
        height: CGFloat = 852,
        icons: [String: String] = PreviewMocks.accessTreeIcons,
        sources: [SourceRecord] = [],
        @ViewBuilder _ content: () -> some View
    ) {
        snapshot(
            content().environment(AppStore.preview(sources: sources, sourceIconByType: icons)),
            name: "gallery-\(slug)",
            size: CGSize(width: 393, height: height),
            ignoresSafeArea: true,
            standardRange: true
        )
    }
}
