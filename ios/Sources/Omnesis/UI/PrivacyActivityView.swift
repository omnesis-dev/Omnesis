// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// The Privacy landing: what is waiting on you, then what left this machine.
//
// Anything pending is pinned at the top as a full review card — the exact held
// answer, the reason Omnesis paused, and both decisions inline — because a
// pending item *is* an exchange, and putting it behind a separate tab is what
// hides it. Below it the feed is grouped by local day, newest first, one row
// per exchange.

/// How many pending exchanges get a full review card. Pending items are few by
/// construction — they expire — but the cap keeps one runaway integration from
/// turning the landing into an unreadable stack; the rest stay visible as feed
/// rows carrying the "Needs your review" chip.
private let maxPinnedPrivacyReviews = 5

// MARK: - The review card

/// One held answer, decided in place. Never navigates: a decision this
/// consequential should not be one tap away behind a disclosure.
@available(iOS 17.0, *)
struct PrivacyReviewCard: View {
    let review: PrivacyPendingReview
    var busy: String?
    var error: String?
    let onApprove: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            header
            PrivacyQuote(text: review.question, role: "question", size: 16)
            heldAnswer
            reason
            if let error {
                PrivacyBanner(text: error, tone: .error)
            }
            actions
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary)
        .overlay {
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(PrivacyTone.review.foreground.opacity(0.45), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            PrivacyActorLine(kind: .external, label: "\(review.agentName) asked")
            Spacer(minLength: Theme.Spacing.sm)
            Text(privacyRelativeDate(review.createdAt))
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
    }

    private var heldAnswer: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text("Answer held inside Omnesis")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
            if review.candidateAvailable, let answer = review.candidateAnswer {
                PrivacyAnswerBlock(answer: answer, role: "held answer", tinted: true)
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    Text("The exact answer is unavailable.")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text("It cannot be shared from here. You can still choose not to share it.")
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(Theme.Spacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.warning.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.small))
            }
        }
    }

    private var reason: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(review.pause.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            // The pause reads either as Omnesis explaining itself or as the
            // reviewer's own sentence, and only the second is a quotation.
            if review.pause.quotesTheReviewer {
                PrivacyQuote(text: review.pause.message, role: "privacy check summary", size: 13)
            } else {
                Text(review.pause.message)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            PrivacyFindingChips(findings: review.findings, limit: 3)
        }
    }

    private var actions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Spacing.sm) {
                shareButton
                denyButton
            }
            VStack(spacing: Theme.Spacing.sm) {
                shareButton
                denyButton
            }
        }
    }

    private var shareButton: some View {
        Button(action: onApprove) {
            Text(shareLabel)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(Theme.accent)
        .disabled(busy != nil || !review.candidateAvailable)
    }

    private var shareLabel: String {
        if busy == "approve" { return "Approving…" }
        return "Share once"
    }

    private var denyButton: some View {
        Button(role: .destructive, action: onDeny) {
            Text(busy == "deny" ? "Not sharing…" : "Don’t share")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .disabled(busy != nil)
    }
}

// MARK: - The feed

/// A compact feed outcome. Routine outcomes spend colour on a small mark and
/// leave the stronger chip treatment for a review, failure, or unknown state.
@available(iOS 17.0, *)
struct PrivacyFeedOutcomeStatus: View {
    let exchange: PrivacyExchangePresentation

    var body: some View {
        let display = privacyFeedOutcomeDisplay(exchange)
        if privacyFeedOutcomeIsQuiet(exchange.outcome) {
            HStack(spacing: 7) {
                mark(display.tone)
                Text(display.label)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .accessibilityElement(children: .combine)
        } else {
            PrivacyChip(text: display.label, tone: display.tone)
        }
    }

    @ViewBuilder
    private func mark(_ tone: PrivacyTone) -> some View {
        if tone == .waiting {
            Circle()
                .stroke(tone.foreground, lineWidth: 1.5)
                .frame(width: 6, height: 6)
        } else {
            Circle()
                .fill(tone.foreground)
                .frame(width: 6, height: 6)
        }
    }
}

@available(iOS 17.0, *)
private struct PrivacyFeedFilterBar: View {
    @Binding var selection: PrivacyFeedFilter
    let exchanges: [PrivacyExchangePresentation]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.xs) {
                ForEach(PrivacyFeedFilter.allCases) { filter in
                    Button {
                        selection = filter
                    } label: {
                        Text("\(filter.label) \(count(for: filter))")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(
                                selection == filter ? Theme.bgPrimary : Theme.textSecondary
                            )
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(
                                selection == filter ? Theme.textPrimary : Theme.bgSecondary,
                                in: Capsule()
                            )
                            .overlay {
                                if selection != filter {
                                    Capsule().stroke(Theme.borderLight, lineWidth: 1)
                                }
                            }
                            .frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(filter.label)
                    .accessibilityValue(
                        "\(count(for: filter)) loaded, "
                            + (selection == filter ? "selected" : "not selected")
                    )
                }
            }
        }
    }

    private func count(for filter: PrivacyFeedFilter) -> Int {
        exchanges.filter { privacyFeedFilterMatches(filter, exchange: $0) }.count
    }
}

/// One exchange, one row. The question is the row's identity; the outcome and
/// the time say what became of it.
@available(iOS 17.0, *)
struct PrivacyFeedRow: View {
    let exchange: PrivacyExchangePresentation

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.sm) {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("\(externalAgentNarrativeName(exchange.externalAgent)) asked")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text("“\(exchange.question)”")
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                PrivacyFeedOutcomeStatus(exchange: exchange)
            }
            Spacer(minLength: 0)
            Text(time)
                .font(.system(size: 11))
                .monospacedDigit()
                .foregroundStyle(Theme.textMuted)
                .lineLimit(1)
                .accessibilityLabel(privacyAbsoluteDate(exchange.presentationTimestamp))
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textMuted)
                .padding(.top, 7)
                .accessibilityHidden(true)
        }
        .padding(.vertical, Theme.Spacing.sm)
        .contentShape(Rectangle())
    }

    private var time: String {
        guard exchange.presentationTimestamp > 0 else { return "Unknown" }
        return Date(timeIntervalSince1970: Double(exchange.presentationTimestamp) / 1000)
            .formatted(date: .omitted, time: .shortened)
    }
}

// MARK: - The pane

/// Everything the Activity landing needs from the gateway, and the decisions it
/// can take without leaving the screen.
@available(iOS 17.0, *)
struct PrivacyActivityPane: View {
    @Environment(AppStore.self) private var store

    let refreshToken: Int

    @State private var exchanges: [PrivacyExchangePresentation] = []
    @State private var paging = CursorPagingState()
    @State private var loading = true
    @State private var loadError: Error?
    @State private var loadGeneration = 0
    @State private var busy: String?
    @State private var actionErrors: [String: String] = [:]
    @State private var resolution: PrivacyResolutionCopy?
    @State private var filter = PrivacyFeedFilter.all
    /// Bumped by pull-to-refresh. The watch-request section loads itself, so
    /// the gesture has to reach it too or it refreshes only half the screen.
    @State private var pullRefreshCount = 0

    private let isPreview: Bool

    #if DEBUG
    private let previewSubscriptionApprovals: [PrivacySubscriptionApprovalSummary]
    #endif

    init(refreshToken: Int) {
        self.refreshToken = refreshToken
        self.isPreview = false
        #if DEBUG
        self.previewSubscriptionApprovals = []
        #endif
    }

    #if DEBUG
    init(
        previewExchanges: [PrivacyExchangePresentation],
        previewNextCursor: String? = nil,
        previewSubscriptionApprovals: [PrivacySubscriptionApprovalSummary] = [],
        previewLoading: Bool = false,
        previewLoadError: Error? = nil,
        previewResolution: PrivacyResolutionCopy? = nil,
        previewFilter: PrivacyFeedFilter = .all
    ) {
        self.refreshToken = 0
        self._exchanges = State(initialValue: previewExchanges)
        self._paging = State(initialValue: CursorPagingState(nextCursor: previewNextCursor))
        self._loading = State(initialValue: previewLoading)
        self._loadError = State(initialValue: previewLoadError)
        self._resolution = State(initialValue: previewResolution)
        self._filter = State(initialValue: previewFilter)
        self.isPreview = true
        self.previewSubscriptionApprovals = previewSubscriptionApprovals
    }
    #endif

    /// What the self-loading watch-request section watches. Both inputs only
    /// ever increase, so their sum changes exactly when either does.
    private var sectionRefreshToken: Int {
        refreshToken + pullRefreshCount
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Theme.Spacing.md) {
                if let resolution {
                    PrivacyBanner(
                        text: "\(resolution.title) — \(resolution.message)",
                        tone: resolution.ok ? .ok : .warning
                    )
                }
                content
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.bottom, Theme.Spacing.xl)
        }
        .refreshable {
            pullRefreshCount += 1
            await load()
        }
        .task(id: refreshToken) {
            guard !isPreview else { return }
            await load()
        }
        .onDisappear { loadGeneration += 1 }
    }

    @ViewBuilder
    private var content: some View {
        if loading, exchanges.isEmpty {
            PrivacyLoadingRow(label: "Loading activity…")
        } else if let loadError, exchanges.isEmpty {
            GatewayErrorView(
                context: "load privacy activity",
                error: loadError,
                onRetry: { Task { await load() } }
            )
            .frame(minHeight: GatewayErrorView.minScrollHeight)
        } else {
            if loadError != nil {
                PrivacyBanner(text: "Could not refresh privacy activity.")
            }
            pinnedReviews
            watchRequests
            feedSection
        }
    }

    /// A watch request is the other thing waiting on a decision, so it sits with
    /// the held answers rather than in the feed of what already happened. The
    /// watches it grants live under Watches.
    @ViewBuilder
    private var watchRequests: some View {
        #if DEBUG
        if isPreview {
            PrivacyWatchRequestsSection(previewApprovals: previewSubscriptionApprovals)
        } else {
            PrivacyWatchRequestsSection(refreshToken: sectionRefreshToken)
        }
        #else
        PrivacyWatchRequestsSection(refreshToken: sectionRefreshToken)
        #endif
    }

    // MARK: Pinned

    private var pending: [PrivacyPendingReview] {
        exchanges
            .filter(privacyExchangeIsPendingReview)
            .prefix(maxPinnedPrivacyReviews)
            .compactMap { exchange in
                PrivacyPendingReview(exchange: exchange)
            }
    }

    @ViewBuilder
    private var pinnedReviews: some View {
        let items = pending
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                Text(
                    items.count == 1
                        ? "One answer is waiting for you"
                        : "\(items.count) answers are waiting for you"
                )
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .padding(.top, Theme.Spacing.sm)
                ForEach(items, id: \.approvalId) { item in
                    PrivacyReviewCard(
                        review: item,
                        busy: busyAction(for: item.approvalId),
                        error: actionErrors[item.approvalId],
                        onApprove: { resolve(item, approve: true) },
                        onDeny: { resolve(item, approve: false) }
                    )
                }
            }
        }
    }

    private func busyAction(for approvalId: String) -> String? {
        guard let busy, busy.hasPrefix("\(approvalId):") else { return nil }
        return String(busy.dropFirst(approvalId.count + 1))
    }

    // MARK: Feed

    private var listedFeed: [PrivacyExchangePresentation] {
        let pinned = Set(pending.map(\.taskId))
        return exchanges.filter { !pinned.contains($0.taskId) }
    }

    private var filteredFeed: [PrivacyExchangePresentation] {
        listedFeed.filter { privacyFeedFilterMatches(filter, exchange: $0) }
    }

    /// Every exchange, newest first, grouped by the local day it happened on.
    @ViewBuilder
    private var feedSection: some View {
        let listed = listedFeed
        let rows = filteredFeed
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Recent activity")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .accessibilityAddTraits(.isHeader)
            PrivacyFeedFilterBar(selection: $filter, exchanges: listed)

            if rows.isEmpty,
               filter != .all || !shouldShowPagedContent(itemCount: rows.count, paging: paging) {
                PrivacyEmptyState(
                    symbol: "shield.lefthalf.filled",
                    title: filter == .all
                        ? "Nothing has left this machine"
                        : "No matching activity",
                    detail: filter == .all
                        ? "Every question an external agent asks Omnesis appears here, "
                        + "with what was shared."
                        : "Nothing in the activity loaded so far has this status. "
                        + "Load older activity to look further back."
                )
            } else {
                ForEach(privacyFeedDays(rows)) { day in
                    VStack(alignment: .leading, spacing: 0) {
                        Text(day.heading.localizedUppercase)
                            .font(.system(size: 11, weight: .semibold))
                            .tracking(0.9)
                            .foregroundStyle(Theme.textMuted)
                            .padding(.horizontal, Theme.Spacing.xs)
                            .padding(.top, Theme.Spacing.sm)
                            .padding(.bottom, 7)
                            .accessibilityAddTraits(.isHeader)
                        Divider().background(Theme.borderLight)
                        ForEach(day.exchanges) { exchange in
                            NavigationLink(
                                value: PrivacyRoute.exchange(
                                    conversationId: exchange.conversationId,
                                    taskId: exchange.taskId
                                )
                            ) {
                                PrivacyFeedRow(exchange: exchange)
                            }
                            .buttonStyle(.plain)
                            if exchange.id != day.exchanges.last?.id {
                                Divider().background(Theme.borderLight)
                            }
                        }
                    }
                }
            }

            if shouldShowPagedContent(itemCount: listed.count, paging: paging) {
                ListPagingFooter(
                    state: paging,
                    label: "Load older activity",
                    retry: { Task { await loadMore() } }
                )
            }
        }
    }

    // MARK: Loading

    private func load() async {
        guard !isPreview else { return }
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
            let page = try await client.listExchangeFeed(limit: 50)
            guard generation == loadGeneration, paging.owns(request) else { return }
            exchanges = page.exchanges
            paging.finishRefresh(request, nextCursor: page.nextCursor)
            loadError = nil
            // The feed and the drawer badge describe the same backlog; a fresh
            // page is the moment to make sure the badge agrees with it.
            Task { await store.refreshPrivacyPendingCount() }
        } catch {
            if generation == loadGeneration {
                loadError = privacyRefreshFailure(previous: loadError, caught: error)
                paging.failRefresh(request)
            }
        }
    }

    private func loadMore() async {
        guard let client = store.privacy, let request = paging.beginLoadMore() else { return }
        do {
            let page = try await client.listExchangeFeed(limit: 50, cursor: request.cursor)
            guard paging.owns(request) else { return }
            let fresh = appendUnique(page.exchanges, to: &exchanges, id: \.id)
            paging.finishLoadMore(
                request,
                nextCursor: page.nextCursor,
                madeProgress: !fresh.isEmpty
            )
        } catch {
            paging.failLoadMore(request, error: error)
        }
    }

    // MARK: Deciding

    private func resolve(_ item: PrivacyPendingReview, approve: Bool) {
        guard busy == nil, let client = store.privacy else { return }
        let action = approve ? "approve" : "deny"
        busy = "\(item.approvalId):\(action)"
        actionErrors[item.approvalId] = nil
        Task {
            defer { busy = nil }
            do {
                let response = approve
                    ? try await client.approve(id: item.approvalId)
                    : try await client.deny(id: item.approvalId)
                resolution = privacyResolutionCopy(response, agentName: item.agentName)
                await load()
            } catch {
                actionErrors[item.approvalId] = GatewayErrorView.classify(error).title
            }
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
private struct PrivacyReviewCardHarness: View {
    let review: PrivacyPendingReview

    var body: some View {
        ScrollView {
            PrivacyReviewCard(
                review: review,
                onApprove: {},
                onDeny: {}
            )
            .padding()
        }
        .background(Theme.bgPrimary)
    }
}

#Preview("Privacy review card — pending") {
    PrivacyReviewCardHarness(
        review: PrivacyPendingReview(detail: PreviewMocks.privacyApprovalDetail)
    )
    .omnesisColorScheme()
}

#Preview("Privacy review card — check unavailable") {
    PrivacyReviewCardHarness(
        review: PrivacyPendingReview(detail: PreviewMocks.privacyUnavailableApproval)
    )
    .omnesisColorScheme()
}

@available(iOS 17.0, *)
private struct PrivacyActivityPaneHarness<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        NavigationStack { content }
            .background(Theme.bgPrimary)
            .environment(AppStore.preview())
            .omnesisColorScheme()
    }
}

#Preview("Privacy activity — pinned review and feed") {
    PrivacyActivityPaneHarness {
        PrivacyActivityPane(
            previewExchanges: PreviewMocks.privacyExchangeFeed,
            previewNextCursor: "activity-next",
            previewSubscriptionApprovals: [PreviewMocks.subscriptionApproval]
        )
    }
}

// Nothing is waiting: the feed carries the whole screen, with no pinned card
// and no watch-request section above it.
#Preview("Privacy activity — feed only") {
    PrivacyActivityPaneHarness {
        PrivacyActivityPane(
            previewExchanges: PreviewMocks.privacyExchangeFeed.filter {
                !privacyExchangeIsPendingReview($0)
            }
        )
    }
}

// Narrowing the feed never removes the review pinned above it.
#Preview("Privacy activity — failed filter with pinned review") {
    PrivacyActivityPaneHarness {
        PrivacyActivityPane(
            previewExchanges: PreviewMocks.privacyExchangeFeed,
            previewFilter: .failed
        )
    }
}

#Preview("Privacy activity — filter with no matches") {
    PrivacyActivityPaneHarness {
        PrivacyActivityPane(
            previewExchanges: [PreviewMocks.privacyExchanges[1]],
            previewFilter: .failed
        )
    }
}

// The current page contains only the review pinned above the feed. A cursor
// means the ledger is not definitively empty, so only the paging affordance is
// shown below the filters.
#Preview("Privacy activity — only pinned row with older activity") {
    PrivacyActivityPaneHarness {
        PrivacyActivityPane(
            previewExchanges: [PreviewMocks.privacyExchanges[0]],
            previewNextCursor: "older-activity"
        )
    }
}

#Preview("Privacy activity — loading") {
    PrivacyActivityPaneHarness {
        PrivacyActivityPane(previewExchanges: [], previewLoading: true)
    }
}

#Preview("Privacy activity — error") {
    PrivacyActivityPaneHarness {
        PrivacyActivityPane(
            previewExchanges: [],
            previewLoadError: URLError(.cannotConnectToHost)
        )
    }
}

// The decision landed. The card is replaced by what happened, so the operator
// cannot be offered the same choice twice.
#Preview("Privacy activity — just decided") {
    PrivacyActivityPaneHarness {
        PrivacyActivityPane(
            previewExchanges: PreviewMocks.privacyExchangeFeed,
            previewResolution: PreviewMocks.privacyApprovedResolution
        )
    }
}

#Preview("Privacy feed rows") {
    NavigationStack {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(PreviewMocks.privacyExchangeFeed) { exchange in
                    PrivacyFeedRow(exchange: exchange)
                    Divider().background(Theme.borderLight)
                }
            }
            .padding(.horizontal, Theme.Spacing.lg)
        }
        .background(Theme.bgPrimary)
    }
    .omnesisColorScheme()
}
#endif

#endif
