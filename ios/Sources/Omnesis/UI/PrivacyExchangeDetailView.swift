// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

// One exchange, told as a spine. The spine itself — the three cards and
// the trust-boundary rail they stand on — lives in PrivacyExchangeSpine;
// this file owns the route: loading the exchange and its ledger, the
// header, the overflow menu, and the approve/deny/delete actions.

// How far back a deep link is willing to walk to find the exchange it names.
// The cap is a guard against an unbounded conversation, not an expected depth:
// a linked exchange is normally on the first page.
private let privacyExchangeLookupPageSize = 50
private let privacyEventLookupPageSize = 100
private let privacyExchangeLookupMaxPages = 20

// MARK: - The route

@available(iOS 17.0, *)
struct PrivacyExchangeDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let conversationId: String
    let taskId: String

    @State private var exchange: PrivacyExchangePresentation?
    @State private var events: [PrivacyAuditEventSummary] = []
    @State private var loading = true
    @State private var loadError: Error?
    @State private var actionError: String?
    @State private var busy: String?
    @State private var confirmDelete = false
    @State private var deleting = false
    @State private var loadArbiter = PrivacyExchangeLoadArbiter()

    private let isPreview: Bool
    private let onChanged: () -> Void

    init(conversationId: String, taskId: String, onChanged: @escaping () -> Void = {}) {
        self.conversationId = conversationId
        self.taskId = taskId
        self.onChanged = onChanged
        self.isPreview = false
    }

    #if DEBUG
    init(
        previewExchange: PrivacyExchangePresentation,
        previewEvents: [PrivacyAuditEventSummary] = []
    ) {
        self.conversationId = previewExchange.conversationId
        self.taskId = previewExchange.taskId
        self._exchange = State(initialValue: previewExchange)
        self._events = State(initialValue: previewEvents)
        self._loading = State(initialValue: false)
        self.onChanged = {}
        self.isPreview = true
    }
    #endif

    var body: some View {
        content
            // The outcome is the header's chip; repeating it in the bar would
            // say the same thing twice, two lines apart.
            .navigationTitle("Exchange")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .toolbar {
                if exchange != nil {
                    ToolbarItem(placement: .topBarTrailing) { overflowMenu }
                }
            }
            .task {
                guard !isPreview else { return }
                await load()
            }
            .task(id: exchange?.status) {
                guard !isPreview, privacyExchangeNeedsPolling(exchange) else { return }
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: .seconds(2))
                    } catch {
                        return
                    }
                    await load(background: true)
                    if !privacyExchangeNeedsPolling(exchange) { return }
                }
            }
            .refreshable { await load() }
            .onDisappear { loadArbiter.invalidate() }
            .confirmationDialog(
                "Delete this audit conversation?",
                isPresented: $confirmDelete,
                titleVisibility: .visible
            ) {
                Button("Delete conversation", role: .destructive) {
                    Task { await deleteConversation() }
                }
            } message: {
                Text(
                    "This removes the trusted audit transcript and its external-view history. "
                        + "This cannot be undone."
                )
            }
    }

    private var overflowMenu: some View {
        Menu {
            Button("Delete audit conversation", role: .destructive) { confirmDelete = true }
                .disabled(deleting)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("More actions")
    }

    @ViewBuilder
    private var content: some View {
        if loading, exchange == nil {
            ProgressView()
                .tint(Theme.accent)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError, exchange == nil {
            GatewayErrorView(
                context: "load the exchange",
                error: loadError,
                onRetry: { Task { await load() } }
            )
        } else if let exchange {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    header(exchange)
                    PrivacyExchangeSpine(
                        exchange: exchange,
                        events: events,
                        busy: busy,
                        actionError: actionError,
                        onApprove: { resolve(approve: true) },
                        onDeny: { resolve(approve: false) }
                    )
                }
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.top, Theme.Spacing.sm)
                .padding(.bottom, Theme.Spacing.xl)
            }
        } else {
            PrivacyEmptyState(
                symbol: "questionmark.circle",
                title: "This exchange is no longer available",
                detail: "It may have been deleted from the audit record."
            )
            .padding(.horizontal, Theme.Spacing.lg)
        }
    }

    private func header(_ exchange: PrivacyExchangePresentation) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            PrivacyExchangeOutcomeChip(exchange: exchange)
            Text(externalAgentNarrativeName(exchange.externalAgent))
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
        }
    }

    private func load(background: Bool = false) async {
        guard !isPreview else { return }
        guard let generation = loadArbiter.begin(background: background) else { return }
        defer { loadArbiter.finish(background: background) }
        guard let client = store.privacy else {
            if loadArbiter.owns(generation) {
                loading = false
                loadError = URLError(.cannotConnectToHost)
            }
            return
        }
        if !background { loading = true }
        defer {
            if !background, loadArbiter.owns(generation) { loading = false }
        }
        do {
            async let loadedExchange = findExchange(client)
            async let loadedEvents = findEvents(client)
            let result = try await (loadedExchange, loadedEvents)
            guard loadArbiter.owns(generation) else { return }
            exchange = result.0
            events = result.1
            loadError = nil
        } catch {
            if !background, loadArbiter.owns(generation) { loadError = error }
        }
    }

    /// A conversation is read a page at a time, newest first, and there is no
    /// fetch-one-exchange route — so a link into an older exchange has to walk
    /// back to it. Stopping after one page is what made a bookmark or a feed
    /// row into a long conversation report the exchange as gone.
    private func findExchange(_ client: PrivacyClient) async throws
        -> PrivacyExchangePresentation? {
        var cursor: String?
        for _ in 0 ..< privacyExchangeLookupMaxPages {
            let page = try await client.listExchanges(
                conversationId: conversationId,
                limit: privacyExchangeLookupPageSize,
                cursor: cursor,
                includeAgentTracesTaskId: taskId
            )
            if let match = page.exchanges.first(where: { $0.taskId == taskId }) { return match }
            guard let previous = page.previousCursor else { return nil }
            cursor = previous
        }
        return nil
    }

    /// The same walk for the ledger. One task's events are contiguous in the
    /// conversation's sequence, so once a page past the block yields none the
    /// walk is done and the remaining history need not be fetched.
    private func findEvents(_ client: PrivacyClient) async throws
        -> [PrivacyAuditEventSummary] {
        var collected: [PrivacyAuditEventSummary] = []
        var cursor: String?
        for _ in 0 ..< privacyExchangeLookupMaxPages {
            let page = try await client.listEvents(
                conversationId: conversationId,
                limit: privacyEventLookupPageSize,
                cursor: cursor
            )
            let matching = page.events.filter { $0.taskId == taskId }
            if matching.isEmpty, !collected.isEmpty { break }
            // Each page is oldest-first and every next page is older still.
            collected.insert(contentsOf: matching, at: 0)
            guard let previous = page.previousCursor else { break }
            cursor = previous
        }
        return collected
    }

    private func resolve(approve: Bool) {
        guard busy == nil, let approvalId = exchange?.approval?.id,
              let client = store.privacy else { return }
        busy = approve ? "approve" : "deny"
        actionError = nil
        Task {
            defer { busy = nil }
            do {
                if approve {
                    _ = try await client.approve(id: approvalId)
                } else {
                    _ = try await client.deny(id: approvalId)
                }
                onChanged()
                await load()
            } catch {
                actionError = GatewayErrorView.classify(error).title
            }
        }
    }

    private func deleteConversation() async {
        guard let client = store.privacy, !deleting else { return }
        deleting = true
        defer { deleting = false }
        do {
            try await client.deleteConversation(id: conversationId)
            onChanged()
            dismiss()
        } catch {
            actionError = GatewayErrorView.classify(error).title
        }
    }
}

#if DEBUG
/// The ledger a preview hands over is filtered to the exchange it is about,
/// the way the route filters it, so a preview never shows another task's steps
/// on this task's spine.
@available(iOS 17.0, *)
private func previewLedger(for exchange: PrivacyExchangePresentation)
    -> [PrivacyAuditEventSummary] {
    PreviewMocks.privacyAuditEvents.filter { $0.taskId == exchange.taskId }
}

#Preview("Privacy exchange — pending") {
    NavigationStack {
        PrivacyExchangeDetailView(
            previewExchange: PreviewMocks.privacyExchanges[0],
            previewEvents: previewLedger(for: PreviewMocks.privacyExchanges[0])
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Privacy exchange — every recorded step on the spine") {
    NavigationStack {
        PrivacyExchangeDetailView(
            previewExchange: PreviewMocks.privacyExchanges[1],
            previewEvents: previewLedger(for: PreviewMocks.privacyExchanges[1])
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Privacy exchange — agent transcripts") {
    NavigationStack {
        PrivacyExchangeDetailView(
            previewExchange: PreviewMocks.privacyExchangeWithTraces,
            previewEvents: []
        )
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

// A request and a draft at the length they actually arrive at: the quotation
// panel has to wrap paragraphs and a list without clipping or scrolling.
#Preview("Privacy exchange — long draft") {
    NavigationStack {
        PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyLongDraftExchange)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Privacy exchange — failed") {
    NavigationStack {
        PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyFailedExchange)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Privacy exchange — failed with provider detail") {
    NavigationStack {
        PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyProviderFailedExchange)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Privacy exchange — privacy check failed") {
    NavigationStack {
        PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyReviewFailedExchange)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Privacy exchange — unattended draft") {
    NavigationStack {
        PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyUnattendedDraftExchange)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#Preview("Privacy exchange — drafting") {
    NavigationStack {
        PrivacyExchangeDetailView(previewExchange: PreviewMocks.privacyRunningExchange)
    }
    .environment(AppStore.preview())
    .omnesisColorScheme()
}

#endif

#endif
