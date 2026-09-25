// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

struct ConversationDeletionConfirmation {
    private(set) var conversationId: String?
    private(set) var isPresented = false

    mutating func present(conversationId: String) {
        self.conversationId = conversationId
        isPresented = true
    }

    /// SwiftUI may dismiss a confirmation dialog before invoking its selected
    /// action. Keep the target until the action explicitly confirms or cancels.
    mutating func dismissPresentation() {
        isPresented = false
    }

    mutating func takeConfirmedConversationId() -> String? {
        defer {
            conversationId = nil
            isPresented = false
        }
        return conversationId
    }

    mutating func cancel() {
        conversationId = nil
        isPresented = false
    }
}

#if canImport(SwiftUI) && canImport(UIKit)
import Speech
import SwiftUI

/// Main agent chat surface. Mirrors the portal's `/portal/agent` view:
///
///   - Title bar with a leading menu button (opens the global side
///     drawer) and a trailing "new conversation" button.
///   - Scrolling conversation of user / assistant turns with inline
///     tool calls and their structured results (search cards, SQL
///     tables, provenance trails, doc cards, person chips).
///   - Pinned composer with send / cancel.
///
/// `HomeView` owns `menuOpen` and hosts the menu beneath the app through
/// `MenuRevealContainer`, so the menu is reachable from every section, not
/// just this one.
@available(iOS 17.0, *)
public struct AgentView: View {
    @Environment(AppStore.self) private var store
    /// Optional so surfaces that render AgentView without a router in
    /// the environment (previews, snapshot renders) keep working; the
    /// live app injects one at the root.
    @Environment(NotificationRouter.self) private var router: NotificationRouter?
    @State private var composerText: String = {
        #if DEBUG
        // XCUITest demo automation: pre-fill the composer with a prompt
        // passed via the DEMO_PROMPT environment variable so the test
        // can skip slow keyboard interaction.
        if let prompt = ProcessInfo.processInfo.environment["DEMO_PROMPT"] {
            return prompt
        }
        #endif
        return ""
    }()

    @State private var scrollToBottomTrigger: Int = 0
    @State private var bottomAnchorMinY: CGFloat = 0
    @State private var scrollViewHeight: CGFloat = 0
    /// Whether the transcript should follow its latest message. Starts true
    /// so a conversation opens at the bottom; flips false when the user
    /// scrolls up to read, and back to true when they return to the bottom
    /// (or tap the chevron / switch conversations). Drives the reactive
    /// `BottomStickController`.
    @State private var stickToBottom: Bool = true
    @State private var prependScrollTarget: TranscriptPrependScrollTarget?
    @State private var transcriptPagingInteractionArmed = false
    @State private var transcriptRowFrames: [String: CGRect] = [:]
    /// Global-space Y of the composer's top edge, resolved from the
    /// composer's anchor preference. Anchors the transcript's bottom
    /// fade mask to the floating composer rather than to the scrolling
    /// content, so messages dissolve as they approach the composer and
    /// recover full opacity as they scroll back up. See
    /// `transcriptFadeMask`.
    @State private var composerTopY: CGFloat = 0
    @State private var citationsOpen: Bool = false
    /// Resolved adaptive layout for the current container size. `.overlay`
    /// on iPhone and iPad-portrait (the Timeline drawer slides over the
    /// conversation); `.sidePanel` on iPad-landscape (the Timeline docks
    /// as a ~⅓-width column and the conversation shrinks beside it).
    /// Updated from `sizeProbe`. Gated by `AgentLayout` — flip
    /// `AgentLayout.iPadSplitEnabled` to revert to overlay everywhere.
    @State private var layoutMode: AgentLayoutMode = .overlay
    /// Width of the container, used to size the docked side panel.
    @State private var availableWidth: CGFloat = 0
    /// True while a sticky tab or the overflow pill currently renders
    /// inside the composer's bottom band. Published by
    /// `CitationsDrawer` via `ComposerNeedsGutterKey`; controls whether
    /// the composer pill leaves a right-side gutter for those tabs or
    /// spans the full screen width. False whenever no tabs occupy the
    /// composer's height — most short citation lists.
    @State private var composerNeedsGutter: Bool = false
    @State private var speechRecognizer = SpeechRecognizer()
    /// Owns the exact conversation selected for destructive confirmation and
    /// preserves it across SwiftUI's dialog-dismissal callback ordering.
    @State private var conversationDeletion = ConversationDeletionConfirmation()
    @Binding var menuOpen: Bool
    @FocusState private var composerFocused: Bool
    /// Monotonic HomeView request used by the one-hour foreground policy.
    /// Passing the value into a newly-mounted AgentView also covers a cold
    /// switch from another section; observing changes covers an already-open
    /// transcript.
    private let composerFocusRequest: Int

    public init(menuOpen: Binding<Bool>, composerFocusRequest: Int = 0) {
        self._menuOpen = menuOpen
        self.composerFocusRequest = composerFocusRequest
    }

    #if DEBUG
    /// Test-only initialiser that seeds the adaptive-layout state so
    /// snapshot tests can capture the iPad-landscape split
    /// deterministically. Production derives `layoutMode` / `availableWidth`
    /// from the geometry probe and `citationsOpen` from user gestures or
    /// the demo auto-pilot — none of which run inside a synchronous
    /// snapshot render — so the tests inject the resolved state directly.
    init(
        menuOpen: Binding<Bool>,
        previewLayoutMode: AgentLayoutMode,
        previewCitationsOpen: Bool,
        previewWidth: CGFloat
    ) {
        self._menuOpen = menuOpen
        self._layoutMode = State(initialValue: previewLayoutMode)
        self._citationsOpen = State(initialValue: previewCitationsOpen)
        self._availableWidth = State(initialValue: previewWidth)
        self.composerFocusRequest = 0
    }
    #endif

    /// How many points past the visible viewport's bottom edge the
    /// bottom-of-content sentinel must sit before the floating
    /// scroll-to-bottom chevron appears. The number has to cover two
    /// things at once:
    ///
    ///   - The 140pt trailing spacer that clears the composer. It
    ///     sits between the last message and the sentinel (the
    ///     sentinel is outside the LazyVStack — see `transcript`), so
    ///     when the user perceives themselves as "at the bottom" (the
    ///     last message is visible at the bottom of the viewport,
    ///     with the composer pill floating over what would be the
    ///     empty spacer strip), the sentinel still sits 140pt below
    ///     the viewport. Without this offset baked in, the chevron
    ///     would show at the user-perceived bottom.
    ///
    ///   - A small elastic-bounce buffer (~40pt) so a finger lift,
    ///     spring deceleration, or trackpad inertia doesn't flicker
    ///     the chevron in and out on every micro-scroll.
    ///
    /// The chevron appears once the user has scrolled up MORE than
    /// 40pt past the user-perceived bottom, which is the natural
    /// trigger ("I lost sight of the latest reply — give me a way
    /// back").
    private static let bottomThreshold: CGFloat = 180
    /// Vertical inset below the scroll-to-bottom button — leaves a
    /// small gap above the composer pill so the chevron reads as paired
    /// with the input rather than floating in the middle of the screen.
    private static let scrollToBottomBottomInset: CGFloat = 93
    /// Coordinate space named on the transcript ScrollView so the
    /// bottom-anchor's frame can be measured relative to the visible
    /// viewport.
    private static let scrollSpace = "agent.scroll"

    /// Trailing gutter reserved for the drawer's sticky tabs when
    /// the drawer is closed. Read by `transcript` (applied to the
    /// LazyVStack's inner padding so the ScrollView itself stays
    /// full-width and the system scroll indicator sits at the screen
    /// edge), by the top fade strip, and by the top floating buttons.
    /// Zero until the agent has either built a trail or recorded an
    /// annotation — at that point the unified Timeline has at least
    /// one row and we reserve the gutter so the tabs have room.
    private var citationGutter: CGFloat {
        // The gutter reserves room for the closed-drawer sticky tabs,
        // which only exist in overlay mode. In `sidePanel` mode the
        // Timeline is a separate column, so the conversation needs no
        // trailing reserve.
        guard layoutMode == .overlay else { return 0 }
        let hasTimelineContent = !store.agent.trailAnnotations.byDoc.isEmpty
            || !store.agent.recordCitations.isEmpty
        return hasTimelineContent ? CitationsDrawer.closedTabGutterWidth : 0
    }

    /// Trailing gutter applied to the bottom bar (composer + plan
    /// panel + scroll-to-bottom chevron). Only kicks in when a tab
    /// or the overflow pill currently overlaps the composer's
    /// vertical band — otherwise the composer spans the full screen
    /// width even with citations present.
    private var composerGutter: CGFloat {
        composerNeedsGutter ? citationGutter : 0
    }

    public var body: some View {
        Group {
            switch layoutMode {
            case .overlay: overlayBody
            case .sidePanel: sidePanelBody
            }
        }
        // Measure the container and resolve the adaptive layout. Lives in
        // a background probe (not a wrapping GeometryReader) so the
        // overlay hierarchy is byte-for-byte the iPhone layout — zero
        // risk of perturbing it — and the side-panel branch only engages
        // once the probe reports an iPad-landscape size.
        .background(sizeProbe)
        .omnesisColorScheme()
        #if DEBUG
            .demoAutoPilot(composerText: $composerText, citationsOpen: $citationsOpen)
        #endif
            .onPreferenceChange(ComposerNeedsGutterKey.self) { value in
                // Mirror the drawer's bottom-band signal into local state.
                // The composer's `.padding(.trailing, composerGutter)` reads
                // `composerNeedsGutter` and animates the change via the
                // `.animation(_:value:)` modifier on the bottom overlay.
                composerNeedsGutter = value
            }
            // iPad-landscape only: reveal the docked Timeline the instant
            // the agent emits its first citation, so the split shows off
            // both panes on its own (great for demos, and sensible — new
            // evidence just appeared and there's room to show it).
            .onChange(of: timelineHasContent) { _, hasContent in
                if hasContent { autoRevealTimelineIfNeeded() }
            }
            // Shake-to-annotate targets the open conversation (developer mode).
            // Nil in the hero/new-conversation state → shake files a free-form note.
            .devConversationTarget(store.agent.sessionId, title: store.agent.title)
            // An `agent-answer` push tap lands here once HomeView flips
            // the section to Agent: open the finished conversation. The
            // onAppear arm covers the cold-start path, where the target
            // is set before this view first renders.
            .onChange(of: router?.pendingTarget) { _, target in
                if target != nil { consumeRouterTarget() }
            }
            .onAppear {
                consumeRouterTarget()
                // This surface is the only thing that knows the transcript is
                // actually rendered. The coordinator's session id outlives a
                // move to Search or Settings, and a headless resume has no
                // surface at all, so neither may claim the conversation is
                // being read.
                store.agent.agentSurfaceVisibilityChanged(true)
                applyComposerFocusRequest()
            }
            .onDisappear { store.agent.agentSurfaceVisibilityChanged(false) }
            .onChange(of: composerFocusRequest) { _, _ in
                applyComposerFocusRequest()
            }
            .alert(
                cancelFailureKind.title,
                isPresented: cancelFailurePresented
            ) {
                if store.agent.busy {
                    Button("Try again") {
                        Task { await store.agent.cancelTurn() }
                    }
                }
                Button("Dismiss", role: .cancel) {
                    store.agent.dismissCancelError()
                }
            } message: {
                Text(cancelFailureKind.detail(for: "stop the agent"))
            }
    }

    private var cancelFailureKind: GatewayErrorView.Kind {
        GatewayErrorView.classify(store.agent.cancelError)
    }

    private var cancelFailurePresented: Binding<Bool> {
        Binding(
            get: { store.agent.cancelError != nil },
            set: { presented in
                if !presented { store.agent.dismissCancelError() }
            }
        )
    }

    private var conversationDeletionPresented: Binding<Bool> {
        Binding(
            get: { conversationDeletion.isPresented },
            set: { presented in
                if !presented { conversationDeletion.dismissPresentation() }
            }
        )
    }

    private var conversationActionFailureKind: GatewayErrorView.Kind {
        GatewayErrorView.classify(store.agent.conversationActionError)
    }

    private var conversationActionFailurePresented: Binding<Bool> {
        Binding(
            get: {
                store.agent.conversationActionError != nil
                    && store.agent.conversationActionErrorSessionId == store.agent.sessionId
            },
            set: { presented in
                if !presented { store.agent.clearConversationActionError() }
            }
        )
    }

    /// Resume the conversation an `agent-answer` push points at. Other
    /// target kinds are left pending for their own sections to consume.
    private func consumeRouterTarget() {
        guard let router, case .agentAnswer(let conversationId) = router.pendingTarget else { return }
        router.consume()
        Task { await store.agent.resumeConversation(id: conversationId) }
    }

    private func applyComposerFocusRequest() {
        let requestedFocus = composerFocusRequest
        guard AgentComposerForegroundFocusPolicy.shouldFocus(
            request: requestedFocus,
            sessionId: store.agent.sessionId,
            canCompose: store.agent.canComposeMessage
        ) else { return }
        composerText = ""
        // Focus after the fresh AgentView/composer has joined the hierarchy;
        // a synchronous assignment during the tab switch is ignored by UIKit.
        Task { @MainActor in
            await Task.yield()
            guard AgentComposerForegroundFocusPolicy.shouldFocus(
                request: composerFocusRequest,
                sessionId: store.agent.sessionId,
                canCompose: store.agent.canComposeMessage
            ), composerFocusRequest == requestedFocus else { return }
            composerFocused = true
        }
    }

    /// Whether the Timeline currently has any content — an annotated
    /// document or a directly-cited record.
    private var timelineHasContent: Bool {
        !store.agent.trailAnnotations.byDoc.isEmpty || !store.agent.recordCitations.isEmpty
    }

    /// On iPad landscape (`sidePanel`), open the docked Timeline
    /// automatically once content exists. Only ever opens — never
    /// auto-closes — and within a conversation the content→non-empty
    /// transition fires once, so a user who dismisses it isn't fought on
    /// every subsequent citation. A no-op in overlay mode, so iPhone and
    /// iPad-portrait behaviour is unchanged.
    private func autoRevealTimelineIfNeeded() {
        guard layoutMode == .sidePanel, timelineHasContent, !citationsOpen else { return }
        withAnimation(CitationsDrawer.openCloseAnimation) {
            citationsOpen = true
        }
    }

    /// Invisible geometry probe that reports the container size into
    /// `layoutMode` / `availableWidth`. On first paint `layoutMode`
    /// starts `.overlay`; if the container is iPad-landscape the probe
    /// flips it to `.sidePanel`. Because a *closed* drawer looks
    /// identical in both modes (just the full-width conversation), there
    /// is no visible transient — the split only manifests once the
    /// Timeline is opened.
    private var sizeProbe: some View {
        GeometryReader { geo in
            Color.clear
                .onAppear { applyLayout(for: geo.size) }
                .onChange(of: geo.size) { _, newSize in applyLayout(for: newSize) }
        }
    }

    private func applyLayout(for size: CGSize) {
        availableWidth = size.width
        let newMode = AgentLayout.mode(for: size)
        if newMode != layoutMode {
            layoutMode = newMode
            // Rotating into the split with citations already present
            // reveals the Timeline so the landscape layout shows both
            // panes immediately.
            if newMode == .sidePanel { autoRevealTimelineIfNeeded() }
        }
    }

    /// iPhone / iPad-portrait presentation: the conversation fills the
    /// screen and the Timeline drawer slides in over it from the trailing
    /// edge, on top of a dimming scrim.
    private var overlayBody: some View {
        ZStack {
            conversationStack
            // Right-edge swipe zone. Pulling left from the trailing 20pt
            // strip opens the Timeline drawer.
            HStack {
                Spacer()
                swipeOpenStrip
            }
            CitationsDrawer(
                trailAnnotations: store.agent.trailAnnotations,
                recordCitations: store.agent.recordCitations,
                isOpen: $citationsOpen
            )
        }
    }

    /// iPad-landscape presentation: a true split. The conversation takes
    /// the leading majority of the width and the Timeline docks as a
    /// fixed ~⅓-width column on the trailing edge. Opening the Timeline
    /// (via the right-edge swipe, a citation chip, or the demo
    /// auto-pilot) inserts the column and reflows the conversation
    /// narrower — "the text shrinks to give way" — so both are legible
    /// at once. All open/close toggles run inside
    /// `CitationsDrawer.openCloseAnimation`, which animates the
    /// insertion-transition and the conversation's reflow together.
    private var sidePanelBody: some View {
        let panelWidth = AgentLayout.sidePanelWidth(forTotalWidth: availableWidth)
        return ZStack(alignment: .trailing) {
            HStack(spacing: 0) {
                conversationStack
                if citationsOpen {
                    CitationsDrawer(
                        trailAnnotations: store.agent.trailAnnotations,
                        recordCitations: store.agent.recordCitations,
                        isOpen: $citationsOpen,
                        presentation: .docked
                    )
                    .frame(width: panelWidth)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            // Right-edge swipe to open, only while the column is closed
            // (when open, the docked drawer's × button closes it).
            if !citationsOpen {
                HStack {
                    Spacer()
                    swipeOpenStrip
                }
            }
        }
    }

    /// Trailing 20pt strip whose leftward swipe opens the Timeline.
    /// Mirrored onto each sticky tab in overlay mode via
    /// `.simultaneousGesture`. Disabled while the drawer is already open
    /// so it doesn't fight the drawer's own drag-to-close gesture.
    private var swipeOpenStrip: some View {
        Color.clear
            .frame(width: 20)
            .contentShape(Rectangle())
            .gesture(
                CitationsDrawer.openSwipeGesture {
                    withAnimation(CitationsDrawer.openCloseAnimation) {
                        citationsOpen = true
                    }
                }
            )
            .allowsHitTesting(!citationsOpen)
            .ignoresSafeArea(edges: .vertical)
    }

    private var conversationStack: some View {
        NavigationStack {
            // Layered front-to-back:
            //   1. `content` (transcript / empty / fatal) fills the
            //      view edge-to-edge — there is no navigation bar.
            //      The transcript ScrollView itself spans the full
            //      width; only its inner LazyVStack is padded by
            //      `citationGutter` on the trailing side, so the
            //      system scroll indicator sits at the screen's
            //      right edge (visually behind any sticky tabs).
            //   2. Bottom bar overlay (plan + composer pill)
            //      pinned to the bottom; the scroll-to-bottom
            //      floating chevron sits above the pill when the
            //      user has scrolled off the latest message. Its
            //      trailing gutter (`composerGutter`) is applied
            //      only while a tab or the overflow pill renders
            //      inside the composer's vertical band — short
            //      citation lists let the composer span the full
            //      width.
            //   3. Top fade strip — solid `bgPrimary` at the
            //      phone's top edge, fading to transparent ~90pt
            //      below; transcript scrolling up dissolves into
            //      it.
            //   4. Floating top buttons (menu + new conversation)
            //      sit on top of the fade strip in the area where
            //      a nav bar used to be.
            ZStack(alignment: .top) {
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.bgPrimary.ignoresSafeArea())
                    .overlay(alignment: .bottom) {
                        ZStack(alignment: .bottom) {
                            bottomBar
                            if showScrollToBottom {
                                scrollToBottomFloatingButton
                                    .padding(.bottom, Self.scrollToBottomBottomInset)
                                    .transition(.scale(scale: 0.7).combined(with: .opacity))
                            }
                        }
                        .padding(.trailing, composerGutter)
                        .animation(.spring(response: 0.32, dampingFraction: 0.78), value: showScrollToBottom)
                        .animation(.easeInOut(duration: 0.22), value: composerNeedsGutter)
                    }

                if !showsLanding {
                    topFadeStrip
                        .padding(.trailing, citationGutter)
                }

                topButtonsOverlay
                    .padding(.trailing, citationGutter)
            }
            .overlayPreferenceValue(ComposerBoundsKey.self) { anchor in
                GeometryReader { proxy in
                    // Composer top edge in global space: the proxy's own
                    // global origin plus the anchored rect's local minY.
                    let top = proxy.frame(in: .global).minY
                        + (anchor.map { proxy[$0].minY } ?? 0)
                    Color.clear
                        .onAppear { composerTopY = top }
                        .onChange(of: top) { _, newTop in composerTopY = newTop }
                }
                .allowsHitTesting(false)
            }
            .toolbar(.hidden, for: .navigationBar)
            .omnesisColorScheme()
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 0) {
            // Pinned TODO panel — populated while the agent is working
            // through a multi-step plan, collapses to zero height once
            // every item has been auto-removed. Solid backdrop so
            // transcript text doesn't show through the gaps between
            // rows when the panel sits over the otherwise-transparent
            // floating-pill strip.
            AgentPlanPanel(items: store.agent.planItems)
                .background(Theme.bgPrimary)

            Group {
                if store.agent.terminalFailure != nil {
                    ContextWindowExceededCard {
                        composerText = ""
                        composerFocused = false
                        store.agent.newConversation()
                    }
                } else if let reason = store.agent.liveSessionMissingReason {
                    // The transcript above came from storage because no session
                    // could be minted. Take the composer's place rather than
                    // greying it out: a disabled input invites tapping and
                    // says nothing about why it will not answer.
                    ReadOnlyConversationCard(reason: reason) {
                        Task { await store.agent.retryLiveSession() }
                    }
                } else {
                    AgentComposer(
                        text: $composerText,
                        busy: store.agent.busy,
                        disabled: !store.agent.canComposeMessage,
                        experimentalEnabled: store.experimentalEnabled,
                        speech: speechRecognizer,
                        onSend: { text, command in
                            composerText = ""
                            // Surrender keyboard focus the moment the user
                            // hits send so the transcript reclaims its full
                            // screen real estate.
                            composerFocused = false
                            let deep = command?.deepResearch ?? false
                            Task {
                                let sent = await store.agent.send(text: text, deepResearch: deep)
                                // A rejected turn (a failed lazy mint or refused POST)
                                // never reached the gateway — restore
                                // the text so the user can retry instead of silently
                                // losing what they typed. Skip if they've already
                                // started a new message.
                                if !sent, composerText.isEmpty { composerText = text }
                            }
                        },
                        onCancel: {
                            Task {
                                if let restored = await store.agent.cancelTurn(),
                                   composerText.isEmpty {
                                    composerText = restored
                                }
                            }
                        },
                        focused: $composerFocused
                    )
                }
            }
            // Publish the composer's bounds so the transcript's bottom
            // fade mask can anchor its opaque→faded ramp to the composer
            // top (5pt above that edge stays fully opaque). An ANCHOR
            // preference is a direct modifier (not a `.background`/
            // `.overlay` layer), so it propagates up the tree — including
            // across the `.overlay` that hosts the composer — whereas a
            // background-hosted GeometryReader preference is silently
            // dropped here. Resolved in `conversationStack`.
            .anchorPreference(key: ComposerBoundsKey.self, value: .bounds) { $0 }
        }
        // Animate the working-set surface in/out so it slides up on the first
        // researcher and collapses into the report when the run ends.
        .animation(.easeInOut(duration: 0.28), value: store.agent.isResearchWorkspaceActive)
        // No backdrop below the composer pill — the area between the
        // pill's bottom edge and the phone's home-indicator stays
        // transparent so the transcript scrolls visibly through it,
        // matching the ChatGPT-style floating-input layout.
    }

    @ViewBuilder
    private var content: some View {
        if let fatal = store.agent.fatalError {
            GatewayErrorView(
                context: "start the agent",
                error: fatal,
                onRetry: { Task { await store.agent.retry() } }
            )
        } else if store.agent.transcriptLoading {
            // A resumed conversation whose transcript is still loading. The
            // surface already switched to the target (id + title); show a
            // skeleton until the messages land instead of the previous
            // conversation or a blank empty state.
            AgentTranscriptSkeleton()
        } else if showsLanding {
            // A freshly opened thread with an origin (brief talk-back or a
            // watch firing) has no visible turns (the
            // seeded transcript is hidden) but must show its context card,
            // not the generic empty state — so it renders the transcript
            // branch.
            emptyState
        } else {
            transcript
        }
    }

    /// Whether `content` is showing the landing screen rather than a transcript,
    /// a skeleton or an error. Read by the top fade strip, which exists to
    /// dissolve transcript text scrolling under the status bar and has nothing
    /// to dissolve here — leaving it up would slab flat `bgPrimary` across the
    /// landing backdrop's gradient.
    private var showsLanding: Bool {
        store.agent.fatalError == nil
            && !store.agent.transcriptLoading
            && store.agent.turns.isEmpty
            && store.agent.terminalFailure == nil
            && store.agent.briefOrigin.map(AgentCoordinator.hasContextCard) != true
    }

    /// Where the mark's centre sits, as a fraction of the usable height.
    private static let landingMarkCentreY: CGFloat = 0.44

    /// The mark's frame. Larger than the ~88pt the mark should *read* as,
    /// because the vector carries about 12% padding inside its square viewBox —
    /// the frame is the box, not the artwork.
    private static let landingMarkBox: CGFloat = 124

    /// Half the band the headline occupies below the mark (spacing + one line).
    /// `.position` anchors a view's centre, so this is what shifts the anchor
    /// from the block's centre to the mark's.
    private static let landingHeadlineHalfBand: CGFloat = 24

    /// The landing screen: the mark, one line of copy, and nothing else.
    ///
    /// The block is positioned rather than centred so the mark lands at
    /// `landingMarkCentreY` with the headline hanging below it, which is what
    /// keeps the composition weighted above the composer instead of colliding
    /// with it. `.position` takes the block's centre, so the anchor is offset by
    /// half the headline's band to put the *mark's* centre on the mark.
    private var emptyState: some View {
        GeometryReader { proxy in
            VStack(spacing: 22) {
                OmnesisMarkGlyph(width: Self.landingMarkBox)
                Text("Ask Omnesis about your corpus")
                    .font(.system(size: 21, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 28)
            }
            .frame(maxWidth: .infinity)
            .position(
                x: proxy.size.width / 2,
                y: proxy.size.height * Self.landingMarkCentreY + Self.landingHeadlineHalfBand
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The backdrop ignores the safe area, so its unit space is the whole
        // screen while the mark is placed within the usable height — the halo's
        // centre is nudged down to compensate rather than reusing the fraction.
        .background(LandingBackdrop(focusY: Self.landingMarkCentreY + 0.02))
    }

    /// Whether the transcript's turn-level working dots are eligible to show.
    /// The rule lives on the coordinator (`workingIndicatorActive`) so it is
    /// unit-testable and so the batch-tool distinction stays a transcript-model
    /// fact rather than a layout one.
    private var agentWorkingActive: Bool {
        store.agent.workingIndicatorActive
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // A plain VStack — NOT LazyVStack — is load-bearing. A lazy
                // stack un-renders rows far from the viewport, so a
                // `scrollTo` that jumps to the bottom from far up lands on
                // rows that haven't been drawn yet and shows a blank page
                // until the user scrolls (the documented LazyVStack
                // "blank window" bug). Rendering every loaded turn eagerly
                // keeps the bottom drawn, so `scrollTo("__bottom__")` lands on
                // real content. The loaded set is bounded by the cursor pages
                // reached as the user scrolls toward the start.
                VStack(alignment: .leading, spacing: 14) {
                    // An anchored thread is a reply to a card, not a blank
                    // chat: pin the anchor's card above the messages. The
                    // folded run transcript that seeded the thread is
                    // hidden (see AgentCoordinator.visibleMessages) — this
                    // card carries that context for the reader instead.
                    if let snapshot = store.agent.briefOrigin?.brief {
                        BriefContextCard(snapshot: snapshot)
                    } else if let origin = store.agent.briefOrigin, let watch = origin.watch {
                        WatchFiringContextCard(snapshot: watch, watchId: origin.watchId)
                    }
                    ListPagingFooter(
                        state: store.agent.transcriptPaging,
                        label: "Load earlier messages",
                        loadingLabel: "Loading earlier messages…",
                        automaticLoadingEnabled: transcriptPagingInteractionArmed
                    ) {
                        let anchor = store.agent.turns.first?.id
                        let capturedAnchor = anchor.flatMap { id -> PagingPrependAnchor? in
                            guard let frame = transcriptRowFrames[id] else { return nil }
                            return PagingPrependAnchor(
                                id: id,
                                viewportOffset: frame.minY,
                                rowHeight: frame.height
                            )
                        }
                        let sessionId = store.agent.sessionId
                        // iOS 17 cannot infer that a manual scroll moved away
                        // from the bottom. Explicitly unstick before prepending
                        // so the turn-count observer does not snap the expanded
                        // transcript back to its latest message.
                        stickToBottom = false
                        Task {
                            guard await store.agent.loadOlderMessages(),
                                  let anchor,
                                  let sessionId,
                                  store.agent.sessionId == sessionId
                            else { return }
                            // Publish a target after the prepend so SwiftUI
                            // resolves it against the updated transcript stack.
                            prependScrollTarget = TranscriptPrependScrollTarget(
                                sessionId: sessionId,
                                anchor: capturedAnchor
                                    ?? PagingPrependAnchor(
                                        id: anchor,
                                        viewportOffset: 0,
                                        rowHeight: 0
                                    )
                            )
                        }
                    }
                    ForEach(store.agent.turns) { turn in
                        AgentTurnBubble(turn: turn)
                            .id(turn.id)
                            .pagingRowFrame(id: turn.id, in: Self.scrollSpace)
                    }

                    // Turn-level "still working" dots — the single indicator
                    // that doesn't depend on a specific transcript part
                    // existing, so it covers the beats the per-item cards
                    // structurally can't (finished text → next tool call,
                    // message.start → first delta, ephemeral card faded →
                    // successor pending). Debounced against `transcriptVersion`
                    // so it never flashes under actively streaming tokens.
                    AgentWorkingIndicator(
                        active: agentWorkingActive,
                        version: store.agent.transcriptVersion
                    )

                    // Bottom clearance for the floating composer pill + the
                    // home-indicator safe area, so the last message can
                    // scroll fully above the pill instead of resting behind
                    // it. The `__bottom__` sentinel just below it sits 140pt
                    // past the last message — the offset `bottomThreshold`
                    // is tuned around.
                    Color.clear.frame(height: 140)
                }
                // Leading padding is the standard transcript inset.
                // Trailing padding folds the citation-tab gutter into
                // the inner content so the ScrollView itself spans the
                // full screen width — that way the system scroll
                // indicator lands at the right edge (visually behind
                // the sticky tabs) instead of sitting awkwardly inset
                // to the left of them.
                .padding(.leading, Theme.Spacing.lg)
                .padding(.trailing, Theme.Spacing.lg + citationGutter)
                // Top padding clears the status-bar safe area + the
                // floating menu / new-conversation buttons that sit
                // over the scroll view. The ScrollView itself ignores
                // top safe area (see modifier below) so text can scroll
                // visibly through the status-bar zone — this padding
                // just keeps the first message from resting underneath
                // either the status bar or the toolbar buttons.
                .padding(.top, 108)

                // Bottom-of-content sentinel — two roles. (1) Scroll target
                // for every snap-to-bottom path (`proxy.scrollTo("__bottom__",
                // anchor: .bottom)`): being the very last element, aligning
                // it to the viewport bottom is the true max-scroll position,
                // so the snap can't stall short of the end. (2) Geometry
                // source for the floating chevron's visibility — its `minY`
                // in the ScrollView's local coordinate space is published via
                // `BottomAnchorKey`, and `showScrollToBottom` shows the
                // chevron once the user has scrolled away from the bottom by
                // more than `bottomThreshold` pt.
                Color.clear.frame(height: 1).id("__bottom__")
                    .background(
                        GeometryReader { p in
                            Color.clear.preference(
                                key: BottomAnchorKey.self,
                                value: p.frame(in: .named(Self.scrollSpace)).minY
                            )
                        }
                    )
            }
            .coordinateSpace(name: Self.scrollSpace)
            .onPagingRowFramesChange { transcriptRowFrames = $0 }
            .simultaneousGesture(
                DragGesture(minimumDistance: 4)
                    .onChanged { _ in transcriptPagingInteractionArmed = true }
            )
            // NOTE: deliberately NO `.defaultScrollAnchor`. With a LazyVStack
            // it anchors to ESTIMATED row heights and, on a freshly created
            // ScrollView (cold-launch resume), parks the scroll past the true
            // content end — a documented "blank window below the content"
            // failure. Bottom-positioning is instead reactive: see the
            // `onScrollGeometryChange` controller below, which re-aligns to
            // the real last element every time the content size changes and
            // therefore cannot overscroll.
            // Edge-to-edge transcript — text dissolves under the
            // status bar at the top and behind the floating composer
            // pill at the bottom, matching the ChatGPT-style full-bleed
            // chat surface.
            .ignoresSafeArea(.container, edges: [.top, .bottom])
            // Bottom fade: the alpha of the scrolling content itself
            // ramps down as it approaches the floating composer, so the
            // transcript dissolves into the area beneath the composer
            // instead of ending on a hard edge. Anchored to the viewport
            // (not the content), so messages fade as they scroll into the
            // band and recover full opacity as they scroll back up.
            //
            // The mask must span the same edge-to-edge bounds as the
            // ScrollView above — `.ignoresSafeArea` here is load-bearing:
            // without it the mask is sized to the safe-area-inset frame,
            // so content in the home-indicator strip below the composer
            // falls outside the mask and is clipped to zero alpha (a hard
            // truncation) instead of fading to ~40% at the screen edge.
            .mask(
                GeometryReader { proxy in
                    let frame = proxy.frame(in: .global)
                    transcriptFadeMask(height: frame.height, globalMinY: frame.minY)
                }
                .ignoresSafeArea(.container, edges: [.top, .bottom])
            )
            .background(
                GeometryReader { p in
                    Color.clear
                        .onAppear { scrollViewHeight = p.size.height }
                        .onChange(of: p.size.height) { _, n in scrollViewHeight = n }
                }
            )
            // Drag the transcript downward to dismiss the keyboard —
            // the native iOS gesture for "I'm done typing, give me my
            // screen back". `.interactively` lets the keyboard follow
            // the drag so the user can see what's underneath as they
            // pull down.
            .scrollDismissesKeyboard(.interactively)
            // Reactive bottom-stick controller (iOS 18+). This is the whole
            // positioning mechanism — one rule for every case (cold-launch
            // open, conversation switch, new turn, streaming token, lazy row
            // materialisation): whenever the CONTENT SIZE changes and we are
            // "stuck to the bottom", re-align to the `__bottom__` sentinel.
            //
            // Why this is correct by construction where the old approach was
            // not: `scrollTo` to the last element clamps to the real maximum
            // offset, so it cannot land past the content end (no blank page);
            // and because it re-fires on EVERY size change, it keeps settling
            // on the true bottom as the LazyVStack materialises its estimated
            // rows into real heights. A scroll that only changes the OFFSET
            // (the user dragging) instead updates whether we are still stuck:
            // drag away from the bottom and we stop following; return and we
            // resume.
            .modifier(BottomStickController(
                proxy: proxy,
                stick: $stickToBottom,
                turnsEmpty: store.agent.turns.isEmpty
            ))
            // Streaming token follow + new-turn / first-load follow on iOS 17
            // (where `onScrollGeometryChange` is unavailable) and as a belt
            // for the discrete events. Each only scrolls while stuck, and
            // `scrollTo` to the last element can't overscroll.
            .onChange(of: store.agent.turns.count) { _, _ in
                if stickToBottom { proxy.scrollTo("__bottom__", anchor: .bottom) }
            }
            .onChange(of: store.agent.transcriptVersion) { _, _ in
                guard store.agent.busy, stickToBottom else { return }
                proxy.scrollTo("__bottom__", anchor: .bottom)
            }
            // Switching conversations: re-arm stick so the newly opened
            // transcript follows down to its latest message.
            .onChange(of: store.agent.sessionId) { _, _ in
                prependScrollTarget = nil
                transcriptPagingInteractionArmed = false
                transcriptRowFrames = [:]
                stickToBottom = true
                proxy.scrollTo("__bottom__", anchor: .bottom)
            }
            .onChange(of: prependScrollTarget) { _, target in
                guard let target else { return }
                defer { prependScrollTarget = nil }
                guard target.sessionId == store.agent.sessionId else { return }
                proxy.scrollTo(
                    target.anchor.id,
                    anchor: UnitPoint(
                        x: 0.5,
                        y: pagingPrependRestorationUnitY(
                            target.anchor,
                            viewportHeight: scrollViewHeight
                        )
                    )
                )
            }
            .onChange(of: scrollToBottomTrigger) { _, _ in
                // Instant (not animated): an animated programmatic scroll
                // would stream offset changes through the stick controller
                // and transiently unstick mid-flight. The controller then
                // converges as rows materialise.
                stickToBottom = true
                proxy.scrollTo("__bottom__", anchor: .bottom)
            }
            .onAppear {
                if stickToBottom { proxy.scrollTo("__bottom__", anchor: .bottom) }
            }
            .onPreferenceChange(BottomAnchorKey.self) { minY in
                bottomAnchorMinY = minY
            }
        }
    }

    /// Vertical alpha gradient used as the transcript ScrollView's mask.
    /// Black (fully opaque content) from the top down to ~5pt above the
    /// composer's top edge, then a smooth linear ramp to 40% opacity at
    /// the viewport's bottom edge. Because `.mask` reads the alpha
    /// channel, this thins the conversation content itself — text,
    /// tables, images, markdown all fade equally — rather than laying a
    /// colored gradient over it. `globalMinY` is the masked view's top
    /// edge in global space; subtracting it from `composerTopY` (also
    /// global) converts the composer edge into a fraction of the mask
    /// height. Until the composer has reported its position the mask
    /// stays fully opaque so there's no first-frame flash.
    private func transcriptFadeMask(height: CGFloat, globalMinY: CGFloat) -> some View {
        let plateau: CGFloat
        if composerTopY > 0, height > 0 {
            let opaqueUntil = composerTopY - globalMinY - 5
            plateau = min(1, max(0, opaqueUntil / height))
        } else {
            plateau = 1
        }
        return LinearGradient(
            stops: [
                .init(color: .black, location: 0),
                .init(color: .black, location: plateau),
                .init(color: .black.opacity(0.4), location: 1),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    /// Smooth two-stop fade pinned to the very top edge of the screen
    /// — fully solid `bgPrimary` at the device's top edge, fading
    /// linearly to transparent ~90pt below. No flat plateau: the
    /// status-bar icons sit in the most-opaque sliver where they read
    /// crisply, and the gradient eases out across the rest of the
    /// strip so the transcript dissolves rather than being slabbed
    /// off. The bottom edge has no counterpart — the floating
    /// composer pill is the only chrome down there.
    private var topFadeStrip: some View {
        LinearGradient(
            stops: [
                .init(color: Theme.bgPrimary, location: 0.0),
                .init(color: Theme.bgPrimary.opacity(0), location: 1.0),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        .frame(height: 90)
        .ignoresSafeArea(.container, edges: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(false)
    }

    /// Floating menu + conversation-action + new-conversation buttons that sit where the
    /// nav bar used to be — leading hamburger toggles the side drawer,
    /// trailing pencil-and-square mints a fresh agent session. They
    /// render on top of the fade strip so the icons remain legible
    /// against the solid-bgPrimary section at the top of the screen.
    /// Diameter of the floating top buttons — comfortably above the 44pt
    /// minimum target, and heavy enough to hold their own against the landing
    /// screen's larger mark and composer.
    private static let topButtonDiameter: CGFloat = 46

    private var topButtonsOverlay: some View {
        HStack {
            // Leading menu + trailing conversation buttons sit on
            // Liquid Glass circles so they read as tappable chrome
            // floating over the transcript, matching the composer pill
            // and the scroll-to-bottom chevron.
            MenuToolbarButton(isOpen: $menuOpen)
                .font(.system(size: 18, weight: .medium))
                .frame(width: Self.topButtonDiameter, height: Self.topButtonDiameter)
                .contentShape(Circle())
                .modifier(GlassCircleButton())
            Spacer()
            if store.agent.sessionId != nil || !store.agent.isBlankNewConversation {
                // The two trailing actions share one capsule so they read
                // as a single solid control, while staying two independent
                // tap targets with their own actions. New conversation
                // leads, overflow trails — with no divider between them.
                HStack(spacing: 0) {
                    if !store.agent.isBlankNewConversation {
                        Button {
                            store.agent.newConversation()
                        } label: {
                            Image(systemName: "square.and.pencil")
                                .foregroundStyle(Theme.textPrimary)
                                .font(.system(size: 18, weight: .medium))
                                .frame(width: Self.topButtonDiameter, height: Self.topButtonDiameter)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("New conversation")
                    }

                    if let sessionId = store.agent.sessionId {
                        Menu {
                            Button {
                                let pinned = !activeConversationPinned
                                Task {
                                    await store.agent.togglePin(
                                        id: sessionId,
                                        pinned: pinned
                                    )
                                }
                            } label: {
                                Label(
                                    activeConversationPinned ? "Unpin this chat" : "Pin this chat",
                                    systemImage: activeConversationPinned ? "pin.slash" : "pin"
                                )
                            }

                            Button(role: .destructive) {
                                conversationDeletion.present(conversationId: sessionId)
                            } label: {
                                Label("Delete this chat", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .foregroundStyle(Theme.textPrimary)
                                .font(.system(size: 18, weight: .medium))
                                .frame(width: Self.topButtonDiameter, height: Self.topButtonDiameter)
                                .contentShape(Rectangle())
                        }
                        .accessibilityLabel("Chat actions")
                        .disabled(store.agent.conversationActionsInFlight.contains(sessionId))
                    }
                }
                .modifier(GlassCapsuleGroup())
            }
        }
        .padding(.leading, Theme.Spacing.sm)
        .padding(.trailing, 10)
        .padding(.top, 2)
        .confirmationDialog(
            "Delete this chat?",
            isPresented: conversationDeletionPresented,
            titleVisibility: .visible
        ) {
            Button("Delete this chat", role: .destructive) {
                guard let id = conversationDeletion.takeConfirmedConversationId() else { return }
                Task { await store.agent.deleteConversation(id: id) }
            }
            Button("Cancel", role: .cancel) {
                conversationDeletion.cancel()
            }
        } message: {
            Text("This chat will be permanently deleted.")
        }
        .alert(
            conversationActionFailureKind.title,
            isPresented: conversationActionFailurePresented
        ) {
            Button("Dismiss", role: .cancel) {
                store.agent.clearConversationActionError()
            }
        } message: {
            Text(conversationActionFailureKind.detail(for: store.agent.conversationActionErrorContext))
        }
    }

    private var activeConversationPinned: Bool {
        store.agent.activeConversationPinned
    }

    private var scrollToBottomFloatingButton: some View {
        Button {
            scrollToBottomTrigger &+= 1
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .frame(width: 44, height: 44)
                // Make the whole 44pt circle tappable. Without this the
                // button's hit region collapses to the rendered glyph
                // (~16×9pt) — the glass circle is only a background, so it
                // doesn't widen the hit shape — and taps that land on the
                // visible circle but miss the tiny glyph do nothing. That
                // is the "the chevron works sometimes but not others" bug.
                .contentShape(Circle())
                // Liquid Glass circle — interactive glass refracts
                // ("lenses") the transcript scrolling behind it and
                // springs on touch, the standard iOS feel. On pre-26
                // systems it falls back to the previous tinted
                // `.ultraThinMaterial` circle so the affordance still
                // reads against the transcript backdrop.
                .modifier(GlassCircleButton())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scroll to latest")
    }

    /// Whether the floating chevron is currently visible. The
    /// sentinel sits at the very bottom of the scroll content
    /// (outside the LazyVStack, below its 140pt trailing spacer), so
    /// `bottomAnchorMinY` is its `minY` in viewport coordinates:
    ///
    ///   - At max scroll: sentinel sits at the viewport bottom edge,
    ///     so `bottomAnchorMinY ≈ scrollViewHeight - 1`.
    ///   - At the user-perceived bottom (last message at viewport
    ///     bottom, composer pill floating below): the sentinel is
    ///     still 140pt past the viewport bottom because of the
    ///     trailing spacer, so `bottomAnchorMinY ≈
    ///     scrollViewHeight + 140`.
    ///   - Scrolled `n` pt up from the perceived bottom:
    ///     `bottomAnchorMinY ≈ scrollViewHeight + 140 + n`.
    ///
    /// The threshold (180pt) covers the 140pt offset plus a 40pt
    /// elastic-bounce buffer, so the chevron stays hidden across the
    /// entire band the user reads as "at the bottom" and pops in
    /// once they've scrolled meaningfully past it. Short-circuits
    /// guard the initial-layout (`scrollViewHeight == 0`) and
    /// empty-transcript states.
    private var showScrollToBottom: Bool {
        guard scrollViewHeight > 0 else { return false }
        guard !store.agent.turns.isEmpty else { return false }
        return bottomAnchorMinY > scrollViewHeight + Self.bottomThreshold
    }
}

@available(iOS 17.0, *)
private struct ContextWindowExceededCard: View {
    let onNewConversation: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Context window reached", systemImage: "text.badge.xmark")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            Text(
                "This conversation no longer fits in the selected model's context window. "
                    + "Start a new conversation to continue."
            )
            .font(.system(size: 13))
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)

            Button("New conversation", action: onNewConversation)
                .font(.system(size: 13, weight: .semibold))
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(Theme.accent.opacity(0.32), lineWidth: 1)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }
}

/// Takes the composer's place when a conversation was read from storage
/// because no session could be minted. The transcript above it is complete and
/// scrollable — only continuing the thread is withheld, which is what this
/// says. Retry re-attempts the mint, so the composer returns as soon as the
/// model does, without the reader losing their place.
///
/// Shaped like `ContextWindowExceededCard` on purpose: both are the same
/// situation to a reader — a conversation they can read but not continue — and
/// they should not look like two different kinds of problem.
@available(iOS 17.0, *)
private struct ReadOnlyConversationCard: View {
    let reason: String
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Read-only", systemImage: "exclamationmark.triangle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            Text(reason)
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            Button("Retry", action: onRetry)
                .font(.system(size: 13, weight: .semibold))
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(Theme.warning.opacity(0.32), lineWidth: 1)
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }
}

/// PreferenceKey that publishes the bottom-of-content sentinel's
/// `minY` in the ScrollView's local coordinate space. Drives the
/// floating scroll-to-bottom chevron's visibility. See the sentinel
/// in `AgentView.transcript` for why it must sit OUTSIDE the
/// LazyVStack — that placement is the whole reason the chevron stays
/// reliable on long conversations.
@available(iOS 17.0, *)
private struct BottomAnchorKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

/// PreferenceKey that publishes the composer's bounds as an anchor.
/// Read by `AgentView` to anchor the transcript's bottom fade mask to
/// the floating composer. An anchor preference is a direct modifier, so
/// (unlike a `.background`-hosted GeometryReader preference) it
/// propagates up across the `.overlay` that hosts the composer. See
/// `transcriptFadeMask`.
@available(iOS 17.0, *)
private struct ComposerBoundsKey: PreferenceKey {
    static let defaultValue: Anchor<CGRect>? = nil
    static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
        value = nextValue() ?? value
    }
}

// MARK: - Liquid Glass

/// Symmetric rounded-rectangle shape of the composer pill. The "liquid
/// glass" look comes entirely from the glass material's own edge
/// treatment (specular rim highlight + lensing), not from the geometry —
/// the input keeps a normal, axis-symmetric rounded shape.
@available(iOS 17.0, *)
private let composerGlassShape = RoundedRectangle(cornerRadius: 28, style: .continuous)

/// The composer pill's own chrome colours.
///
/// Adaptive like everything else: dark mode gets the brief's translucent navy
/// with a blue-gray rim, light mode the same construction on a pale ground so
/// the pill stays a pill rather than becoming a grey slab.
private enum ComposerChrome {
    /// Pulls the glass toward navy so it reads as part of the dark screen
    /// instead of a light-grey card floating on it.
    static let tint = Color(light: 0xE6EDF7, dark: 0x101A2B)

    /// The pre-26 fallback's own fill, under `.ultraThinMaterial`.
    static let fill = LandingPalette.fieldFill

    /// The fine outer rim — blue-gray, not neutral grey.
    static let rim = LandingPalette.fieldRim

    /// The inner highlight along the upper edge, drawn additively so it catches
    /// the top curve the way a real glass lip would.
    static let innerHighlight = LandingPalette.fieldHighlight
}

/// Liquid Glass background for the composer pill, with a tinted
/// `.ultraThinMaterial` fallback for systems older than iOS 26.
///
/// The material is only the middle layer. Around it: a glow underneath so the
/// pill sits in light rather than on top of the backdrop, a fine blue-gray rim,
/// and an additive highlight on the upper edge. Those three are what keep it
/// reading as integrated glass instead of a bright floating card.
@available(iOS 17.0, *)
private struct ComposerGlass: ViewModifier {
    /// Tints the glass with the accent colour while dictation is live.
    var accented: Bool

    func body(content: Content) -> some View {
        glass(content)
            .overlay(
                composerGlassShape.strokeBorder(
                    accented ? Theme.accent : ComposerChrome.rim,
                    lineWidth: accented ? 1.0 : 0.6
                )
            )
            .overlay(
                composerGlassShape
                    .strokeBorder(
                        LinearGradient(
                            stops: [
                                .init(color: ComposerChrome.innerHighlight.opacity(0.34), location: 0.0),
                                .init(color: ComposerChrome.innerHighlight.opacity(0), location: 0.5),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
                    .blendMode(.plusLighter)
                    .allowsHitTesting(false)
            )
        // Deliberately no glow under the pill. It read as a lit object hovering
        // over the screen rather than chrome sitting on it — the rim and the
        // upper-edge highlight carry the depth on their own.
    }

    @ViewBuilder
    private func glass(_ content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(
                .regular.tint(
                    accented
                        ? Theme.accent.opacity(0.22)
                        : ComposerChrome.tint.opacity(0.55)
                ),
                in: composerGlassShape
            )
        } else {
            content
                .clipShape(composerGlassShape)
                .background(composerGlassShape.fill(ComposerChrome.fill.opacity(0.72)))
                .background(composerGlassShape.fill(.ultraThinMaterial))
        }
    }
}

private struct TranscriptPrependScrollTarget: Equatable {
    let sessionId: String
    let anchor: PagingPrependAnchor
}

/// Reactive bottom-stick controller for the transcript ScrollView.
///
/// On iOS 18+ it observes the scroll geometry. The rule:
///   - When the CONTENT HEIGHT changes (initial load, lazy-row
///     materialisation, a new turn, streaming tokens) and we are still
///     stuck to the bottom, re-align to the `__bottom__` sentinel. Because
///     `scrollTo` clamps to the real maximum offset, this can never land
///     past the content end, and re-firing on every size change makes it
///     settle on the true bottom as estimated rows resolve to real heights.
///   - When only the OFFSET changes (the user dragging) we recompute
///     `stick`: at/near the end → keep following; dragged away → stop.
///
/// On iOS 17 (no `onScrollGeometryChange`) this is inert; the view's
/// `onChange`/`onAppear` handlers provide best-effort following there.
@available(iOS 17.0, *)
private struct BottomStickController: ViewModifier {
    let proxy: ScrollViewProxy
    @Binding var stick: Bool
    let turnsEmpty: Bool

    /// How close to the content end still counts as "at the bottom" (pt).
    private static let stickThreshold: CGFloat = 60

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Probe.self) { geo in
                Probe(
                    contentHeight: geo.contentSize.height,
                    distanceFromEnd: geo.contentSize.height - geo.visibleRect.maxY
                )
            } action: { old, new in
                if new.contentHeight != old.contentHeight {
                    // Content grew/shrank: follow if still stuck.
                    if stick, !turnsEmpty {
                        proxy.scrollTo("__bottom__", anchor: .bottom)
                    }
                } else {
                    // Pure scroll: update whether we are still following.
                    stick = new.distanceFromEnd <= Self.stickThreshold
                }
            }
        } else {
            content
        }
    }

    private struct Probe: Equatable {
        var contentHeight: CGFloat
        var distanceFromEnd: CGFloat
    }
}

/// Liquid Glass capsule behind the merged trailing chat actions —
/// Drop shadow under the floating top buttons. Full in dark mode; a
/// whisper in light mode, where the same shadow reads far heavier.
/// Dark mode is unchanged.
private enum TopButtonShadow {
    static func opacity(isLight: Bool) -> Double {
        isLight ? 0.06 : 0.22
    }

    static func radius(isLight: Bool) -> CGFloat {
        isLight ? 2 : 6
    }

    static func offsetY(isLight: Bool) -> CGFloat {
        isLight ? 1 : 2
    }
}

/// the overflow menu and the new-conversation button share one solid
/// control while staying two independent tap targets. Same glass,
/// rim and shadow as the round buttons, drawn in a capsule.
private struct GlassCapsuleGroup: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        glass(content)
            .overlay(Capsule().strokeBorder(ComposerChrome.rim, lineWidth: 0.6))
            .shadow(
                color: .black.opacity(TopButtonShadow.opacity(isLight: colorScheme == .light)),
                radius: TopButtonShadow.radius(isLight: colorScheme == .light),
                y: TopButtonShadow.offsetY(isLight: colorScheme == .light)
            )
    }

    @ViewBuilder
    private func glass(_ content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(
                .regular.tint(ComposerChrome.tint.opacity(0.5)).interactive(),
                in: Capsule()
            )
        } else {
            content
                .background(Capsule().fill(ComposerChrome.fill.opacity(0.72)))
                .background(Capsule().fill(.ultraThinMaterial))
        }
    }
}

/// Liquid Glass circle behind a round icon button — the floating
/// scroll-to-bottom chevron and the leading top menu button.
/// The `.interactive()` glass lenses whatever scrolls behind
/// it and springs on touch, the standard iOS affordance. Falls back to
/// the tinted `.ultraThinMaterial` circle pre-26.
private struct GlassCircleButton: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        glass(content)
            // Same fine blue-gray rim as the composer, so the round chrome and
            // the pill read as one family rather than two borrowed styles.
            .overlay(Circle().strokeBorder(ComposerChrome.rim, lineWidth: 0.6))
            .shadow(
                color: .black.opacity(TopButtonShadow.opacity(isLight: colorScheme == .light)),
                radius: TopButtonShadow.radius(isLight: colorScheme == .light),
                y: TopButtonShadow.offsetY(isLight: colorScheme == .light)
            )
    }

    @ViewBuilder
    private func glass(_ content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(
                .regular.tint(ComposerChrome.tint.opacity(0.5)).interactive(),
                in: Circle()
            )
        } else {
            content
                .background(Circle().fill(ComposerChrome.fill.opacity(0.72)))
                .background(Circle().fill(.ultraThinMaterial))
        }
    }
}

// MARK: - Composer

@available(iOS 17.0, *)
struct AgentComposer: View {
    @Binding var text: String
    let busy: Bool
    let disabled: Bool
    /// Whether the paired gateway runs in experimental mode. Gates any
    /// experimental slash commands the extensible command list may add.
    let experimentalEnabled: Bool
    var speech: SpeechRecognizer
    /// The send carries the armed slash command (or `nil` for an ordinary
    /// turn) so the caller can fold its options (e.g. `deepResearch`) into
    /// the POST.
    let onSend: (String, SlashCommand?) -> Void
    let onCancel: () -> Void
    var focused: FocusState<Bool>.Binding

    /// The per-message armed slash command. Local compose-time state: it
    /// governs the NEXT send only and is cleared on submit (or by the pill's
    /// `×`), so it never leaks into the following turn. Seeding it is the only
    /// way to arm Deep Research — there is no implicit auto-gating.
    @State private var armedCommand: SlashCommand?

    init(
        text: Binding<String>,
        busy: Bool,
        disabled: Bool,
        experimentalEnabled: Bool = false,
        speech: SpeechRecognizer,
        onSend: @escaping (String, SlashCommand?) -> Void,
        onCancel: @escaping () -> Void,
        focused: FocusState<Bool>.Binding,
        previewArmedCommand: SlashCommand? = nil
    ) {
        self._text = text
        self.busy = busy
        self.disabled = disabled
        self.experimentalEnabled = experimentalEnabled
        self.speech = speech
        self.onSend = onSend
        self.onCancel = onCancel
        self.focused = focused
        self._armedCommand = State(initialValue: previewArmedCommand)
    }

    /// Whether the slash menu is open, and which commands it lists. Derived
    /// from `text` via `matchSlashCommands` on every keystroke, over the
    /// command set available for the gateway's current feature mode.
    private var menu: SlashMenuState {
        matchSlashCommands(
            text,
            commands: SlashCommand.available(experimentalEnabled: experimentalEnabled)
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            if menu.isOpen, !menu.matches.isEmpty {
                slashMenu
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            VStack(alignment: .leading, spacing: 0) {
                if let armedCommand {
                    armedPill(armedCommand)
                        .padding(.leading, 16)
                        .padding(.top, 10)
                        .padding(.bottom, 2)
                        .transition(.move(edge: .leading).combined(with: .opacity))
                }
                HStack(alignment: .bottom, spacing: 6) {
                    TextField(
                        placeholder,
                        text: $text,
                        axis: .vertical
                    )
                    .focused(focused)
                    .lineLimit(1 ... 5)
                    .font(.system(size: 19))
                    .padding(.leading, 20)
                    .padding(.vertical, 20)
                    .foregroundStyle(Theme.textPrimary)
                    .disabled(disabled || speech.isListening)
                    .submitLabel(.send)
                    .onSubmit { submit() }
                    .accessibilityIdentifier("agentComposer")

                    trailingButton
                        .padding(.trailing, 10)
                        .padding(.bottom, 14)
                }
            }
            // Liquid Glass pill: on iOS 26 it's real glass — the
            // material's own specular rim highlight and lensing of the
            // transcript behind it give the "accentuated edges" feel,
            // while the shape stays a normal symmetric rounded rect.
            // Pre-26 falls back to the tinted `.ultraThinMaterial` pill.
            // Tints accent while dictating.
            .modifier(ComposerGlass(accented: speech.isListening))
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.bottom, Theme.Spacing.sm)
        .animation(.easeInOut(duration: 0.2), value: speech.isListening)
        .animation(.easeInOut(duration: 0.2), value: armedCommand)
        .animation(.easeInOut(duration: 0.18), value: menu.isOpen)
        .onChange(of: speech.transcript) { _, newValue in
            if speech.isListening {
                text = newValue
            }
        }
        .onChange(of: speech.state) { oldValue, newValue in
            // When speech finishes (transitions from listening/finishing
            // to idle), commit the final transcript into the text field.
            if oldValue == .listening || oldValue == .finishing,
               newValue == .idle,
               !speech.transcript.isEmpty {
                text = speech.transcript
            }
        }
        .onAppear {
            speech.requestPermissionsIfNeeded()
        }
    }

    @ViewBuilder
    private var trailingButton: some View {
        if busy {
            Button(action: onCancel) {
                Image(systemName: "stop.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(Theme.danger)
            }
            .accessibilityLabel("Cancel")
        } else if speech.isListening {
            // Listening state: accent-filled circle with pulsing rings
            // radiating outward — tapping stops recognition.
            Button {
                speech.stopListening()
            } label: {
                ZStack {
                    MicPulseRing(color: Theme.accent)
                        .frame(width: 30, height: 30)
                    Circle()
                        .fill(Theme.accent)
                        .frame(width: 30, height: 30)
                    Image(systemName: "mic.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                }
            }
            .accessibilityLabel("Stop listening")
        } else if canSend {
            Button(action: submit) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(Theme.accent)
            }
            .accessibilityIdentifier("agentSendButton")
            .accessibilityLabel("Send")
        } else {
            // Empty text, not busy — show mic button.
            Button {
                speech.toggle()
            } label: {
                Image(systemName: "mic.fill")
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(
                        speech.state == .unavailable
                            ? Theme.textMuted.opacity(0.4)
                            : Theme.accent
                    )
                    .frame(width: 34, height: 34)
            }
            .disabled(speech.state == .unavailable)
            .accessibilityIdentifier("agentDictateButton")
            .accessibilityLabel("Dictate")
        }
    }

    /// The slash-command typeahead, shown above the field when the text is a
    /// `/`-query. One row per matching command; tapping a row arms it.
    private var slashMenu: some View {
        VStack(spacing: 0) {
            ForEach(menu.matches) { cmd in
                Button { arm(cmd) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: cmd.systemImage)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.accent)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(cmd.label)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Theme.textPrimary)
                            Text(cmd.hint)
                                .font(.system(size: 11))
                                .foregroundStyle(Theme.textSecondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("slashCommand-\(cmd.id)")
            }
        }
        .background(Theme.bgSecondary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.large))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.large)
                .stroke(Theme.border, lineWidth: 1)
        )
        .padding(.bottom, 8)
        .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
    }

    /// The armed-command pill: top-left, glyph + label + `×`. The whole pill
    /// is the dismiss control so its touch target is large enough for reliable
    /// phone use; dismissing clears the arm without sending.
    private func armedPill(_ cmd: SlashCommand) -> some View {
        Button { armedCommand = nil } label: {
            HStack(spacing: 5) {
                Image(systemName: cmd.systemImage)
                    .font(.system(size: 11, weight: .semibold))
                Text(cmd.label)
                    .font(.system(size: 12, weight: .semibold))
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .padding(2)
            }
            .foregroundStyle(Theme.accentHover)
            .padding(.leading, 9)
            .padding(.trailing, 6)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(Theme.accent.opacity(0.15))
            )
            .contentShape(Capsule())
            .accessibilityIdentifier("armedCommandPill")
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("dismissArmedCommand")
        .accessibilityLabel("Dismiss \(cmd.label)")
    }

    /// Arm a slash command: select it as the per-message pill and strip the
    /// `/`-query text so the field is clear for the actual prompt.
    private func arm(_ cmd: SlashCommand) {
        armedCommand = cmd
        text = ""
        focused.wrappedValue = true
    }

    private var placeholder: String {
        if disabled { return "Connecting…" }
        if busy { return "Working…" }
        if speech.isListening { return "Listening…" }
        if armedCommand != nil { return "Describe what to research…" }
        return "Ask Omnesis"
    }

    private var canSend: Bool {
        !busy && !disabled && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        // Keep Return-key submission inert while Stop is visible. The field
        // intentionally stays editable so a follow-up can be drafted, then
        // submitted once the gateway's terminal event clears `busy`.
        guard !busy, !disabled else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let command = armedCommand
        // Per-message: the pill governs THIS send only, then clears.
        armedCommand = nil
        onSend(trimmed, command)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("AgentView — populated transcript") {
    @Previewable @State var menuOpen = false
    return AgentView(menuOpen: $menuOpen)
        .environment(AppStore.preview(agentPreview: PreviewMocks.agentRichTranscript))
}

@available(iOS 17.0, *)
#Preview("AgentView — pinned conversation actions") {
    AgentView(menuOpen: .constant(false))
        .environment(AppStore.preview(agentPreview: PreviewMocks.agentPinnedTranscript))
}

@available(iOS 17.0, *)
#Preview("AgentView — context window reached") {
    AgentView(menuOpen: .constant(false))
        .environment(AppStore.preview(agentPreview: PreviewMocks.agentContextWindowExceeded))
}

@available(iOS 17.0, *)
#Preview("AgentView — output truncated") {
    AgentView(menuOpen: .constant(false))
        .environment(AppStore.preview(agentPreview: PreviewMocks.agentOutputTruncated))
}

@available(iOS 17.0, *)
#Preview("AgentView — empty (just connected)") {
    @Previewable @State var menuOpen = false
    return AgentView(menuOpen: $menuOpen)
        .environment(AppStore.preview(agentPreview: PreviewMocks.agentEmptyConnected))
}

@available(iOS 17.0, *)
#Preview("AgentView — busy / streaming") {
    @Previewable @State var menuOpen = false
    return AgentView(menuOpen: $menuOpen)
        .environment(AppStore.preview(agentPreview: PreviewMocks.agentBusyStreaming))
}

@available(iOS 17.0, *)
#Preview("AgentView — stop request failed") {
    @Previewable @State var menuOpen = false
    let store = AppStore.preview(agentPreview: PreviewMocks.agentBusyStreaming)
    store.agent.installPreviewCancelError(URLError(.cannotConnectToHost))
    return AgentView(menuOpen: $menuOpen).environment(store)
}

@available(iOS 17.0, *)
#Preview("AgentView — transcript loading") {
    @Previewable @State var menuOpen = false
    let store = AppStore.preview(agentPreview: .init())
    store.agent.installPreviewTranscriptLoading(title: "Trip planning")
    return AgentView(menuOpen: $menuOpen).environment(store)
}

@available(iOS 17.0, *)
#Preview("AgentView — fatal error (server body)") {
    @Previewable @State var menuOpen = false
    let store = AppStore.preview(agentPreview: .init())
    return AgentView(menuOpen: $menuOpen)
        .environment(store)
        .task {
            store.agent.installPreviewFatal(error: GatewayClient.Error.serverError(
                status: 503,
                body: "Anthropic API key not configured. Set it from the portal's Settings → Models tab."
            ))
        }
}

@available(iOS 17.0, *)
#Preview("AgentView — fatal error (gateway unreachable)") {
    @Previewable @State var menuOpen = false
    let store = AppStore.preview(agentPreview: .init())
    return AgentView(menuOpen: $menuOpen)
        .environment(store)
        .task {
            store.agent.installPreviewFatal(error: URLError(.cannotConnectToHost))
        }
}

@available(iOS 17.0, *)
#Preview("AgentView — fatal error (unauthorized)") {
    @Previewable @State var menuOpen = false
    let store = AppStore.preview(agentPreview: .init())
    return AgentView(menuOpen: $menuOpen)
        .environment(store)
        .task {
            store.agent.installPreviewFatal(error: GatewayClient.Error.unauthorized)
        }
}

// iPad-landscape split with the Timeline open. Seeded directly (the
// geometry probe + demo auto-pilot that drive this in production don't
// run in the canvas) and forced through the `idiomOverride` seam so the
// gate resolves `.sidePanel` on a non-iPad canvas. View in a 13" iPad
// landscape canvas.
@available(iOS 17.0, *)
#Preview("AgentView — iPad landscape split (open)") {
    AgentLayout.idiomOverride = true
    var seed = PreviewMocks.agentRichTranscript
    seed.trailAnnotations = PreviewMocks.trailVoucherAnnotations
    return AgentView(
        menuOpen: .constant(false),
        previewLayoutMode: .sidePanel,
        previewCitationsOpen: true,
        previewWidth: 1366
    )
    .environment(AppStore.preview(agentPreview: seed))
}

// iPad-landscape split with the Timeline closed — the conversation
// spans the full width, no sticky-tab gutter.
@available(iOS 17.0, *)
#Preview("AgentView — iPad landscape split (closed)") {
    AgentLayout.idiomOverride = true
    return AgentView(
        menuOpen: .constant(false),
        previewLayoutMode: .sidePanel,
        previewCitationsOpen: false,
        previewWidth: 1366
    )
    .environment(AppStore.preview(agentPreview: PreviewMocks.agentRichTranscript))
}

@available(iOS 17.0, *)
#Preview("Composer — idle (mic visible)") {
    @Previewable @State var text = ""
    @Previewable @FocusState var focused: Bool
    let speech = SpeechRecognizer.preview(state: .idle)
    return AgentComposer(
        text: $text,
        busy: false,
        disabled: false,
        speech: speech,
        onSend: { _, _ in },
        onCancel: {},
        focused: $focused
    )
    .padding(.top, 300)
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Composer — listening (pulsing mic)") {
    @Previewable @State var text = "What did Quentin email me"
    @Previewable @FocusState var focused: Bool
    let speech = SpeechRecognizer.preview(state: .listening, transcript: "What did Quentin email me")
    return AgentComposer(
        text: $text,
        busy: false,
        disabled: false,
        speech: speech,
        onSend: { _, _ in },
        onCancel: {},
        focused: $focused
    )
    .padding(.top, 300)
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Composer — speech unavailable") {
    @Previewable @State var text = ""
    @Previewable @FocusState var focused: Bool
    let speech = SpeechRecognizer.preview(state: .unavailable)
    return AgentComposer(
        text: $text,
        busy: false,
        disabled: false,
        speech: speech,
        onSend: { _, _ in },
        onCancel: {},
        focused: $focused
    )
    .padding(.top, 300)
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Composer — slash menu open") {
    @Previewable @State var text = "/"
    @Previewable @FocusState var focused: Bool
    let speech = SpeechRecognizer.preview(state: .idle)
    return AgentComposer(
        text: $text,
        busy: false,
        disabled: false,
        experimentalEnabled: true,
        speech: speech,
        onSend: { _, _ in },
        onCancel: {},
        focused: $focused
    )
    .padding(.top, 300)
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Composer — Deep Research armed") {
    @Previewable @State var text = "How has my running pace trended this year?"
    @Previewable @FocusState var focused: Bool
    let speech = SpeechRecognizer.preview(state: .idle)
    return AgentComposer(
        text: $text,
        busy: false,
        disabled: false,
        speech: speech,
        onSend: { _, _ in },
        onCancel: {},
        focused: $focused,
        previewArmedCommand: SlashCommand.byId("deep-research")
    )
    .padding(.top, 300)
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}
#endif
#endif
