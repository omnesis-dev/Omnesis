// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// List body for prior conversations — pulled out of the view chrome so
/// the same content renders in two surfaces: the main menu
/// (`MainMenuDrawer`) and the legacy push-style page kept for previews
/// / snapshot tests.
///
/// Renders a flat `LazyVStack` of rows rather than a SwiftUI `List`. The
/// drawer wraps the entire panel (menu rows + this list) in one outer
/// `ScrollView` so the user can scroll the whole surface — keeping a
/// nested `List` here would have produced a competing scroll context
/// and split the available vertical real estate.
///
/// Tap behaviour is delegated to the caller via `onSelect` so the drawer
/// can flip its `selection` back to `.agent` before resuming (otherwise
/// taps from non-Agent sections would silently load the conversation
/// without bringing the transcript surface back into view).
///
/// Conversation deletion lives on a long-press `contextMenu` rather than a
/// row-level `swipeActions`: a horizontal swipe on a row races the drag that
/// slides the app back over the menu.
@available(iOS 17.0, *)
struct AgentConversationsList: View {
    @Environment(AppStore.self) private var store
    var onSelect: (ConversationSummary) -> Void

    var body: some View {
        let items = store.agent.conversations
        Group {
            if items.isEmpty, store.agent.conversationsLoading {
                ProgressView()
                    .tint(Theme.accent)
                    .frame(maxWidth: .infinity, minHeight: 200)
            } else if let error = store.agent.conversationsError, items.isEmpty {
                GatewayErrorView(
                    context: "load conversations",
                    error: error,
                    onRetry: { Task { await store.agent.refreshConversations() } }
                )
                .frame(minHeight: GatewayErrorView.minScrollHeight)
            } else if !shouldShowPagedContent(
                itemCount: items.count,
                canLoadMore: store.agent.conversationsNextCursor != nil,
                isLoadingMore: store.agent.conversationsLoadingMore,
                hasPaginationError: store.agent.conversationsPagingError != nil,
                isTruncated: store.agent.conversationsPagingTruncated
            ) {
                emptyState
            } else {
                LazyVStack(spacing: 0) {
                    if let error = store.agent.conversationsError {
                        conversationErrorBanner(error, retryable: true)
                    }
                    if let error = store.agent.conversationActionError {
                        conversationErrorBanner(error, retryable: false)
                    }
                    ForEach(items) { item in
                        // Plain content + `.onTapGesture` rather than a `Button`:
                        // a tap and the `.contextMenu` long-press are
                        // duration-disambiguated, so they're mutually exclusive.
                        // A `Button` (especially under a custom `ButtonStyle`)
                        // fires its action on touch-up even when the long-press
                        // pops the menu, which opened the conversation while
                        // showing the menu.
                        row(item: item)
                            .contentShape(Rectangle())
                            .onTapGesture { onSelect(item) }
                            .accessibilityElement(children: .combine)
                            .accessibilityValue(unreadForDisplay(item) ? "Unread" : "")
                            .accessibilityAddTraits(.isButton)
                            .accessibilityAction { onSelect(item) }
                            .contextMenu {
                                Button {
                                    Task {
                                        await store.agent.togglePin(
                                            id: item.sessionId,
                                            pinned: !item.pinned
                                        )
                                    }
                                } label: {
                                    Label(
                                        item.pinned ? "Unpin" : "Pin",
                                        systemImage: item.pinned ? "pin.slash" : "pin"
                                    )
                                }
                                Button(role: .destructive) {
                                    Task { await store.agent.deleteConversation(id: item.sessionId) }
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                    }
                    ListPagingFooter(
                        loadKey: store.agent.conversationsAutomaticLoadKey,
                        label: "Load more conversations",
                        loadingLabel: "Loading conversations…",
                        isLoading: store.agent.conversationsLoadingMore,
                        error: store.agent.conversationsPagingError,
                        isTruncated: store.agent.conversationsPagingTruncated,
                        retry: { Task { await store.agent.loadMoreConversations() } }
                    )
                }
            }
        }
        .task { await store.agent.refreshConversations() }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "bubble.left")
                .font(.system(size: 40))
                .foregroundStyle(Theme.textMuted)
            Text("No prior conversations")
                .font(.system(size: 14))
                .foregroundStyle(Theme.textSecondary)
            Text("Send a message in the Agent tab to start one.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 200)
        .padding(.top, Theme.Spacing.lg)
    }

    private func conversationErrorBanner(_ error: Error, retryable: Bool) -> some View {
        HStack(spacing: Theme.Spacing.sm) {
            Label(
                GatewayErrorView.classify(error).title,
                systemImage: "exclamationmark.triangle"
            )
            .font(.system(size: 12))
            .foregroundStyle(Theme.warning)
            Spacer(minLength: Theme.Spacing.sm)
            if retryable {
                Button("Retry") {
                    Task { await store.agent.refreshConversations() }
                }
                .font(.system(size: 12, weight: .semibold))
                .buttonStyle(.borderless)
            } else {
                Button("Dismiss") {
                    store.agent.clearConversationActionError()
                }
                .font(.system(size: 12, weight: .semibold))
                .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, Theme.Spacing.sm)
        .background(Theme.warning.opacity(0.09))
        .accessibilityElement(children: .contain)
    }
}

@available(iOS 17.0, *)
extension AgentConversationsList {
    /// The conversation on screen has been read by definition, so it drops its
    /// dot immediately rather than waiting for a list refetch — which may
    /// still be reporting the state from before it was opened.
    fileprivate func unreadForDisplay(_ item: ConversationSummary) -> Bool {
        item.unread && item.sessionId != store.agent.sessionId
    }

    fileprivate func row(item: ConversationSummary) -> some View {
        HStack(spacing: 6) {
            // An indicator gutter, present on every row so the titles share one
            // left edge whether or not the row is unread.
            ZStack {
                if unreadForDisplay(item) {
                    Circle()
                        .fill(Theme.accent)
                        .frame(width: 6, height: 6)
                }
            }
            .frame(width: 8)
            // Decoration only. A label on a shape attaches to nothing — the
            // state is announced by the row's accessibilityValue below, which
            // is where a VoiceOver user swiping the list will meet it.
            .accessibilityHidden(true)
            if item.pinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.textMuted)
                    .accessibilityHidden(true)
            }
            Text(item.title.isEmpty ? "(untitled)" : item.title)
                .font(.system(size: 15, weight: unreadForDisplay(item) ? .semibold : .regular))
                .foregroundStyle(Theme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.vertical, 10)
        .frame(height: 40)
        .contentShape(Rectangle())
    }
}

/// Legacy push-style page wrapper around `AgentConversationsList`. Kept
/// for preview / snapshot coverage and any future surface that prefers
/// a full-screen pushed view over the main menu.
@available(iOS 17.0, *)
struct AgentConversationsListView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            AgentConversationsList(onSelect: { item in
                Task {
                    await store.agent.resumeConversation(id: item.sessionId)
                    dismiss()
                }
            })
        }
        .background(Theme.bgPrimary.ignoresSafeArea())
        .refreshable { await store.agent.refreshConversations() }
        .navigationTitle("Conversations")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    store.agent.newConversation()
                    dismiss()
                } label: {
                    Image(systemName: "square.and.pencil")
                        .foregroundStyle(Theme.accent)
                }
                .accessibilityLabel("New conversation")
            }
        }
        .omnesisColorScheme()
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("AgentConversationsList — populated") {
    NavigationStack {
        AgentConversationsListView()
            .environment(AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich))
    }
}

@available(iOS 17.0, *)
#Preview("AgentConversationsList — empty") {
    NavigationStack {
        AgentConversationsListView()
            .environment(AppStore.preview(agentPreview: .init()))
    }
}

@available(iOS 17.0, *)
#Preview("AgentConversationsList — error") {
    let store = AppStore.preview(agentPreview: .init())
    // swiftlint:disable:next redundant_discardable_let
    let _ = store.agent.installPreviewState(
        sessionId: "preview-session",
        model: "preview-model",
        backend: "preview-backend",
        title: "Preview",
        turns: [],
        citations: [],
        conversations: [],
        conversationsError: URLError(.timedOut)
    )
    NavigationStack {
        AgentConversationsListView()
            .environment(store)
    }
}
#endif
#endif
