// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// One waiting privacy decision, presented over whatever the owner was doing.
///
/// The Privacy screen reaches the same review by pushing it onto its own
/// navigation stack; this is the modal form, used when the app opens a
/// decision the owner did not navigate to. It carries its own stack so the
/// "See what happened" link on an already-decided review still has somewhere
/// to go, and its own Close button because a sheet reached this way has no
/// back destination.
@available(iOS 17.0, *)
struct PrivacyApprovalSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let approvalId: String

    @State private var path: [PrivacyRoute] = []

    #if DEBUG
    private let preview: PrivacyApprovalRoute?
    #endif

    init(approvalId: String) {
        self.approvalId = approvalId
        #if DEBUG
        self.preview = nil
        #endif
    }

    #if DEBUG
    init(
        previewDetail: PrivacyApprovalDetail? = nil,
        previewLoading: Bool = false,
        previewLoadError: Error? = nil
    ) {
        self.approvalId = previewDetail?.id ?? "preview-approval"
        self.preview = PrivacyApprovalRoute(
            previewDetail: previewDetail,
            previewLoading: previewLoading,
            previewLoadError: previewLoadError
        )
    }
    #endif

    var body: some View {
        NavigationStack(path: $path) {
            review
                .navigationDestination(for: PrivacyRoute.self) { route in
                    destination(for: route)
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
        }
    }

    @ViewBuilder
    private var review: some View {
        #if DEBUG
        if let preview {
            preview
        } else {
            liveReview
        }
        #else
        liveReview
        #endif
    }

    private var liveReview: some View {
        PrivacyApprovalRoute(approvalId: approvalId) { _ in changed() }
    }

    private func destination(for route: PrivacyRoute) -> some View {
        PrivacyRouteDestination(route: route, onChanged: changed)
    }

    /// A decision here — at the root, or one level deeper — changes how many
    /// decisions are left. The badge is where that number lives, and the
    /// Privacy feed underneath re-reads itself when the badge moves.
    private func changed() {
        Task { await store.refreshPrivacyPendingCount() }
    }
}

#if DEBUG
#Preview("Privacy approval sheet — a decision that opened itself") {
    PrivacyApprovalSheet(previewDetail: PreviewMocks.privacyApprovalDetail)
        .environment(AppStore.preview())
        .omnesisColorScheme()
}

#Preview("Privacy approval sheet — already decided") {
    PrivacyApprovalSheet(previewDetail: PreviewMocks.privacyDecidedApprovalDetail)
        .environment(AppStore.preview())
        .omnesisColorScheme()
}

#Preview("Privacy approval sheet — loading") {
    PrivacyApprovalSheet(previewLoading: true)
        .environment(AppStore.preview())
        .omnesisColorScheme()
}

#Preview("Privacy approval sheet — error") {
    PrivacyApprovalSheet(previewLoadError: URLError(.cannotConnectToHost))
        .environment(AppStore.preview())
        .omnesisColorScheme()
}
#endif

#endif
