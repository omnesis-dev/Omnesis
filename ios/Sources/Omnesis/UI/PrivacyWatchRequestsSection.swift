// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// A request for a new watch is a decision waiting on the operator, so it sits in
// Activity beside the held answers — the other thing waiting on a decision. It
// belongs under Privacy because approving one is the operator letting an
// external agent watch their data from then on.
//
// The watch that approval creates is not here. A watch is a watch however it was
// asked for, and it lives on the Watches tab along with everything else it does,
// the record of what it may disclose included.

/// The watch requests awaiting a decision. Nothing waiting is nothing to show:
/// the section is absent from the Activity feed unless a request is pending, a
/// load is in flight, or a load failed and owes the operator an explanation.
@available(iOS 17.0, *)
struct PrivacyWatchRequestsSection: View {
    @Environment(AppStore.self) private var store

    let refreshToken: Int

    @State private var approvals: [PrivacySubscriptionApprovalSummary] = []
    @State private var totalCount = 0
    @State private var paging = CursorPagingState()
    @State private var loading = true
    @State private var loadError: Error?
    @State private var loadGeneration = 0

    private let isPreview: Bool

    init(refreshToken: Int) {
        self.refreshToken = refreshToken
        self.isPreview = false
    }

    #if DEBUG
    init(
        previewApprovals: [PrivacySubscriptionApprovalSummary] = [],
        previewLoading: Bool = false,
        previewLoadError: Error? = nil
    ) {
        self.refreshToken = 0
        self._approvals = State(initialValue: previewApprovals)
        self._totalCount = State(initialValue: previewApprovals.count)
        self._loading = State(initialValue: previewLoading)
        self._loadError = State(initialValue: previewLoadError)
        self.isPreview = true
    }
    #endif

    var body: some View {
        // A real container, not a `Group`: SwiftUI distributes a `Group`'s
        // modifiers to its children, so a `.task` on a `Group` whose only child
        // is conditional never runs while that condition is false — and here
        // the condition is what the task is loading.
        VStack(alignment: .leading, spacing: 0) {
            if !approvals.isEmpty || loading || loadError != nil {
                section
            }
        }
        .task(id: refreshToken) {
            guard !isPreview else { return }
            await load()
        }
        .onDisappear { loadGeneration += 1 }
    }

    /// Absent while the list is unknown. A "0" beside a failed load asserts
    /// that nothing is waiting, which is exactly what the screen cannot say.
    private var countLabel: String? {
        guard !approvals.isEmpty || (loadError == nil && !loading) else { return nil }
        return totalCount.formatted()
    }

    private var section: some View {
        FlatSection("Watch requests", trailing: countLabel) {
            if loading, approvals.isEmpty {
                PrivacyLoadingRow(label: "Loading watch requests…")
            } else if let loadError, approvals.isEmpty {
                GatewayErrorView(
                    context: "load watch requests",
                    error: loadError,
                    onRetry: { Task { await load() } }
                )
                .frame(minHeight: GatewayErrorView.minScrollHeight)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(approvals.enumerated()), id: \.element.id) { index, approval in
                        NavigationLink(value: PrivacyRoute.subscriptionApproval(approval.id)) {
                            PrivacySubscriptionApprovalRow(approval: approval)
                        }
                        .buttonStyle(.plain)
                        if index < approvals.count - 1 {
                            Divider().background(Theme.borderLight)
                        }
                    }
                    ListPagingFooter(
                        state: paging,
                        label: "Load more watch requests",
                        retry: { Task { await loadMore() } }
                    )
                }
            }
        }
    }

    private func load() async {
        let request = paging.beginRefresh()
        loadGeneration += 1
        let generation = loadGeneration
        guard let client = store.privacy else {
            if generation == loadGeneration {
                loading = false
                loadError = URLError(.cannotConnectToHost)
                paging.failRefresh(request)
            }
            return
        }
        loading = true
        defer {
            if generation == loadGeneration { loading = false }
        }
        do {
            let page = try await client.listSubscriptionApprovals(status: "pending", limit: 50)
            guard generation == loadGeneration, paging.owns(request) else { return }
            replacePrivacyReviewPage(
                items: &approvals,
                totalCount: &totalCount,
                pageItems: page.approvals,
                pageTotalCount: page.totalCount
            )
            loadError = nil
            paging.finishRefresh(request, nextCursor: page.nextCursor)
        } catch GatewayClient.Error.notFound {
            // The gateway predates the routes entirely, which is a missing
            // capability rather than a failure to report. Nothing is waiting on
            // the operator, so the section simply stays away.
            guard generation == loadGeneration else { return }
            approvals = []
            totalCount = 0
            loadError = nil
            paging.finishRefresh(request, nextCursor: nil)
        } catch {
            // A failed refresh leaves the last known count standing rather than
            // clearing a badge for decisions that are still waiting.
            if generation == loadGeneration {
                loadError = privacyRefreshFailure(previous: loadError, caught: error)
                paging.failRefresh(request)
            }
        }
    }

    private func loadMore() async {
        guard let client = store.privacy,
              let request = paging.beginLoadMore() else { return }
        do {
            let page = try await client.listSubscriptionApprovals(
                status: "pending",
                limit: 50,
                cursor: request.cursor
            )
            guard paging.owns(request) else { return }
            let fresh = appendPrivacyReviewPage(
                items: &approvals,
                totalCount: &totalCount,
                pageItems: page.approvals,
                pageTotalCount: page.totalCount,
                id: \.id
            )
            paging.finishLoadMore(
                request,
                nextCursor: page.nextCursor,
                madeProgress: !fresh.isEmpty
            )
        } catch {
            paging.failLoadMore(request, error: error)
        }
    }
}

#if DEBUG
/// The section is written to sit inside Privacy's scrolling Activity pane, so
/// the previews give it the same surround rather than rendering it bare.
@available(iOS 17.0, *)
private struct PrivacyWatchSectionHarness<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        NavigationStack {
            ScrollView {
                content
                    .padding(.horizontal, Theme.Spacing.lg)
                    .padding(.vertical, Theme.Spacing.md)
            }
            .background(Theme.bgPrimary)
        }
        .environment(AppStore.preview())
        .omnesisColorScheme()
    }
}

#Preview("Watch requests — pending") {
    PrivacyWatchSectionHarness {
        PrivacyWatchRequestsSection(previewApprovals: [PreviewMocks.subscriptionApproval])
    }
}

#Preview("Watch requests — loading") {
    PrivacyWatchSectionHarness {
        PrivacyWatchRequestsSection(previewLoading: true)
    }
}

#Preview("Watch requests — error") {
    PrivacyWatchSectionHarness {
        PrivacyWatchRequestsSection(previewLoadError: URLError(.cannotConnectToHost))
    }
}

#endif

#endif
