// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// A single approval opened by id. Kept so a link minted before the review card
/// moved onto the landing feed — a push notification, a bookmark — still lands
/// on the decision it names.
@available(iOS 17.0, *)
struct PrivacyApprovalRoute: View {
    @Environment(AppStore.self) private var store

    let approvalId: String
    let onResolved: (String) -> Void

    @State private var detail: PrivacyApprovalDetail?
    @State private var loading = true
    @State private var loadError: Error?
    @State private var actionError: String?
    @State private var busy: String?
    @State private var resolution: PrivacyResolutionCopy?
    @State private var gate = PrivacyApprovalRequestGate()

    private let isPreview: Bool

    init(approvalId: String, onResolved: @escaping (String) -> Void = { _ in }) {
        self.approvalId = approvalId
        self.onResolved = onResolved
        self.isPreview = false
    }

    #if DEBUG
    init(
        previewDetail: PrivacyApprovalDetail? = nil,
        previewLoading: Bool = false,
        previewLoadError: Error? = nil
    ) {
        self.approvalId = previewDetail?.id ?? "preview-approval"
        self.onResolved = { _ in }
        self._detail = State(initialValue: previewDetail)
        self._loading = State(initialValue: previewLoading)
        self._loadError = State(initialValue: previewLoadError)
        self.isPreview = true
    }
    #endif

    var body: some View {
        content
            .navigationTitle("Review")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .task {
                guard !isPreview else { return }
                await load()
            }
            .onDisappear { gate.invalidate() }
    }

    @ViewBuilder
    private var content: some View {
        if loading, detail == nil {
            ProgressView().tint(Theme.accent).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError, detail == nil {
            GatewayErrorView(
                context: "load the review",
                error: loadError,
                onRetry: { Task { await load() } }
            )
        } else if let detail {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    if let resolution {
                        PrivacyBanner(
                            text: "\(resolution.title) — \(resolution.message)",
                            tone: resolution.ok ? .ok : .warning
                        )
                    }
                    if detail.status == .pending, resolution == nil {
                        PrivacyReviewCard(
                            review: PrivacyPendingReview(detail: detail),
                            busy: busy,
                            error: actionError,
                            onApprove: { resolve(approve: true) },
                            onDeny: { resolve(approve: false) }
                        )
                    } else {
                        decidedNotice(detail)
                    }
                    if let policy = detail.review.reviewedPolicy {
                        PrivacyReviewedUnderRow(policy: policy)
                            .padding(Theme.Spacing.md)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Theme.bgSecondary)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
                    }
                }
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.top, Theme.Spacing.sm)
                .padding(.bottom, Theme.Spacing.xl)
            }
        }
    }

    private func decidedNotice(_ detail: PrivacyApprovalDetail) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("This review is already decided.")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            NavigationLink(
                value: PrivacyRoute.exchange(
                    conversationId: detail.conversationId,
                    taskId: detail.taskId
                )
            ) {
                Label("See what happened", systemImage: "arrow.right.circle")
                    .font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(Theme.accent)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    private func load() async {
        guard let generation = gate.beginLoad(resolutionInFlight: busy != nil) else { return }
        guard let client = store.privacy else {
            if gate.owns(generation) {
                loading = false
                loadError = URLError(.cannotConnectToHost)
            }
            return
        }
        loading = true
        defer {
            if gate.owns(generation) { loading = false }
        }
        do {
            let loaded = try await client.getApproval(id: approvalId)
            guard gate.owns(generation) else { return }
            detail = loaded
            loadError = nil
        } catch {
            if gate.owns(generation) { loadError = error }
        }
    }

    private func resolve(approve: Bool) {
        guard busy == nil, let client = store.privacy, let detail else { return }
        let generation = gate.beginResolution()
        busy = approve ? "approve" : "deny"
        actionError = nil
        Task {
            defer {
                if gate.owns(generation) { busy = nil }
            }
            do {
                let response = approve
                    ? try await client.approve(id: approvalId)
                    : try await client.deny(id: approvalId)
                onResolved(response.conversationId)
                guard gate.owns(generation) else { return }
                resolution = privacyResolutionCopy(
                    response,
                    agentName: externalAgentNarrativeName(detail.externalAgent)
                )
            } catch {
                if gate.owns(generation) {
                    actionError = GatewayErrorView.classify(error).title
                }
            }
        }
    }
}

#if DEBUG
#Preview("Privacy approval deep link") {
    NavigationStack {
        PrivacyApprovalRoute(previewDetail: PreviewMocks.privacyApprovalDetail)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

// A link minted while the review was pending, opened after it was decided.
#Preview("Privacy approval — already decided") {
    NavigationStack {
        PrivacyApprovalRoute(previewDetail: PreviewMocks.privacyDecidedApprovalDetail)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}
#endif

#endif
