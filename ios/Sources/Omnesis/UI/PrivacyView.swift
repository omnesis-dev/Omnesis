// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// SwiftUI and URLSession use distinct cancellation errors. Neither is
/// evidence of a gateway failure, so a canceled retry preserves prior state.
func privacyRefreshFailure(previous: Error?, caught error: Error) -> Error? {
    if error is CancellationError {
        return previous
    }
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
        return previous
    }
    return error
}

func replacePrivacyReviewPage<Item>(
    items: inout [Item],
    totalCount: inout Int,
    pageItems: [Item],
    pageTotalCount: Int
) {
    items = pageItems
    totalCount = pageTotalCount
}

@discardableResult
func appendPrivacyReviewPage<Item>(
    items: inout [Item],
    totalCount: inout Int,
    pageItems: [Item],
    pageTotalCount: Int,
    id: (Item) -> some Hashable
)
    -> [Item] {
    let fresh = appendUnique(pageItems, to: &items, id: id)
    totalCount = pageTotalCount
    return fresh
}

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// What happened, and what is waiting on a decision: the exchange feed, the
/// held answers pinned on top of it, and the requests for a new watch.
///
/// Only events live here. The rules an event was judged against — who may ask,
/// over what, under which policy, and the policy documents themselves — are
/// settings, and are reached through Settings rather than from this feed.
///
/// A watch that is already running is not here either. A watch is a watch
/// however it was asked for, and it lives on the Watches tab with everything
/// else it does — including the record of what it may disclose and to whom.
/// The two halves of the Audit screen. Answer is the reviewed boundary —
/// what was asked and what left; Direct is the unreviewed transcript of raw
/// corpus reads.
@available(iOS 17.0, *)
enum AuditTab: String, CaseIterable, Identifiable {
    case answer
    case direct

    var id: String {
        rawValue
    }

    var label: String {
        switch self {
        case .answer: "Answer"
        case .direct: "Direct"
        }
    }
}

@available(iOS 17.0, *)
struct PrivacyView: View {
    @Environment(AppStore.self) private var store
    @Environment(NotificationRouter.self) private var router

    @State private var reviewerHealth: PrivacyReviewerHealth?
    @State private var reviewerHealthGeneration = 0
    @State private var refreshToken = 0
    @State private var path: [PrivacyRoute] = []
    @State private var auditTab = AuditTab.answer

    @Binding var menuOpen: Bool
    private let isPreview: Bool

    #if DEBUG
    private let previewExchanges: [PrivacyExchangePresentation]
    private let previewNextCursor: String?
    private let previewSubscriptionApprovals: [PrivacySubscriptionApprovalSummary]
    private let previewDirectSessions: [DirectAuditSessionSummary]
    #endif

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
        self.isPreview = false
        #if DEBUG
        self.previewExchanges = []
        self.previewNextCursor = nil
        self.previewSubscriptionApprovals = []
        self.previewDirectSessions = []
        #endif
    }

    #if DEBUG
    init(
        menuOpen: Binding<Bool>,
        previewExchanges: [PrivacyExchangePresentation] = [],
        previewNextCursor: String? = nil,
        previewSubscriptionApprovals: [PrivacySubscriptionApprovalSummary] = [],
        previewReviewerHealth: PrivacyReviewerHealth? = nil,
        previewTab: AuditTab = .answer,
        previewDirectSessions: [DirectAuditSessionSummary] = []
    ) {
        self._menuOpen = menuOpen
        self._reviewerHealth = State(initialValue: previewReviewerHealth)
        self._auditTab = State(initialValue: previewTab)
        self.isPreview = true
        self.previewExchanges = previewExchanges
        self.previewNextCursor = previewNextCursor
        self.previewSubscriptionApprovals = previewSubscriptionApprovals
        self.previewDirectSessions = previewDirectSessions
    }
    #endif

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                Picker("Audit view", selection: $auditTab) {
                    ForEach(AuditTab.allCases) { tab in
                        Text(tab.label).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.bottom, Theme.Spacing.sm)
                switch auditTab {
                case .answer:
                    healthBanner
                    activityPane
                case .direct:
                    directPane
                }
            }
            .navigationTitle("Audit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    MenuToolbarButton(isOpen: $menuOpen)
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationDestination(for: PrivacyRoute.self) { destination(for: $0) }
            .task {
                guard !isPreview else { return }
                await loadReviewerHealth()
                consumeRouterTarget(router.pendingTarget)
            }
            .onChange(of: router.pendingTarget) { _, target in
                consumeRouterTarget(target)
            }
            // The badge count moves when a decision is made or expires —
            // here, in a review the app opened on its own, or on another
            // device — and each of those is a feed that needs re-reading.
            .onChange(of: store.privacyPendingCount) { _, _ in refreshToken += 1 }
            .onAppear { consumeRouterTarget(router.pendingTarget) }
        }
    }

    @ViewBuilder
    private var healthBanner: some View {
        if reviewerHealth?.status == .attention {
            PrivacyBanner(
                text: "Some recent automatic privacy checks could not complete. Any affected "
                    + "answer stays inside Omnesis and requires your review."
            )
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.sm)
        }
    }

    @ViewBuilder
    private var activityPane: some View {
        #if DEBUG
        if isPreview {
            PrivacyActivityPane(
                previewExchanges: previewExchanges,
                previewNextCursor: previewNextCursor,
                previewSubscriptionApprovals: previewSubscriptionApprovals
            )
        } else {
            PrivacyActivityPane(refreshToken: refreshToken)
        }
        #else
        PrivacyActivityPane(refreshToken: refreshToken)
        #endif
    }

    @ViewBuilder
    private var directPane: some View {
        #if DEBUG
        if isPreview {
            DirectAuditPane(previewSessions: previewDirectSessions)
        } else {
            DirectAuditPane()
        }
        #else
        DirectAuditPane()
        #endif
    }

    private func destination(for route: PrivacyRoute) -> some View {
        PrivacyRouteDestination(route: route) { refreshToken += 1 }
    }

    private func loadReviewerHealth() async {
        reviewerHealthGeneration += 1
        let generation = reviewerHealthGeneration
        guard let client = store.privacy else { return }
        // Health is advisory; the feed remains usable when it fails.
        guard let loaded = try? await client.getReviewerHealth() else { return }
        guard generation == reviewerHealthGeneration else { return }
        reviewerHealth = loaded
    }

    private func consumeRouterTarget(_ target: PushTarget?) {
        guard case .privacyApproval(let approvalId) = target else { return }
        router.consume()
        auditTab = .answer
        path = [.approval(approvalId)]
    }
}

@available(iOS 17.0, *)
enum PrivacyRoute: Hashable {
    case exchange(conversationId: String, taskId: String)
    case approval(String)
    case subscriptionApproval(String)
    /// The text one review was judged against, opened from the exchange or
    /// the approval that names it. The name is the family's at review time,
    /// absent on a record that did not keep it.
    case policy(familyId: String, name: String?)
    /// One Direct transcript session, opened from the Direct session list.
    /// The summary rides along for the detail header; nil on a deep link the
    /// list did not produce.
    case directSession(String, DirectAuditSessionSummary?)
}

/// The screen a `PrivacyRoute` pushes, wherever the route is followed from —
/// the Privacy feed's stack or a review the app opened on its own. Every
/// destination reports back through `onChanged` when it decides or deletes
/// something, so the host can re-read whatever it shows.
@available(iOS 17.0, *)
struct PrivacyRouteDestination: View {
    let route: PrivacyRoute
    let onChanged: () -> Void

    var body: some View {
        switch route {
        case .exchange(let conversationId, let taskId):
            PrivacyExchangeDetailView(conversationId: conversationId, taskId: taskId, onChanged: onChanged)
        case .approval(let id):
            PrivacyApprovalRoute(approvalId: id) { _ in onChanged() }
        case .subscriptionApproval(let id):
            PrivacySubscriptionApprovalDetailView(approvalId: id, onResolved: onChanged)
        case .policy(let familyId, let name):
            PrivacyPolicyScreen(familyId: familyId, name: name)
        case .directSession(let id, let session):
            DirectTranscriptView(sessionId: id, session: session, onChanged: onChanged)
        }
    }
}

#if DEBUG
#Preview("Privacy — activity with a pending review") {
    PrivacyView(
        menuOpen: .constant(false),
        previewExchanges: PreviewMocks.privacyExchangeFeed,
        previewNextCursor: "activity-next",
        previewSubscriptionApprovals: [PreviewMocks.subscriptionApproval],
        previewReviewerHealth: PreviewMocks.privacyReviewerHealthAttention
    )
    .environment(AppStore.preview())
    .environment(NotificationRouter())
    .omnesisColorScheme()
}

#Preview("Privacy — activity empty") {
    PrivacyView(menuOpen: .constant(false), previewExchanges: [])
        .environment(AppStore.preview())
        .environment(NotificationRouter())
        .omnesisColorScheme()
}

#Preview("Audit — direct tab with sessions") {
    PrivacyView(
        menuOpen: .constant(false),
        previewTab: .direct,
        previewDirectSessions: PreviewMocks.directAuditSessions
    )
    .environment(AppStore.preview())
    .environment(NotificationRouter())
    .omnesisColorScheme()
}

#Preview("Audit — direct tab empty") {
    PrivacyView(menuOpen: .constant(false), previewTab: .direct, previewDirectSessions: [])
        .environment(AppStore.preview())
        .environment(NotificationRouter())
        .omnesisColorScheme()
}

#endif

#endif
