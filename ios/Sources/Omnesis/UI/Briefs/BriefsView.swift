// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Environment handler that jumps the user into an agent conversation:
/// flips the main-menu section to Agent, resumes the given conversation
/// id, and — when the second argument is non-nil — sends that text as
/// the user's first message once the resume lands (the dictation
/// shortcut's "stop talking and the agent answers" hand-off). Injected
/// by the app shell (`HomeView`), which owns the section selection; the
/// default no-op is only hit by previews and snapshots (the button
/// still renders, the jump simply doesn't happen outside the shell).
/// Mirrors `openModelSettings` in `GatewayErrorView`.
private struct OpenAgentConversationKey: EnvironmentKey {
    static let defaultValue: ((String, String?) -> Void)? = nil
}

private struct OpenBackgroundAgentModelSettingsKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var openAgentConversation: ((String, String?) -> Void)? {
        get { self[OpenAgentConversationKey.self] }
        set { self[OpenAgentConversationKey.self] = newValue }
    }

    var openBackgroundAgentModelSettings: (() -> Void)? {
        get { self[OpenBackgroundAgentModelSettingsKey.self] }
        set { self[OpenBackgroundAgentModelSettingsKey.self] = newValue }
    }
}

/// The verb the "clear this brief" swipe/menu action reads as, per kind:
/// a `loop` brief is a tracked to-do, so finishing it reads "Done"; an
/// `info` brief is context to note, so clearing it reads "Got it". The
/// reason each reports is `BriefKind.clearActionReason`.
extension BriefKind {
    fileprivate var clearActionLabel: String {
        switch self {
        case .loop: "Done"
        case .info: "Got it"
        }
    }
}

/// What the Briefs sheet is showing. The feed has two sheet destinations —
/// reading a brief, and choosing how to clear one — and they share a single
/// presentation, because two `.sheet` modifiers on one view do not both work.
///
/// The case is part of the identity, not just the brief: moving between
/// reading a brief and clearing that same brief is a change of destination,
/// and an id derived from the brief alone would read as "no change" and leave
/// the first sheet up.
private enum BriefSheet: Identifiable {
    case reading(BriefRecord)
    case dismissOptions(BriefRecord)

    var id: String {
        switch self {
        case .reading(let brief): "reading-\(brief.id)"
        case .dismissOptions(let brief): "dismiss-\(brief.id)"
        }
    }
}

/// Top-level Briefs tab — the Omnesis Briefs awareness feed as a
/// scrollable list built for triage: every card visible at a glance,
/// tap a row to read it in a stacked detail sheet, swipe a row to clear
/// it, long-press a row to talk back to it. The feed is finite and it is
/// explicitly OK for it to end — the empty state is the goal state, never
/// padded.
///
/// Owns the data fetch; delegates rendering to `BriefsListContent` so
/// previews and snapshots render without a gateway. The feed is fetched
/// on appear only — briefs already exist server-side, maintained by the
/// Cognition Steward; pull to refresh.
@available(iOS 17.0, *)
struct BriefsView: View {
    @Environment(AppStore.self) private var store
    @Environment(NotificationRouter.self) private var router

    @State private var feed = BriefsFeedState(briefs: [])
    @State private var loading = BriefsFeedLoadingState()
    @State private var loadError: Error?
    @State private var paging = CursorPagingState()
    /// What the single sheet is presenting, if anything. Reading a brief and
    /// choosing how to clear one are separate destinations but share one
    /// presentation, so neither can suppress the other.
    @State private var sheet: BriefSheet?
    @State private var dismissError: String?
    @State private var openingThreadBriefId: String?
    @State private var talkError: String?
    /// Dictation shortcut: the detail sheet's mic button records a
    /// question and hands it to the brief's talk-back thread as the
    /// first message.
    @State private var speech = SpeechRecognizer()
    /// The brief being dictated to; nil when the mic is idle. Cleared
    /// BEFORE cancel() so the commit handler can't race a stale target.
    @State private var dictationTarget: BriefRecord?
    @Environment(\.openAgentConversation) private var openAgentConversation
    @Environment(\.openBackgroundAgentModelSettings) private var openBackgroundAgentModelSettings
    @Binding var menuOpen: Bool

    init(menuOpen: Binding<Bool>) {
        self._menuOpen = menuOpen
    }

    var body: some View {
        NavigationStack {
            BriefsListContent(
                feed: feed,
                loading: loading.isLoading,
                loadError: loadError,
                onOpen: { open($0) },
                onQuickClear: { quickDismiss($0, reason: $0.kind.clearActionReason) },
                onAsk: { brief in Task { await openThread(for: brief) } },
                onDictate: { micTapped($0) },
                onMoreOptions: { sheet = .dismissOptions($0) },
                speech: speech,
                dictatingBriefId: rowDictatingBriefId,
                onStopDictation: { speech.stopListening() },
                onRetry: { Task { await load() } },
                // Pull-to-refresh re-queries the gateway without the
                // full-screen spinner, so the native pull spinner is the
                // only cue and the empty/populated content stays put.
                onRefresh: { await load(showLoadingIndicator: false) },
                paging: paging,
                onLoadMore: { Task { await loadMore() } },
                showsModelWarning: store.briefsMenuEntry == .needsAttention,
                onConfigureModel: { openBackgroundAgentModelSettings?() }
            )
            .navigationTitle("Briefs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    MenuToolbarButton(isOpen: $menuOpen)
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .background(Theme.bgPrimary.ignoresSafeArea())
            .task {
                await load()
                consumeRouterTarget()
                // The row's mic can be the very first dictation
                // surface the user touches — fire the one-time system
                // permission prompts up front (no-op once granted).
                speech.requestPermissionsIfNeeded()
            }
            // Dictation hand-off. Only a user stop commits: stopping via
            // the mic always passes through .finishing, so .finishing →
            // .idle is the "user finished" signal. A direct .listening →
            // .idle transition is a recognizer-initiated end (phone call,
            // Siri, route change, service error) — committing there would
            // send a half-finished sentence and yank the user away
            // mid-speech, so it discards instead. Empty transcripts
            // commit nothing either way.
            .onChange(of: speech.state) { oldValue, newValue in
                guard newValue == .idle, let brief = dictationTarget else { return }
                if oldValue == .finishing {
                    dictationTarget = nil
                    let text = speech.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    Task { await openThread(for: brief, autoSend: text) }
                } else if oldValue == .listening {
                    dictationTarget = nil
                }
            }
            // Leaving the Briefs section mid-recording (talk hand-off,
            // drawer navigation) tears this view down — release the mic
            // and deactivate the audio session instead of leaking a live
            // .record session with no owner.
            .onDisappear {
                discardDictation()
            }
            .onChange(of: router.pendingTarget) { _, target in
                // A push tap while Briefs is already on screen: the feed
                // was loaded by the initial task; open immediately.
                if target != nil { consumeRouterTarget() }
            }
            // One presentation for both destinations. Two `.sheet` modifiers on
            // the same view do not both work — SwiftUI honours one and the
            // other silently never presents, which is why "More…" appeared to
            // do nothing at all. A single sheet over a sum type cannot develop
            // that fault again.
            .sheet(item: $sheet, onDismiss: { discardDictation() }) { destination in
                switch destination {
                case .reading(let brief):
                    BriefDetailSheet(
                        brief: brief,
                        store: store,
                        speech: speech,
                        openingThread: openingThreadBriefId == brief.id,
                        onTalkTapped: { Task { await openThread(for: brief) } },
                        onMicTapped: { micTapped(brief) },
                        onConfirmDismiss: { reason, feedback, snoozeUntil in
                            Task {
                                await dismissBrief(
                                    brief, reason: reason, feedback: feedback, snoozeUntil: snoozeUntil
                                )
                                sheet = nil
                            }
                        },
                        talkError: $talkError
                    )
                case .dismissOptions(let brief):
                    BriefDismissSheet(brief: brief) { reason, feedback, snoozeUntil in
                        Task {
                            await dismissBrief(
                                brief, reason: reason, feedback: feedback, snoozeUntil: snoozeUntil
                            )
                        }
                    }
                }
            }
            .alert(
                "Couldn't dismiss brief",
                isPresented: Binding(
                    get: { dismissError != nil },
                    set: { if !$0 { dismissError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { dismissError = nil }
            } message: {
                Text(dismissError ?? "")
            }
            .alert(
                "Couldn't open the conversation",
                isPresented: Binding(
                    get: { talkError != nil },
                    set: { if !$0 { talkError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { talkError = nil }
            } message: {
                Text(talkError ?? "")
            }
        }
    }

    /// The brief whose LIST ROW is currently the recording strip: a
    /// dictation started from the row's Dictate action, still active,
    /// with no detail sheet covering it.
    private var rowDictatingBriefId: String? {
        guard sheet == nil,
              speech.isListening || speech.state == .finishing
        else { return nil }
        return dictationTarget?.id
    }

    /// Open a brief in the stacked detail sheet and settle its
    /// once-per-brief mark-read POST. Opening a different brief while a
    /// row dictation is live discards that recording — attention moved.
    private func open(_ brief: BriefRecord) {
        if let target = dictationTarget, target.id != brief.id {
            discardDictation()
        }
        sheet = .reading(brief)
        if feed.markViewed(id: brief.id), let client = store.briefs {
            // Fire-and-forget: read-marking is best-effort bookkeeping
            // (it only affects sort order on a future visit) — a failure
            // never interrupts the reading flow.
            Task { try? await client.markRead(briefId: brief.id) }
        }
    }

    /// A row-swipe dismissal: the discrete reason IS the feedback, no
    /// modal. Snooze and the rarer reasons live in More… and the
    /// detail's options menu.
    private func quickDismiss(_ brief: BriefRecord, reason: BriefDismissReason) {
        let removed = withAnimation(.easeOut(duration: 0.2)) {
            feed.remove(id: brief.id)
        }
        Task {
            await dismissBrief(
                brief,
                reason: reason,
                feedback: nil,
                snoozeUntil: nil,
                restoreOnFailure: removed
            )
        }
    }

    /// Land a push deep-link on its brief. The pushed brief is by
    /// definition newly minted, so a warm view's feed (loaded on some
    /// earlier appearance) usually won't contain it yet — on a miss,
    /// refetch once and retry. A target still missing after the refetch
    /// (dismissed or expired since the notification fired) degrades to
    /// the fresh list.
    private func consumeRouterTarget() {
        guard case .brief(let briefId) = router.pendingTarget else { return }
        router.consume()
        if let brief = feed.brief(withId: briefId) {
            open(brief)
            return
        }
        Task {
            await load(showLoadingIndicator: false)
            if let brief = feed.brief(withId: briefId) { open(brief) }
        }
    }

    /// Fetch the feed fresh from the gateway. `showLoadingIndicator`
    /// drives the full-screen `ProgressView` shown on the initial
    /// `.task` load; pull-to-refresh passes `false` so the current
    /// content — and its native pull-to-refresh spinner — stays on
    /// screen while the fetch runs, rather than being torn down for the
    /// centered spinner (which would also dismantle the refresh control).
    private func load(showLoadingIndicator: Bool = true) async {
        let request = paging.beginRefresh()
        guard let client = store.briefs else {
            paging.failRefresh(request)
            loading.finishOwnedRefresh()
            // Client is nil during the brief unpair → re-pair gap.
            // Route through the unreachable bucket so the user gets
            // the shared Retry / Open settings affordances.
            loadError = URLError(.cannotConnectToHost)
            return
        }
        loading.begin(showIndicator: showLoadingIndicator)
        do {
            let page = try await client.feed()
            guard paging.owns(request) else { return }
            feed = BriefsFeedState(briefs: page.briefs)
            loading.finishOwnedRefresh()
            paging.finishRefresh(request, nextCursor: page.pageInfo.nextCursor)
            loadError = nil
            // The refreshed feed may no longer contain the brief being
            // dictated to (dismissed from another device, expired) — its
            // recording strip just unmounted, so without this the mic
            // would stay live with no visible surface or stop
            // affordance. A .finishing recording is exempt (committed
            // intent; the hand-off is already in flight).
            if let target = dictationTarget, feed.brief(withId: target.id) == nil {
                discardDictation()
            }
        } catch {
            guard paging.owns(request) else { return }
            loading.finishOwnedRefresh()
            paging.failRefresh(request)
            loadError = error
        }
    }

    private func loadMore() async {
        guard let client = store.briefs else { return }
        guard let request = paging.beginLoadMore() else { return }
        do {
            let page = try await client.feed(cursor: request.cursor)
            guard paging.owns(request) else { return }
            let addedCount = feed.appendPage(page.briefs)
            paging.finishLoadMore(
                request,
                nextCursor: page.pageInfo.nextCursor,
                madeProgress: addedCount > 0
            )
        } catch {
            paging.failLoadMore(request, error: error)
        }
    }

    private func dismissBrief(
        _ brief: BriefRecord,
        reason: BriefDismissReason,
        feedback: String?,
        snoozeUntil: Date?,
        restoreOnFailure removed: BriefsFeedState.RemovedBrief? = nil
    ) async {
        guard let client = store.briefs else {
            if let removed {
                withAnimation(.easeOut(duration: 0.2)) { feed.restore(removed) }
            }
            dismissError = GatewayErrorView.classify(URLError(.cannotConnectToHost))
                .detail(for: "dismiss this brief")
            return
        }
        do {
            try await client.dismiss(
                briefId: brief.id, reason: reason, feedback: feedback, snoozeUntil: snoozeUntil
            )
            withAnimation(.easeOut(duration: 0.2)) { feed.remove(id: brief.id) }
        } catch {
            // 409 = already in a terminal dismissed state (e.g. dismissed
            // from another device since this list loaded) — it is gone
            // either way, so drop the row rather than erroring.
            if case GatewayClient.Error.serverError(let status, _) = error, status == 409 {
                withAnimation(.easeOut(duration: 0.2)) { feed.remove(id: brief.id) }
            } else {
                if let removed {
                    withAnimation(.easeOut(duration: 0.2)) { feed.restore(removed) }
                }
                dismissError = GatewayErrorView.classify(error).detail(for: "dismiss this brief")
            }
        }
    }

    /// Open (or reuse) the brief's talk-back thread, then jump into the
    /// agent conversation. The gateway is idempotent — one thread per
    /// brief — so tapping again after a jump lands in the same
    /// conversation with its history intact. `autoSend` is the dictation
    /// shortcut's transcript: sent as the user's first message once the
    /// conversation is resumed.
    private func openThread(for brief: BriefRecord, autoSend: String? = nil) async {
        // The single-flight latch guards the plain talk-tap. A dictation
        // commit (autoSend != nil) must not be dropped by an in-flight
        // open — the gateway is idempotent (one thread per brief), so a
        // concurrent second open converges on the same conversation.
        guard let client = store.briefs, openingThreadBriefId == nil || autoSend != nil
        else { return }
        openingThreadBriefId = brief.id
        defer { openingThreadBriefId = nil }
        do {
            let result = try await client.openThread(briefId: brief.id)
            openAgentConversation?(result.conversationId, autoSend)
        } catch {
            talkError = GatewayErrorView.classify(error).detail(for: "open the conversation")
        }
    }

    /// Tap the mic in the detail sheet: start dictating when idle, stop
    /// when already listening (the `speech.state` change handler commits
    /// the finalized transcript to the thread).
    private func micTapped(_ brief: BriefRecord) {
        switch speech.state {
        case .idle:
            dictationTarget = brief
            speech.startListening()
            // startListening fails synchronously (unsupported locale,
            // denied permission, audio-session error) by parking in
            // .unavailable — drop the target so no later state change
            // can commit against it.
            if speech.state != .listening { dictationTarget = nil }
        case .listening:
            if dictationTarget?.id == brief.id {
                // The recording brief's own mic: user stop = commit.
                speech.stopListening()
            } else {
                // A different brief's mic mid-recording: attention
                // moved — discard the active recording (mirroring
                // open()'s rule) and start fresh on the tapped brief.
                // Committing the old half-sentence here would send an
                // unintended partial message.
                dictationTarget = nil
                speech.cancel()
                dictationTarget = brief
                speech.startListening()
                if speech.state != .listening { dictationTarget = nil }
            }
        case .finishing, .unavailable:
            break
        }
    }

    /// Closing the detail sheet mid-RECORDING discards the recording —
    /// the transcript was about the brief that was on screen. A
    /// recognizer in `.finishing` is different: the user already tapped
    /// "stop and send", so that committed intent is left to finalize and
    /// hand off even as the sheet closes. A commit already in flight
    /// (target cleared) is unaffected either way.
    private func discardDictation() {
        guard dictationTarget != nil, speech.state != .finishing else { return }
        dictationTarget = nil
        speech.cancel()
    }
}

// MARK: - Presentational list

/// Renders the feed without doing any data fetching, so previews and
/// snapshot tests drive every state directly.
@available(iOS 17.0, *)
struct BriefsListContent: View {
    let feed: BriefsFeedState
    let loading: Bool
    let loadError: Error?
    let onOpen: (BriefRecord) -> Void
    let onQuickClear: (BriefRecord) -> Void
    let onAsk: (BriefRecord) -> Void
    var onDictate: (BriefRecord) -> Void = { _ in }
    let onMoreOptions: (BriefRecord) -> Void
    /// Dictation engine + which brief's row is the live recording strip.
    /// Defaults keep previews/snapshots compiling with an idle mic.
    var speech: SpeechRecognizer = .init()
    var dictatingBriefId: String?
    var onStopDictation: () -> Void = {}
    let onRetry: () -> Void
    /// Pull-to-refresh action: re-fetches the feed. Attached once, high
    /// up, so it reaches whichever scrollable container the active state
    /// renders — the empty state's `ScrollView` as well as the list's —
    /// keeping the native pull spinner up until the fetch completes.
    let onRefresh: () async -> Void
    var paging = CursorPagingState()
    var onLoadMore: () -> Void = {}
    /// Historical briefs stay readable while the background agent is parked;
    /// this banner explains why no new ones will arrive and links to repair.
    var showsModelWarning = false
    var onConfigureModel: () -> Void = {}

    var body: some View {
        VStack(spacing: 0) {
            if showsModelWarning {
                BriefsModelWarning(onConfigureModel: onConfigureModel)
            }
            feedContent
                .refreshable(action: onRefresh)
        }
    }

    @ViewBuilder
    private var feedContent: some View {
        if loading, feed.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Theme.bgPrimary)
        } else if let loadError, feed.isEmpty {
            GatewayErrorView(context: "load briefs", error: loadError, onRetry: onRetry)
        } else if !shouldShowPagedContent(itemCount: feed.briefs.count, paging: paging) {
            EmptyBriefsView()
        } else {
            List {
                ForEach(feed.briefs) { brief in
                    if dictatingBriefId == brief.id {
                        // The row IS the recording surface: pulsing mic,
                        // live transcript, tap anywhere to stop-and-send.
                        BriefRowDictatingView(
                            brief: brief,
                            speech: speech,
                            onStop: onStopDictation
                        )
                        .listRowBackground(Theme.bgPrimary)
                        .listRowSeparatorTint(Theme.borderLight)
                        // Symmetric side insets matching the Privacy activity feed,
                        // with the rule pinned to the same bounds as the content.
                        .listRowInsets(
                            EdgeInsets(
                                top: 0,
                                leading: Theme.Spacing.lg,
                                bottom: 0,
                                trailing: Theme.Spacing.lg
                            )
                        )
                        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                        .alignmentGuide(.listRowSeparatorTrailing) { $0[.trailing] }
                    } else {
                        BriefRowView(brief: brief, unread: feed.isUnread(id: brief.id))
                            .contentShape(Rectangle())
                            .onTapGesture { onOpen(brief) }
                            .listRowBackground(Theme.bgPrimary)
                            .listRowSeparatorTint(Theme.borderLight)
                            // Talking back is a long press; clearing is a
                            // trailing swipe. The leading edge is deliberately
                            // empty: a rightward swipe anywhere in the leading
                            // majority of the screen reveals the main menu, and
                            // a row that claimed the same direction would make
                            // that gesture unreliable in this section alone —
                            // the one place in the app where it fails is worse
                            // than it being a long press everywhere. The
                            // conversation list in the menu resolved the mirror
                            // of this the same way.
                            .contextMenu {
                                Button {
                                    onAsk(brief)
                                } label: {
                                    Label("Ask", systemImage: "text.bubble")
                                }
                                Button {
                                    onDictate(brief)
                                } label: {
                                    Label("Dictate", systemImage: "mic.fill")
                                }
                            }
                            // The same two actions, declared again for
                            // assistive technology. A `contextMenu` is reached
                            // by double-tap-and-hold, which VoiceOver, Switch
                            // Control and Voice Control handle poorly or not
                            // at all — and since these moved off the leading
                            // swipe, which the Actions rotor surfaces for
                            // free, this is now the only row-level route to
                            // them.
                            .accessibilityActions {
                                Button("Ask") { onAsk(brief) }
                                Button("Dictate") { onDictate(brief) }
                            }
                            // Trailing is deliberately TWO actions in calm
                            // tints — the platform renders swipe actions as
                            // full-height slabs, so fewer + quieter is the
                            // discreet ceiling. The clear action's wording
                            // follows the kind (loop = "Done"/handled, info =
                            // "Got it"/acknowledged); the discrete reason IS
                            // the feedback signal.
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button {
                                    onQuickClear(brief)
                                } label: {
                                    Label(brief.kind.clearActionLabel, systemImage: "checkmark")
                                }
                                .tint(Theme.success)
                                Button {
                                    onMoreOptions(brief)
                                } label: {
                                    Label("More", systemImage: "ellipsis")
                                }
                                .tint(Color(white: 0.35))
                            }
                            // Last in the chain, closest to the List: row-level insets
                            // applied earlier are consumed by the swipe container, so
                            // the row keeps the system default unless set here.
                            // Symmetric side insets matching the Privacy activity feed,
                            // with the rule pinned to the same bounds as the content.
                            .listRowInsets(
                                EdgeInsets(
                                    top: 0,
                                    leading: Theme.Spacing.lg,
                                    bottom: 0,
                                    trailing: Theme.Spacing.lg
                                )
                            )
                            .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
                            .alignmentGuide(.listRowSeparatorTrailing) { $0[.trailing] }
                    }
                }
                ListPagingFooter(
                    state: paging,
                    label: "Load more briefs",
                    retry: onLoadMore
                )
                .listRowBackground(Theme.bgPrimary)
                .listRowSeparator(.hidden)
            }
            .listStyle(.plain)
            .background(Theme.bgPrimary)
            .scrollContentBackground(.hidden)
        }
    }
}

@available(iOS 17.0, *)
private struct BriefsModelWarning: View {
    let onConfigureModel: () -> Void

    var body: some View {
        Button(action: onConfigureModel) {
            HStack(spacing: Theme.Spacing.md) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Background agent needs attention")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text("Review model settings to resume new briefs")
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.warning)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            .padding(.vertical, Theme.Spacing.md)
            .background(Theme.warning.opacity(0.1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            "Background agent needs attention. Review model settings to resume new briefs."
        )
        .accessibilityHint("Opens background agent model settings")
    }
}

// MARK: - Row

/// One brief in the list: unread dot, title, the one-sentence
/// description, and the created time — glanceable triage material only,
/// never the long-form body.
@available(iOS 17.0, *)
struct BriefRowView: View {
    let brief: BriefRecord
    let unread: Bool

    var body: some View {
        // The unread dot lives in the list's side inset so the title aligns
        // with the Privacy feed's rows. The slot is identical whether the dot
        // is painted or clear, so marking a brief read never shifts its text.
        HStack(alignment: .top, spacing: 5) {
            Circle()
                .fill(unread ? Theme.accent : .clear)
                .frame(width: 7, height: 7)
                .padding(.top, 6)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(brief.title)
                    .font(.headline.weight(unread ? .semibold : .regular))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(2)
                Text(briefRowPlainDescription(brief.description))
                    .font(.subheadline)
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                if let created = brief.createdAtDate {
                    Text(created.formatted(.relative(presentation: .named)))
                        .font(.footnote)
                        .foregroundStyle(Theme.textMuted)
                }
            }
            // Fill the cell so the tap target is the whole row, not the
            // text's natural width — short briefs must not leave a dead
            // zone on the right.
            Spacer(minLength: 0)
        }
        // Pull the row back into the list's side inset: the dot (7) plus its
        // gap (5) live in the inset, so the title starts exactly at the inset
        // like the Privacy feed's rows.
        .padding(.leading, -(7 + 5))
        // Same breathing room above and below as a watch row.
        .padding(.vertical, Theme.Spacing.md)
        // Combined children speak the title, description, and time; the
        // unread state rides as the value so nothing the row conveys
        // visually is dropped for VoiceOver.
        .accessibilityElement(children: .combine)
        .accessibilityValue(unread ? "Unread" : "")
        .accessibilityHint("Opens the brief")
    }
}

// MARK: - Row recording strip

/// A row mid-dictation (started from its Dictate action): the composer's mic
/// language — accent-filled circle with pulse rings — plus the live
/// transcript, in place of the row content. Tapping anywhere stops and
/// sends; the hand-off then jumps into the brief's talk-back thread.
@available(iOS 17.0, *)
struct BriefRowDictatingView: View {
    let brief: BriefRecord
    var speech: SpeechRecognizer = .init()
    var onStop: () -> Void = {}

    var body: some View {
        HStack(spacing: Theme.Spacing.md) {
            ZStack {
                if speech.isListening {
                    MicPulseRing(color: Theme.accent)
                        .frame(width: 36, height: 36)
                }
                Circle()
                    .fill(Theme.accent)
                    .frame(width: 36, height: 36)
                if speech.state == .finishing {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                } else {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(brief.title)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .lineLimit(1)
                Text(transcriptLine)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.head)
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.circle.fill")
                .font(.system(size: 26))
                .foregroundStyle(Theme.accent)
                .accessibilityHidden(true)
        }
        // Same breathing room above and below as the other rows.
        .padding(.vertical, Theme.Spacing.md)
        .contentShape(Rectangle())
        .onTapGesture { onStop() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Recording a question about \(brief.title)")
        .accessibilityHint("Tap to stop and send to the agent")
    }

    private var transcriptLine: String {
        if speech.state == .finishing { return "Sending…" }
        return speech.transcript.isEmpty ? "Listening… tap to send" : speech.transcript
    }
}

// MARK: - Detail sheet

/// A brief opened from the list: the stacked, scrollable reading view —
/// the same presentation vocabulary as the document inspector, dismissed
/// by swiping down. Hosts its own `NavigationStack` so citation taps
/// push the document detail inside the sheet.
@available(iOS 17.0, *)
struct BriefDetailSheet: View {
    let brief: BriefRecord
    let store: AppStore
    var speech: SpeechRecognizer = .init()
    var openingThread: Bool = false
    var onTalkTapped: () -> Void = {}
    var onMicTapped: () -> Void = {}
    /// Bubbles the full dismiss-options confirmation up to the owner
    /// (reason, free-text feedback or nil, snoozeUntil or nil).
    var onConfirmDismiss: (BriefDismissReason, String?, Date?) -> Void = { _, _, _ in }
    /// Talk-back failure message, surfaced INSIDE the sheet — an alert
    /// bound below a presented sheet cannot present over it, so a failed
    /// "Ask the agent" would otherwise stop its spinner with zero
    /// feedback. The owner's copy of the alert still covers failures
    /// that land after the sheet closes.
    var talkError: Binding<String?> = .constant(nil)

    @State private var path: [BriefsRoute] = []
    @State private var showDismissOptions = false
    /// Preselected reason for the form sheet — "Pick a time…" routes
    /// there with Snooze already chosen so only the picker remains.
    @State private var dismissSheetInitialReason: BriefDismissReason?

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    if let eventDate = brief.eventAtDate {
                        Label(
                            eventDate.formatted(.relative(presentation: .named)),
                            systemImage: "clock"
                        )
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                    }
                    Text(brief.title)
                        .font(.system(size: 24, weight: .bold))
                        .foregroundStyle(Theme.textPrimary)
                    // The Cognition Steward writes markdown in the description
                    // (inline emphasis like **bold**); render it through
                    // the shared agent-text renderer so it shows as
                    // emphasis rather than literal asterisks. The title
                    // stays plain text.
                    MarkdownView(text: brief.description, bodyFont: .system(size: 17))
                    if let created = brief.createdAtDate {
                        Text(created.formatted(.relative(presentation: .named)))
                            .font(.footnote)
                            .foregroundStyle(Theme.textMuted)
                    }
                    actionBar
                        .padding(.top, Theme.Spacing.sm)
                    if speech.isListening || speech.state == .finishing {
                        // Live transcript while dictating — head-truncated
                        // so the words just spoken stay visible.
                        Text(speech.transcript.isEmpty ? "Listening…" : speech.transcript)
                            .font(.footnote)
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                            .frame(maxWidth: .infinity)
                            .frame(height: 20)
                            .accessibilityLabel("Dictation in progress")
                    }
                    if brief.body != nil || !brief.citations.isEmpty {
                        Divider()
                            .padding(.vertical, Theme.Spacing.sm)
                        BriefDetailsSection(
                            brief: brief,
                            store: store,
                            onOpenCitation: { citation in
                                path.append(
                                    .document(documentId: citation.docId, title: citation.title)
                                )
                            }
                        )
                        // BriefDetailsSection pads horizontally for its
                        // stories-era full-bleed home; the sheet's VStack
                        // already pads, so pull that back out.
                        .padding(.horizontal, -Theme.Spacing.xl)
                    }
                }
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.top, Theme.Spacing.xl)
                .padding(.bottom, Theme.Spacing.xl)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.bgPrimary)
            .navigationDestination(for: BriefsRoute.self) { route in
                switch route {
                case .document(let documentId, let title):
                    DocumentDetailView(documentId: documentId, presetTitle: title)
                }
            }
            .sheet(isPresented: $showDismissOptions) {
                BriefDismissSheet(
                    brief: brief,
                    initialReason: dismissSheetInitialReason
                ) { reason, feedback, snoozeUntil in
                    onConfirmDismiss(reason, feedback, snoozeUntil)
                }
            }
            .alert(
                "Couldn't open the conversation",
                isPresented: Binding(
                    get: { talkError.wrappedValue != nil },
                    set: { if !$0 { talkError.wrappedValue = nil } }
                )
            ) {
                Button("OK", role: .cancel) { talkError.wrappedValue = nil }
            } message: {
                Text(talkError.wrappedValue ?? "")
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .devTarget(.brief(brief.id, label: brief.title))
    }

    /// The brief's actions — dictate, talk-back, options — as the same
    /// discreet centered glass circles the feed cards carried. The third
    /// circle is a MENU, not an ✕: inside a sheet an ✕ reads as "close
    /// this view", so the dismissal reasons are spelled out in words.
    private var actionBar: some View {
        HStack(spacing: Theme.Spacing.lg) {
            GlassMicButton(speech: speech, subjectLabel: "this brief", action: onMicTapped)
            GlassActionIconButton(
                systemImage: "text.bubble",
                accessibilityLabel: "Ask the agent about this brief",
                busy: openingThread,
                action: onTalkTapped
            )
            // Also disabled while dictation is active: a talk-tap racing
            // the dictation hand-off would open the thread WITHOUT the
            // transcript and the spoken question would silently vanish.
            .disabled(openingThread || speech.state == .listening || speech.state == .finishing)
            optionsMenu
        }
        .frame(maxWidth: .infinity)
    }

    /// Every dismissal reason, named, one tap away. Snooze carries its
    /// re-surface choices as a submenu; "Pick a time…" and "Add a note…"
    /// route to the form sheet (a date picker / free text need real UI).
    private var optionsMenu: some View {
        Menu {
            Button {
                onConfirmDismiss(brief.kind.clearActionReason, nil, nil)
            } label: {
                Label(brief.kind.clearActionLabel, systemImage: "checkmark")
            }
            Menu {
                Button("Later today") { snooze(.laterToday) }
                Button("Tomorrow") { snooze(.tomorrow) }
                Button("Pick a time…") {
                    dismissSheetInitialReason = .snoozed
                    showDismissOptions = true
                }
                Button("Let the agent decide") { snooze(.agentDecides) }
            } label: {
                Label("Snooze", systemImage: "clock")
            }
            Button {
                onConfirmDismiss(.notRelevant, nil, nil)
            } label: {
                Label("Not relevant", systemImage: "hand.thumbsdown")
            }
            Button {
                onConfirmDismiss(.wrong, nil, nil)
            } label: {
                Label("Wrong", systemImage: "exclamationmark.triangle")
            }
            Divider()
            Button {
                dismissSheetInitialReason = nil
                showDismissOptions = true
            } label: {
                Label("Add a note…", systemImage: "square.and.pencil")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.textPrimary.opacity(0.8))
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .modifier(GlassActionCircle())
        .accessibilityLabel("Brief options")
    }

    private func snooze(_ choice: BriefSnoozeChoice) {
        onConfirmDismiss(.snoozed, nil, choice.resolvedTime(now: Date()))
    }
}

/// Route pushed inside the detail sheet when the user taps a citation
/// at the bottom of a brief's long-form body. The title shows
/// immediately while `DocumentDetailView` fetches the full document.
@available(iOS 17.0, *)
enum BriefsRoute: Hashable {
    case document(documentId: String, title: String)
}

// MARK: - Long-form details

/// The long-form half of a brief: the body ending in tappable
/// citations. Its own view (rather than a private section of
/// `BriefDetailSheet`) so snapshots verify it directly.
@available(iOS 17.0, *)
struct BriefDetailsSection: View {
    let brief: BriefRecord
    let store: AppStore
    let onOpenCitation: (BriefCitation) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            if let body = brief.body {
                // Long-form context often carries markdown (lists, links,
                // inline emphasis); render it through the shared agent-text
                // renderer, matching the description above and the agent
                // conversation. MarkdownView already fills the width.
                MarkdownView(text: body, bodyFont: .system(size: 15))
            }
            if !brief.citations.isEmpty {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    Text("Sources")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                    ForEach(brief.citations) { citation in
                        Button {
                            onOpenCitation(citation)
                        } label: {
                            HStack(spacing: 10) {
                                SourceIconView(sourceId: citation.sourceId, store: store)
                                Text(citation.title)
                                    .font(.system(size: 14))
                                    .foregroundStyle(Theme.textPrimary)
                                    .lineLimit(2)
                                    .multilineTextAlignment(.leading)
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Theme.textMuted)
                            }
                            .padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.horizontal, Theme.Spacing.xl)
        .padding(.bottom, Theme.Spacing.xl)
    }
}

// MARK: - Empty state

/// The feed's goal state: nothing needs you right now. It is explicitly
/// OK for the feed to end — never padded with filler.
///
/// Rendered inside a `ScrollView` whose content is forced to fill the
/// viewport (so the message stays visually centered) precisely so
/// pull-to-refresh works here too — `.refreshable` only attaches to a
/// scrollable container, and this empty screen is exactly when the user
/// instinctively pulls down to check for new briefs.
@available(iOS 17.0, *)
private struct EmptyBriefsView: View {
    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: Theme.Spacing.md) {
                    Image(systemName: "checkmark.circle")
                        .font(.largeTitle)
                        .foregroundStyle(Theme.textMuted)
                    Text("No briefs to show")
                        .font(.headline)
                        .foregroundStyle(Theme.textPrimary)
                    Text("Nothing needs you right now. New briefs appear here when something deserves your attention.")
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, Theme.Spacing.lg)
                }
                .frame(minWidth: geo.size.width, minHeight: geo.size.height)
            }
        }
        .background(Theme.bgPrimary)
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("BriefsListContent — populated") {
    NavigationStack {
        BriefsListContent(
            feed: BriefsFeedState(briefs: PreviewMocks.briefs),
            loading: false,
            loadError: nil,
            onOpen: { _ in },
            onQuickClear: { _ in },
            onAsk: { _ in },
            onMoreOptions: { _ in },
            onRetry: {},
            onRefresh: {}
        )
        .navigationTitle("Briefs")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BriefsListContent — background agent needs attention") {
    NavigationStack {
        BriefsListContent(
            feed: BriefsFeedState(briefs: PreviewMocks.briefs),
            loading: false,
            loadError: nil,
            onOpen: { _ in },
            onQuickClear: { _ in },
            onAsk: { _ in },
            onMoreOptions: { _ in },
            onRetry: {},
            onRefresh: {},
            showsModelWarning: true
        )
        .navigationTitle("Briefs")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BriefsListContent — empty, background agent needs attention") {
    NavigationStack {
        BriefsListContent(
            feed: BriefsFeedState(briefs: []),
            loading: false,
            loadError: nil,
            onOpen: { _ in },
            onQuickClear: { _ in },
            onAsk: { _ in },
            onMoreOptions: { _ in },
            onRetry: {},
            onRefresh: {},
            showsModelWarning: true
        )
        .navigationTitle("Briefs")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BriefsListContent — row dictating") {
    NavigationStack {
        BriefsListContent(
            feed: BriefsFeedState(briefs: PreviewMocks.briefs),
            loading: false,
            loadError: nil,
            onOpen: { _ in },
            onQuickClear: { _ in },
            onAsk: { _ in },
            onDictate: { _ in },
            onMoreOptions: { _ in },
            speech: SpeechRecognizer.preview(
                state: .listening,
                transcript: "Push the reminder to Friday and tell Maya I confirmed"
            ),
            dictatingBriefId: PreviewMocks.briefs.first?.id,
            onRetry: {},
            onRefresh: {}
        )
        .navigationTitle("Briefs")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BriefsListContent — empty") {
    NavigationStack {
        BriefsListContent(
            feed: BriefsFeedState(briefs: []),
            loading: false,
            loadError: nil,
            onOpen: { _ in },
            onQuickClear: { _ in },
            onAsk: { _ in },
            onMoreOptions: { _ in },
            onRetry: {},
            onRefresh: {}
        )
        .navigationTitle("Briefs")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BriefsListContent — error") {
    NavigationStack {
        BriefsListContent(
            feed: BriefsFeedState(briefs: []),
            loading: false,
            loadError: URLError(.cannotConnectToHost),
            onOpen: { _ in },
            onQuickClear: { _ in },
            onAsk: { _ in },
            onMoreOptions: { _ in },
            onRetry: {},
            onRefresh: {}
        )
        .navigationTitle("Briefs")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BriefDetailSheet — loop brief") {
    Color.black.sheet(isPresented: .constant(true)) {
        BriefDetailSheet(
            brief: PreviewMocks.briefLoop,
            store: AppStore.preview(sources: PreviewMocks.sources)
        )
        .environment(AppStore.preview(sources: PreviewMocks.sources))
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BriefDetailSheet — health trend") {
    Color.black.sheet(isPresented: .constant(true)) {
        BriefDetailSheet(
            brief: PreviewMocks.briefHealthRecovery,
            store: AppStore.preview(sources: PreviewMocks.sources)
        )
        .environment(AppStore.preview(sources: PreviewMocks.sources))
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("BriefDetailSheet — dictating") {
    Color.black.sheet(isPresented: .constant(true)) {
        BriefDetailSheet(
            brief: PreviewMocks.briefInfo,
            store: AppStore.preview(sources: PreviewMocks.sources),
            speech: SpeechRecognizer.preview(
                state: .listening,
                transcript: "Push the reminder to Friday and tell Maya I confirmed"
            )
        )
        .environment(AppStore.preview(sources: PreviewMocks.sources))
    }
    .preferredColorScheme(.dark)
}
#endif
#endif
