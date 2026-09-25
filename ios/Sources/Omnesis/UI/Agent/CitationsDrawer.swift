// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Right-side reference panel listing every document the agent has
/// referenced during the active conversation as one chronological
/// Timeline. Slides in from the trailing edge over a dim scrim so the
/// conversation underneath stays partly visible — the panel is a
/// *reference* surface, not a navigation replacement.
///
/// Every Timeline event has a corresponding sticky tab that lives in
/// its own layer to the LEFT of the panel's leading edge, peeking
/// out into the scrim (or, when the panel is closed, into the right
/// edge of the screen — the panel slid past it). The tabs are
/// scroll-linked: their Y position tracks each event's center as the
/// user scrolls inside the panel. When an event crosses into the
/// viewport from the bottom, its tab is inserted with a snappy
/// spring `.move(edge: .trailing)` transition so it visibly slides
/// out from behind the panel border.
///
/// When more events exist below the fold than fit in the viewport, a
/// sleek "+N" pill peeks from the panel's bottom-leading edge. It
/// stays visible whether the drawer is open or closed — when the
/// drawer is shut, this pill is the secondary affordance alongside
/// the visible tabs.
///
/// Opened from `AgentView` via a 20pt right-edge swipe, by tapping
/// the per-bubble citation chip in `AgentBubbleViews`, by tapping
/// any visible sticky tab, or by tapping the overflow pill. Closed
/// by dragging the panel right past 1/3 of its width, a rightward
/// flick (vx > 500pt/s), a tap on the scrim, or the close (×)
/// button in the header.
@available(iOS 17.0, *)
struct CitationsDrawer: View {
    /// Annotation buckets (`annotate`) — the sole document source for the
    /// Timeline. `byDoc` is the synthesis source: each slot carries the
    /// captured DocRef the builder needs to fabricate the document's row.
    let trailAnnotations: AgentTrailAnnotations
    /// Directly-cited analytics rows from `cite_record`. The
    /// builder synthesises a record-only Timeline row for each one.
    let recordCitations: [AgentTrailRecord]
    @Binding var isOpen: Bool
    let presentation: Presentation

    /// How the drawer renders relative to the conversation.
    ///
    ///   - `overlay`: trailing-edge drawer that slides *over* the
    ///     conversation (iPhone / iPad-portrait). Owns the scrim, the
    ///     scroll-linked sticky tabs, the "+N" overflow pill, the
    ///     drag-to-close gesture and the closed→open slide offset.
    ///   - `docked`: a fixed column rendered *beside* the conversation
    ///     (iPad landscape). The host (`AgentView`) sizes it and animates
    ///     its insertion/removal as part of a split; the drawer itself
    ///     just fills its allotted frame with the Timeline. No
    ///     scrim/tabs/pill/offset — only the × close button and the
    ///     Timeline scroll remain.
    enum Presentation {
        case overlay
        case docked
    }

    /// Public init — every drawer mounts the unified Timeline.
    init(
        trailAnnotations: AgentTrailAnnotations = .empty,
        recordCitations: [AgentTrailRecord] = [],
        isOpen: Binding<Bool>,
        presentation: Presentation = .overlay
    ) {
        self.trailAnnotations = trailAnnotations
        self.recordCitations = recordCitations
        self._isOpen = isOpen
        self.presentation = presentation
    }

    /// Unified event list — single source of truth for both the
    /// Timeline content and the sticky-tab strip. Recomputed on every
    /// render because the inputs (byDoc keys + record citations) are
    /// cheap to merge; persisting a memo would mean tracking annotation
    /// mutations more carefully than the work it saves.
    private var events: [AgentTrailEvent] {
        AgentTimelineBuilder.buildUnifiedTimeline(
            byDoc: trailAnnotations.byDoc,
            records: recordCitations
        )
    }

    // Drag-induced offset from the drawer's resting position, held in
    // @State so the release animation continues from the finger's
    // last position instead of snapping back to fully open first.
    @State private var dragOffset: CGFloat = 0
    @State private var dragMode: DragMode = .undetermined
    // Per-event frame snapshot. Reported by a GeometryReader
    // background under each Timeline event row in both the scroll's
    // local space (for the in-viewport check) and the panel's local
    // space (for the tab's vertical position). Merged across renders
    // so brief un-render / re-render cycles don't make tabs blink.
    @State private var eventFrames: [Int: CardFrame] = [:]
    @State private var scrollHeight: CGFloat = 0
    /// Document the user tapped on the Timeline. The drawer is an overlay
    /// with no `NavigationStack` ancestor, so it opens the in-app viewer
    /// as a sheet rather than a push.
    @State private var openDocTarget: OpenDocTarget?

    /// Identifiable wrapper so the tapped document id can drive
    /// `.sheet(item:)` (which requires `Identifiable`, unlike
    /// `.navigationDestination(item:)`).
    private struct OpenDocTarget: Identifiable { let id: String }

    private enum DragMode {
        case undetermined
        case horizontalClose
        case vertical
    }

    /// Frame snapshot reported by each Timeline event row.
    /// `scrollMinY` / `scrollMaxY` are in the ScrollView's local
    /// coordinate space — used to decide whether the row currently
    /// intersects the viewport. `tabAnchorY` is the Y position (in
    /// the panel's local coordinate space) where the sticky tab
    /// should sit; that's the centre of the event's source-icon dot,
    /// which lines the tab up with the row's identity row rather
    /// than the row's variable-height body.
    struct CardFrame: Equatable, Hashable {
        let scrollMinY: CGFloat
        let scrollMaxY: CGFloat
        let tabAnchorY: CGFloat
    }

    /// Panel takes ~92% of the screen width. The remaining sliver is
    /// covered by the scrim and stays tappable, hinting that there's
    /// a conversation behind the panel to swipe back to.
    private static let widthFraction: CGFloat = 0.916
    /// How far each sticky tab tucks INTO the panel surface — its
    /// trailing edge sits this far past the panel's leading border so
    /// the accent stroke on that side merges into the panel rather
    /// than reading as a separate seam.
    private static let tabIntoPanelOverlap: CGFloat = 2
    /// Extra rightward shift applied to sticky tabs when the panel is
    /// fully open so they mostly hide behind the panel edge, leaving
    /// only a ~4pt sliver peeking out — enough to hint at their
    /// presence without showing the source icon.
    private static let tabOpenTuck: CGFloat = 22
    /// Bottom gap between the overflow pill and the panel's bottom
    /// edge. Roughly home-indicator-adjacent on a notched device.
    private static let overflowPillBottomInset: CGFloat = 28
    /// Vertical strip at the bottom of the panel reserved for the
    /// "+N" pill — tabs whose center would land inside this zone
    /// are hidden and aggregated into the pill count instead. The
    /// reserve = pill bottom inset + pill height + half a tab height
    /// (so the tab's bottom edge clears the pill's top) + a small
    /// safety margin.
    private static let tabZoneBottomReserve: CGFloat =
        overflowPillBottomInset + OverflowCountPill.height + TimelineEventStickyTab.height / 2 + 8
    /// Width of the trailing strip the host view (`AgentView`) should
    /// leave clear of conversation content so the sticky tabs peeking
    /// out from the right edge when the drawer is closed don't sit on
    /// top of the transcript or the composer. Matches the visible tab
    /// width (tab width minus the 2pt it tucks past the screen edge)
    /// plus a small breathing margin.
    static let closedTabGutterWidth: CGFloat =
        TimelineEventStickyTab.width - tabIntoPanelOverlap + 6
    /// Vertical band at the bottom of the screen the composer pill
    /// occupies. When the drawer publishes
    /// `ComposerNeedsGutterKey == true`, the host view's composer
    /// shrinks by `closedTabGutterWidth` so a tab or overflow pill
    /// rendered in this band doesn't sit on top of the input. Sized
    /// to comfortably cover the pill itself (~42pt) plus its bottom
    /// inset and the home-indicator safe area, with a small breathing
    /// margin on top — so a tab whose bottom edge merely brushes the
    /// pill's top counts as overlapping.
    private static let composerOverlapBandHeight: CGFloat = 100
    /// Snappy spring for the per-tab pop-in animation. Short response
    /// with moderate damping reads as "punchy" — fast initial settle
    /// with a single small overshoot.
    private static let tabPopAnimation: Animation =
        .spring(response: 0.34, dampingFraction: 0.72)
    private static let scrollSpace = "citations.scroll"
    private static let panelSpace = "citations.panel"

    /// Programmatic open/close animation curve. Cubic-bezier(0.16, 1,
    /// 0.3, 1) over 400ms — fast at the start, settles smoothly.
    static let openCloseAnimation: Animation =
        .timingCurve(0.16, 1, 0.3, 1, duration: 0.4)

    /// Shared open-on-leftward-swipe gesture, used in two places:
    ///
    ///   - `AgentView` attaches it as `.gesture(...)` on the
    ///     20pt-wide trailing strip so the user can pull the panel
    ///     in from the bare right edge of the screen.
    ///   - `TimelineEventStickyTab` attaches it as
    ///     `.simultaneousGesture(...)` on top of its own Button —
    ///     without this, a swipe that started ON a tab would be
    ///     swallowed by the Button and the global edge-swipe would
    ///     never see it, so the right-edge swipe felt broken
    ///     directly over any visible tab.
    ///
    /// `minimumDistance: 10` keeps the gesture from firing on
    /// micro-jitters; the `< -50` width check and `< 60` vertical
    /// clamp on `.onEnded` make sure only a deliberate leftward
    /// swipe (not a vertical scroll attempt or a tap that drifted)
    /// triggers `onOpen`. Both call sites pass an `onOpen` closure
    /// that wraps the state change in `openCloseAnimation`.
    static func openSwipeGesture(onOpen: @escaping () -> Void) -> some Gesture {
        DragGesture(minimumDistance: 10)
            .onEnded { value in
                if value.translation.width < -50, abs(value.translation.height) < 60 {
                    onOpen()
                }
            }
    }

    var body: some View {
        Group {
            switch presentation {
            case .overlay: overlayBody
            case .docked: dockedBody
            }
        }
        // Dismiss the keyboard whenever the drawer opens. If the user
        // had the composer focused (typing into "Ask Omnesis…") and
        // then triggered the drawer — by swiping in from the right
        // edge, tapping a citation chip in a bubble, or tapping a
        // sticky tab / overflow pill — leaving the keyboard up would
        // crowd the panel and visually compete with the drawer's
        // header. Resigning first responder collapses the keyboard so
        // the panel has the full height to lay out against.
        .onChange(of: isOpen) { _, nowOpen in
            if nowOpen {
                UIApplication.shared.sendAction(
                    #selector(UIResponder.resignFirstResponder),
                    to: nil,
                    from: nil,
                    for: nil
                )
            }
        }
        // Tapping a cited title / related row opens the document in the
        // in-app viewer. No NavigationStack here (the drawer is an
        // overlay), so present it modally — wrapped in its own
        // NavigationStack so the viewer's toolbar (Open in source, ⓘ)
        // works.
        .environment(\.openTrailDocument) { openDocTarget = OpenDocTarget(id: $0) }
        .sheet(item: $openDocTarget) { target in
            NavigationStack {
                AgentDocumentDetailView(documentId: target.id)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Done") { openDocTarget = nil }
                                .tint(Theme.accent)
                        }
                    }
            }
            .omnesisColorScheme()
        }
    }

    /// Docked presentation (iPad landscape). The Timeline fills the
    /// column the host hands it — no scrim, sticky tabs, overflow pill,
    /// slide offset or drag-to-close. The host owns the column's width
    /// and the open/close (insert/remove) animation; here we render only
    /// the panel surface, a leading edge highlight to separate it from
    /// the conversation, and the × close button (wired through the same
    /// `isOpen` binding, so the host's split collapses on tap).
    private var dockedBody: some View {
        panel(width: 0)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgPrimary)
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(Theme.borderLight)
                    .frame(width: 1)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }
            .coordinateSpace(name: Self.panelSpace)
    }

    private var overlayBody: some View {
        GeometryReader { geo in
            let panelWidth = geo.size.width * Self.widthFraction
            let panelHeight = geo.size.height
            let restingOffset: CGFloat = isOpen ? 0 : panelWidth
            let offset = min(panelWidth, restingOffset + max(0, dragOffset))
            let progress = (panelWidth - offset) / panelWidth
            // Tab zone runs from the top of the panel down to here.
            // Tabs whose `tabAnchorY` would sit below this line are
            // hidden — their cards are still listed in the scrolling
            // content, but they don't get a tab; instead they're
            // counted in the "+N" overflow pill that occupies this
            // bottom strip.
            let tabZoneBottomY = panelHeight - Self.tabZoneBottomReserve
            // Single source for the tab strip — every visible
            // Timeline event row reports its frame here, and the same
            // event count drives the overflow pill below.
            let unifiedEvents = events
            let overflowCount = overflowBelowCount(
                frames: eventFrames,
                totalRows: unifiedEvents.count,
                tabZoneBottomY: tabZoneBottomY
            )
            // Composer-overlap band check: true when a visible tab's
            // center or the overflow pill currently renders inside
            // the bottom strip the composer pill occupies. Drives
            // `ComposerNeedsGutterKey` so the host view can decide
            // whether to shrink the composer or let it span the full
            // width. The pill always lives at the bottom of the panel
            // (inside the band by construction), so if it's visible
            // the answer is unconditionally yes.
            let composerBandTopY = panelHeight - Self.composerOverlapBandHeight
            let tabInComposerBand = eventFrames.contains { _, frame in
                isShown(frame: frame, tabZoneBottomY: tabZoneBottomY)
                    && frame.tabAnchorY + TimelineEventStickyTab.height / 2 >= composerBandTopY
            }
            let composerNeedsGutter = overflowCount > 0 || tabInComposerBand

            ZStack(alignment: .trailing) {
                scrim(progress: progress)

                // Tabs layer — a sibling of the panel (NOT an overlay
                // inside it) so the tabs can extend leftward past
                // the panel's leading edge into the scrim area. Sits
                // BELOW the panel in z-order so a tab at its hidden
                // X position is physically covered by the panel
                // surface; sliding the tab leftward visually
                // "emerges" it from behind that border.
                tabsLayer(tabZoneBottomY: tabZoneBottomY, events: unifiedEvents, progress: progress)
                    .frame(
                        width: panelWidth + TimelineEventStickyTab.width,
                        height: panelHeight,
                        alignment: .topLeading
                    )
                    .offset(x: offset)
                    .allowsHitTesting(true)

                panel(width: panelWidth)
                    .frame(width: panelWidth)
                    .background(Theme.bgPrimary)
                    // Let just the panel container extend through the
                    // home-indicator zone so its ScrollView (and the
                    // timeline fade-mask) can reach the physical
                    // screen bottom. The parent GeometryReader is
                    // bounded by the safe-area-inset region, which
                    // is why the previous `.ignoresSafeArea` on the
                    // inner ScrollView had nothing to push against —
                    // applying it here on the panel lets the container
                    // grow without affecting the sibling overflow
                    // pill or sticky-tab layer (both still anchor to
                    // the safe-area bottom in the outer ZStack).
                    .ignoresSafeArea(edges: .bottom)
                    .overlay(alignment: .leading) {
                        // 1pt inner highlight along the panel's
                        // leading edge — mimics how light catches
                        // the edge of a physical surface, breaking
                        // up the flat dark-on-dark transition
                        // between panel and scrim.
                        Rectangle()
                            .fill(Theme.borderLight)
                            .frame(width: 1)
                            .ignoresSafeArea()
                            .allowsHitTesting(false)
                    }
                    .coordinateSpace(name: Self.panelSpace)
                    .offset(x: offset)
                    .simultaneousGesture(panelDragGesture(panelWidth: panelWidth))
                    .allowsHitTesting(progress > 0.01)
                    // This panel also closes on a *rightward* drag, which is
                    // the direction that reveals the main menu. Gated on the
                    // same predicate as its hit-testing: parked off-screen the
                    // panel still occupies its layout frame, which spans most
                    // of the width, and excluding that while closed would
                    // leave almost nowhere in the conversation to open the
                    // menu from.
                    .menuRevealExcluded(isActive: progress > 0.01)

                // Overflow pill — topmost sibling so it stays
                // hit-testable even when the panel's hit testing is
                // disabled (closed state).
                if overflowCount > 0 {
                    OverflowCountPill(count: overflowCount, onTap: pillTapped)
                        .frame(maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, Self.overflowPillBottomInset)
                        .offset(x: -panelWidth + offset + Self.tabIntoPanelOverlap)
                        .opacity(Double(1 - progress))
                }
            }
            .preference(key: ComposerNeedsGutterKey.self, value: composerNeedsGutter)
        }
    }

    /// Sticky-tab layer that lives left of the panel surface. Each
    /// tab is `.position`'d at its event row's `tabAnchorY` so the tab
    /// and row visually scroll together; the X position is fixed so
    /// the tab's leading edge always sits exactly at the panel's
    /// leading edge minus `tabWidth - tabIntoPanelOverlap`. SwiftUI's
    /// `.move(edge: .trailing)` transition handles the slide-out
    /// effect: the tab inserts from beyond its trailing edge (which,
    /// because of where its center lives, sits inside the panel) and
    /// slides leftward to settle into its visible position.
    @ViewBuilder
    private func tabsLayer(tabZoneBottomY: CGFloat, events: [AgentTrailEvent], progress: CGFloat) -> some View {
        let tabX = TimelineEventStickyTab.width / 2
            + Self.tabIntoPanelOverlap
            + progress * Self.tabOpenTuck
        ZStack(alignment: .topLeading) {
            ForEach(Array(events.enumerated()), id: \.element.eventId) { idx, event in
                if let frame = eventFrames[idx],
                   isShown(frame: frame, tabZoneBottomY: tabZoneBottomY) {
                    TimelineEventStickyTab(event: event, onTap: tabTapped)
                        .position(
                            x: tabX,
                            y: frame.tabAnchorY
                        )
                        .transition(
                            .move(edge: .trailing).combined(with: .opacity)
                        )
                }
            }
        }
        .animation(Self.tabPopAnimation, value: shownTabIdSet(events: events, tabZoneBottomY: tabZoneBottomY))
    }

    private func panel(width: CGFloat) -> some View {
        VStack(spacing: 0) {
            header
            if events.isEmpty {
                empty
            } else {
                timelinePanel
            }
        }
    }

    /// The unified Timeline body — wraps `TrailTimelineView` over the
    /// merged event list. Each event row reports its frame via
    /// `TrailEventFrameKey`; the drawer reads those frames to position
    /// one sticky tab per event. The `visibleDocIds` set restricts
    /// per-event "cites X" / "cited by X" lines to relations whose
    /// target is ALSO a row on this Timeline — so the user always
    /// understands why a row shows up by clicking through to the
    /// cited doc.
    private var timelinePanel: some View {
        let unifiedEvents = events
        var ids: Set<String> = []
        for event in unifiedEvents {
            if let docId = event.doc?.documentId {
                ids.insert(docId)
            }
            for attachment in event.attachments {
                if let attDocId = attachment.doc?.documentId {
                    ids.insert(attDocId)
                }
            }
        }
        let visibleDocIds = ids
        return ScrollView {
            TrailTimelineView(
                events: unifiedEvents,
                annotations: trailAnnotations,
                scrollCoordinateSpace: Self.scrollSpace,
                panelCoordinateSpace: Self.panelSpace,
                visibleDocIds: visibleDocIds
            )
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.top, Theme.Spacing.sm)
            // Bottom content padding sized so the last event doesn't
            // end up parked under the home indicator. The ScrollView
            // itself extends past the safe area (see `.ignoresSafeArea`
            // on the panel container) so the fade meets the physical
            // screen edge — content stays scrollable past the
            // indicator instead.
            .padding(.bottom, Theme.Spacing.lg + 34)
        }
        .coordinateSpace(name: Self.scrollSpace)
        .scrollDisabled(dragMode == .horizontalClose)
        // Soft fade at the top and bottom edges of the timeline
        // scroll view so events fade in / out as the user scrolls
        // rather than getting hard-clipped at the panel border.
        // 5pt gradient bands at each end — barely perceptible but
        // enough to remove the visual snap. Mask is applied in the
        // ScrollView's container coordinates, NOT to the content,
        // so it stays anchored to the viewport edges as the user
        // scrolls past it.
        .mask(
            VStack(spacing: 0) {
                LinearGradient(
                    colors: [.clear, .black],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 5)
                Color.black
                LinearGradient(
                    colors: [.black, .clear],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 5)
            }
        )
        .background(
            GeometryReader { proxy in
                Color.clear
                    .onAppear { scrollHeight = proxy.size.height }
                    .onChange(of: proxy.size.height) { _, new in
                        scrollHeight = new
                    }
            }
        )
        .onPreferenceChange(TrailEventFrameKey.self) { newFrames in
            // Translate the trail's TrailEventFrame into the drawer's
            // CardFrame so the rest of the tab layout math doesn't
            // need to branch on which kind of frame it's looking at.
            var merged = eventFrames
            for (idx, f) in newFrames {
                merged[idx] = CardFrame(
                    scrollMinY: f.scrollMinY,
                    scrollMaxY: f.scrollMaxY,
                    tabAnchorY: f.tabAnchorY
                )
            }
            eventFrames = merged
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Timeline")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                    if !headerSubtitle.isEmpty {
                        Text(headerSubtitle)
                            .font(.system(size: 11))
                            .foregroundStyle(Theme.textMuted.opacity(0.85))
                    }
                }
                Spacer()
                Button { close() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Close timeline")
            }
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.md)
        .background(Theme.bgPrimary)
    }

    /// "N events · K sources" sub-line under the Timeline title.
    /// Pluralised; computed once per render so the count stays in
    /// sync with the underlying event list. Returns empty string
    /// when the Timeline has no rows (the empty-state view replaces
    /// the header subtitle entirely).
    private var headerSubtitle: String {
        let unified = events
        guard !unified.isEmpty else { return "" }
        let eventCount = unified.count
        let sources = Set(
            unified.flatMap { event -> [String] in
                let primary = event.eventSourceId.map { [$0] } ?? []
                return primary + event.attachments.compactMap(\.eventSourceId)
            }
            .map { (id: String) -> String in
                sourceTypeOf(id)
            }
        ).count
        let eventWord = eventCount == 1 ? "event" : "events"
        let srcWord = sources == 1 ? "source" : "sources"
        return "\(eventCount) \(eventWord) · \(sources) \(srcWord)"
    }

    /// Empty state — shown when the drawer is opened before the
    /// agent has built a trail or recorded any annotation. Mirrors
    /// the portal's empty Timeline panel ("The agent has not
    /// referenced any document yet.").
    private var empty: some View {
        VStack(spacing: 8) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .font(.system(size: 36))
                .foregroundStyle(Theme.textMuted)
            Text("The agent has not referenced any document yet.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 72)
    }

    /// Whether a given event row's tab should currently be rendered.
    /// Two conditions, both required: the row's frame intersects the
    /// scroll viewport (otherwise the card itself isn't visible),
    /// and the tab's vertical anchor `tabAnchorY` sits above the
    /// reserved overflow-pill zone at the bottom of the panel
    /// (otherwise the tab would overlap the pill).
    private func isShown(frame: CardFrame, tabZoneBottomY: CGFloat) -> Bool {
        guard scrollHeight > 0 else { return false }
        let inScrollViewport = frame.scrollMinY < scrollHeight && frame.scrollMaxY > 0
        let inTabZone = frame.tabAnchorY < tabZoneBottomY
        return inScrollViewport && inTabZone
    }

    /// Stable identifier set for the currently-shown event tabs.
    /// Used as the `value:` of the tabs-layer animation so the
    /// snappy spring fires whenever tabs appear or disappear.
    private func shownTabIdSet(events: [AgentTrailEvent], tabZoneBottomY: CGFloat) -> Set<String> {
        Set(events.enumerated().compactMap { idx, event in
            guard let frame = eventFrames[idx],
                  isShown(frame: frame, tabZoneBottomY: tabZoneBottomY) else { return nil }
            return "evt:\(event.eventId)"
        })
    }

    /// Number of rows whose card/event sits below the last shown tab
    /// — they're either below the scroll viewport entirely or in
    /// the bottom-of-panel zone reserved for the pill. Walking from
    /// the highest-known shown index forward captures both cases:
    /// every later row either hasn't been rendered (so by
    /// construction it's below the rendered window) or its
    /// `tabAnchorY` falls in the pill zone.
    private func overflowBelowCount(
        frames: [Int: CardFrame],
        totalRows: Int,
        tabZoneBottomY: CGFloat
    )
        -> Int {
        guard totalRows > 0 else { return 0 }
        guard scrollHeight > 0 else { return totalRows }
        let shown: Set<Int> = Set(frames.compactMap { idx, frame in
            isShown(frame: frame, tabZoneBottomY: tabZoneBottomY) ? idx : nil
        })
        let lastShown = shown.max() ?? -1
        return max(0, totalRows - 1 - lastShown)
    }

    private func tabTapped() {
        withAnimation(Self.openCloseAnimation) { isOpen.toggle() }
    }

    private func pillTapped() {
        withAnimation(Self.openCloseAnimation) { isOpen = true }
    }

    private func close() {
        withAnimation(Self.openCloseAnimation) { isOpen = false }
    }

    /// The right-side drag-to-close gesture on the panel surface.
    /// Direction-locks on touch-down (vx > 150pt/s wins horizontal,
    /// vy > 150pt/s wins vertical) so a vertical scroll inside the
    /// panel never accidentally pulls the panel sideways.
    private func panelDragGesture(panelWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if dragMode == .undetermined {
                    let vx = value.velocity.width
                    let vy = value.velocity.height
                    let absVx = abs(vx)
                    let absVy = abs(vy)
                    if vx > 0, absVx > 150, absVx > absVy * 1.5 {
                        dragMode = .horizontalClose
                    } else if absVy > 150, absVy > absVx * 1.5 {
                        dragMode = .vertical
                    }
                }
                if dragMode == .horizontalClose {
                    dragOffset = max(0, value.translation.width)
                }
            }
            .onEnded { value in
                let translation = value.translation.width
                let vx = value.velocity.width
                let shouldClose: Bool = if dragMode == .horizontalClose {
                    translation > panelWidth / 3 || vx > 500
                } else {
                    false
                }
                let currentResting: CGFloat = isOpen ? 0 : panelWidth
                let currentVisible = currentResting + max(0, dragOffset)
                let targetVisible: CGFloat = shouldClose ? panelWidth : 0
                let remaining = targetVisible - currentVisible
                let initialVelocity: Double = abs(remaining) > 1 ? Double(vx / remaining) : 0
                withAnimation(.interpolatingSpring(
                    mass: 1.0,
                    stiffness: 240,
                    damping: 28,
                    initialVelocity: initialVelocity
                )) {
                    isOpen = !shouldClose
                    dragOffset = 0
                }
                dragMode = .undetermined
            }
    }

    /// Scrim layer behind the panel. A low-intensity blur of the
    /// conversation underneath plus a soft black overlay so the
    /// conversation reads as "out of focus" rather than "dimmed".
    /// `AdjustableBlur` wraps `UIVisualEffectView` + a paused
    /// `UIViewPropertyAnimator` because SwiftUI's `Material` only
    /// exposes a coarse thickness scale and not a blur radius.
    private func scrim(progress: CGFloat) -> some View {
        ZStack {
            // Adaptive material so the dimmed backdrop frosts dark in
            // dark mode and light in light mode rather than staying a
            // fixed dark charcoal that clashes with the light theme.
            AdjustableBlur(
                intensity: 0.12,
                style: .systemUltraThinMaterial
            )
            Color.black.opacity(0.45)
        }
        .opacity(Double(progress))
        .ignoresSafeArea()
        .contentShape(Rectangle())
        .onTapGesture { close() }
        .allowsHitTesting(progress > 0.01)
    }
}

/// A single sticky tab — source icon on a leading-rounded slab that
/// reads as a tab peeking out from under the right screen edge. Each
/// tab corresponds to one Timeline event in the drawer; tap toggles
/// the drawer open.
///
/// The background fill comes from the source's provider package via
/// the registry (`sourceBgColorByType`) — Gmail red, WhatsApp green,
/// Drive yellow, etc. When the source hasn't shipped a colour the
/// tab falls back to a neutral Theme token. No outline stroke is
/// drawn: the tinted fill already telegraphs the source.
@available(iOS 17.0, *)
struct TimelineEventStickyTab: View {
    @Environment(AppStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    let event: AgentTrailEvent
    let onTap: () -> Void

    static let width: CGFloat = 28
    static let height: CGFloat = 38
    static let iconSize: CGFloat = 16

    /// Source id resolved source-agnostically — a document event uses its
    /// `doc.sourceId`, a record-only event its `record.sourceId`.
    private var eventSourceId: String {
        event.eventSourceId ?? ""
    }

    private var sourceTypeKey: String {
        sourceTypeOf(eventSourceId)
    }

    private var fillColor: Color {
        // The source-advertised background colours are dark brand chips
        // tuned for the dark theme — on the light timeline they'd read as
        // dark blocks. In light mode the tab is pure white instead and
        // reads as an elevated sliver purely through its drop shadow (see
        // `tab`); the colour cue still comes from the source logo.
        if colorScheme == .light {
            return Theme.bgPrimary
        }
        if let hex = store.sourceBgColorById[eventSourceId] {
            return Color(hex: hex) ?? Theme.bgTertiary
        }
        if let hex = store.sourceBgColorByType[sourceTypeKey] {
            return Color(hex: hex) ?? Theme.bgTertiary
        }
        return Theme.bgTertiary
    }

    private static let tabShadow = Color.black.opacity(0.45)
    /// Softer, lower-contrast shadow for the white light-mode tab — a
    /// gentle lift off the page rather than the pronounced sliver shadow
    /// that the dark brand chips carry.
    private static let tabShadowLight = Color.black.opacity(0.15)
    private static let tabShape = UnevenRoundedRectangle(
        cornerRadii: .init(
            topLeading: 10,
            bottomLeading: 10,
            bottomTrailing: 0,
            topTrailing: 0
        )
    )

    var body: some View {
        Button(action: onTap) {
            tab
        }
        .buttonStyle(.plain)
        // Mirror the global right-edge swipe-to-open gesture
        // directly onto the tab. The Button would otherwise eat the
        // touch and the global gesture (which lives on a sibling
        // strip in `AgentView`) would never see it, so without this a
        // swipe that starts over a visible tab does nothing. Attached
        // simultaneously so a tap still toggles via the Button's
        // `action` — the drag only fires on a clear leftward swipe.
        .simultaneousGesture(
            CitationsDrawer.openSwipeGesture { onTap() }
        )
        .accessibilityLabel("Timeline event: \(eventTitle)")
    }

    /// Source-agnostic title for the tab's accessibility label — the
    /// document title, the record's derived title, or a fallback.
    private var eventTitle: String {
        if let title = event.doc?.title, !title.isEmpty { return title }
        if let recordTitle = event.record?.title, !recordTitle.isEmpty { return recordTitle }
        return "(untitled)"
    }

    /// The tab sliver: source logo on the fill shape. The pronounced
    /// bottom shadow (rather than omnidirectional) makes it read as a
    /// physical sliver sitting just in front of the panel, not a flat
    /// decal.
    ///
    /// In light mode the shadow rides on the fill shape alone, so the
    /// source logo sitting on the white tab doesn't pick up its own drop
    /// shadow — only the sliver casts one. In dark mode the shadow stays
    /// on the whole tab as before.
    @ViewBuilder
    private var tab: some View {
        let content = HStack(spacing: 0) {
            SourceIconView(
                sourceId: sourceTypeKey,
                store: store,
                size: Self.iconSize
            )
            .padding(.leading, 6)
            Spacer(minLength: 0)
        }
        .frame(width: Self.width, height: Self.height)

        if colorScheme == .light {
            content.background(
                Self.tabShape
                    .fill(fillColor)
                    .shadow(color: Self.tabShadowLight, radius: 3, x: 0, y: 1.5)
            )
        } else {
            content
                .background(Self.tabShape.fill(fillColor))
                .shadow(color: Self.tabShadow, radius: 2, x: 0, y: 2)
        }
    }
}

/// Sleek counter pill that peeks out from the panel's
/// bottom-leading edge whenever there are more citations below the
/// viewport. Visible whether the drawer is open or closed — when
/// the drawer is closed and the visible tab strip is the user's
/// only affordance, the pill is the cue that more citations exist
/// out of sight, so its tap target opens the drawer rather than
/// toggling it.
@available(iOS 17.0, *)
struct OverflowCountPill: View {
    let count: Int
    let onTap: () -> Void

    static let width: CGFloat = 36
    static let height: CGFloat = 28

    var body: some View {
        Button(action: onTap) {
            Text("+\(count)")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textSecondary)
                .frame(width: Self.width, height: Self.height)
                .background(
                    UnevenRoundedRectangle(
                        cornerRadii: .init(
                            topLeading: 8,
                            bottomLeading: 8,
                            bottomTrailing: 0,
                            topTrailing: 0
                        )
                    )
                    .fill(Theme.bgTertiary)
                )
                // No outline stroke — the sticky tabs are fill-only too,
                // and the previous strokeBorder put a 1pt line along
                // the trailing edge that made the pill read as sitting
                // ON TOP of the panel's right border instead of
                // peeking out from behind it. Drop the stroke so the
                // pill matches the tabs' visual layer.
                .shadow(color: Color.black.opacity(0.5), radius: 3, x: 0, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count) more citation\(count == 1 ? "" : "s")")
    }
}

/// PreferenceKey emitted by `CitationsDrawer` whenever its current
/// tab layout would render a tab (or the overflow pill) inside the
/// vertical band the composer pill occupies. The host view
/// (`AgentView`) listens for changes and applies the right-side
/// gutter to the composer only while this is true — so when the tab
/// stack is short enough that no tab reaches the composer's height,
/// the composer can span the full screen width.
@available(iOS 17.0, *)
struct ComposerNeedsGutterKey: PreferenceKey {
    static let defaultValue: Bool = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

/// Variable-intensity `UIBlurEffect` wrapper. SwiftUI's `Material`
/// has a fixed blur radius and only exposes a coarse thickness scale
/// (ultraThin … ultraThick) which controls tint, not blur strength.
/// The canonical iOS hack to dial blur intensity is to drive a
/// `UIVisualEffectView`'s `.effect` via a paused
/// `UIViewPropertyAnimator`: setting `fractionComplete` to `x`
/// renders the effect at `x` of its full strength.
@available(iOS 17.0, *)
private struct AdjustableBlur: UIViewRepresentable {
    /// 0.0 = no blur, 1.0 = full Material blur.
    let intensity: CGFloat
    let style: UIBlurEffect.Style

    func makeUIView(context: Context) -> UIVisualEffectView {
        let view = UIVisualEffectView()
        view.backgroundColor = .clear
        return view
    }

    func updateUIView(_ view: UIVisualEffectView, context: Context) {
        context.coordinator.apply(to: view, intensity: intensity, style: style)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    final class Coordinator {
        private var animator: UIViewPropertyAnimator?

        func apply(to view: UIVisualEffectView, intensity: CGFloat, style: UIBlurEffect.Style) {
            animator?.stopAnimation(true)
            view.effect = nil
            let a = UIViewPropertyAnimator(duration: 1, curve: .linear) { [weak view] in
                view?.effect = UIBlurEffect(style: style)
            }
            a.startAnimation()
            a.pauseAnimation()
            // Clamp slightly inside (0, 1) — fractionComplete at the
            // exact endpoints sometimes snaps the effect to nil or to
            // full, defeating the partial-intensity goal.
            a.fractionComplete = max(0.001, min(0.999, intensity))
            animator = a
        }

        deinit {
            animator?.stopAnimation(true)
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("CitationsDrawer — open, empty") {
    @Previewable @State var isOpen = true
    let store = AppStore.preview(agentPreview: .init())
    return ZStack {
        Theme.bgPrimary.ignoresSafeArea()
        Text("Conversation behind the drawer…")
            .foregroundStyle(Theme.textMuted)
        CitationsDrawer(isOpen: $isOpen)
    }
    .environment(store)
    .preferredColorScheme(.dark)
}

// Trail-driven Timeline — voucher-journey fixture exercises every
// annotation shape (event-level note + doc quote + doc note + doc
// note-only) across WhatsApp and Gmail accent spines.
@available(iOS 17.0, *)
#Preview("CitationsDrawer — Timeline, voucher journey") {
    @Previewable @State var isOpen = true
    let seed = AppStore.AgentPreviewSeed(
        trailAnnotations: PreviewMocks.trailVoucherAnnotations
    )
    let store = AppStore.preview(agentPreview: seed)
    return ZStack {
        Theme.bgPrimary.ignoresSafeArea()
        CitationsDrawer(
            trailAnnotations: store.agent.trailAnnotations,
            isOpen: $isOpen
        )
    }
    .environment(store)
    .preferredColorScheme(.dark)
}

// Empty trail — exercises the empty-state branch shown when the
// agent has not referenced any document yet.
@available(iOS 17.0, *)
#Preview("CitationsDrawer — Timeline, empty") {
    @Previewable @State var isOpen = true
    let store = AppStore.preview(agentPreview: .init())
    return ZStack {
        Theme.bgPrimary.ignoresSafeArea()
        CitationsDrawer(
            trailAnnotations: .empty,
            isOpen: $isOpen
        )
    }
    .environment(store)
    .preferredColorScheme(.dark)
}

// Long Timeline (10 annotated docs, mixed sources) to exercise
// scrolling + multi-source spine gradients.
@available(iOS 17.0, *)
#Preview("CitationsDrawer — Timeline, long") {
    @Previewable @State var isOpen = true
    let seed = AppStore.AgentPreviewSeed(
        trailAnnotations: PreviewMocks.trailLongMultiAuthorAnnotations
    )
    let store = AppStore.preview(agentPreview: seed)
    return ZStack {
        Theme.bgPrimary.ignoresSafeArea()
        CitationsDrawer(
            trailAnnotations: store.agent.trailAnnotations,
            isOpen: $isOpen
        )
    }
    .environment(store)
    .preferredColorScheme(.dark)
}

// Closed drawer — exercises sticky-tab visibility on a populated
// Timeline. Tabs peek out from the right edge of the screen.
@available(iOS 17.0, *)
#Preview("CitationsDrawer — closed, tabs at edge") {
    @Previewable @State var isOpen = false
    let seed = AppStore.AgentPreviewSeed(
        trailAnnotations: PreviewMocks.trailVoucherAnnotations
    )
    let store = AppStore.preview(agentPreview: seed)
    return ZStack {
        Theme.bgPrimary.ignoresSafeArea()
        Text("Conversation, drawer closed — tabs peek at the edge")
            .foregroundStyle(Theme.textSecondary)
            .padding()
        CitationsDrawer(
            trailAnnotations: store.agent.trailAnnotations,
            isOpen: $isOpen
        )
    }
    .environment(store)
    .preferredColorScheme(.dark)
}
#endif
#endif
