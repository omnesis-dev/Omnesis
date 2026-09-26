// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The app's primary navigation menu: the layer that sits *under* the app and
/// is revealed when `MenuRevealContainer` slides the app aside. It drives the
/// active `HomeTab` and lists prior agent sessions beneath the menu rows.
///
/// Layout (top → bottom):
///   - Header: the "Omnesis" wordmark.
///   - Navigation rows: Search, Briefs when the gateway offers it, Sources,
///     People, and experimental-only destinations.
///   - Conversations list: prior agent sessions with the active one
///     highlighted.
///   - A bar held across the bottom carrying the two actions that are never a
///     destination — start a new conversation, and open Settings.
///
/// The two bottom actions are deliberately *not* rows. Everything in the
/// scrolling list answers "where do I want to be"; these answer "do the thing"
/// and "change how the app behaves", and both need to stay reachable however
/// far the conversation history has been scrolled. The list scrolls under the
/// bar and rests clear of it, since the bar is a safe-area inset.
///
/// The drawer names destinations and marks the ones that need attention with a
/// trailing amber triangle; it never carries a sentence of diagnostics. What is
/// broken, and the repair, belong to the surface that owns the subject — a
/// model that cannot run is stated and fixed on Settings → Models.
///
/// It owns no gestures and no offset of its own: revealing it, and the drag
/// that does so, belong to `MenuRevealContainer`. `isOpen` is here so the
/// drawer can refresh what it shows as it comes into view, and dismiss itself
/// once a row has been chosen.
@available(iOS 17.0, *)
struct MainMenuDrawer: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openCapture) private var openCapture
    @Binding var isOpen: Bool
    @Binding var selection: HomeTab
    let onOpenSettings: () -> Void
    @State private var showPendingNotes: Bool = false
    @State private var warningClock = Date()
    @State private var warningDeadlineTask: Task<Void, Never>?

    var body: some View {
        panel
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bgDrawer.ignoresSafeArea())
            .sheet(isPresented: $showPendingNotes) {
                PendingNotesDiagnosticSheet()
                    .environment(store)
                    .omnesisColorScheme()
            }
            // Refresh drawer state each time it opens — the same refresh-on-open
            // cadence for both surfaces the drawer shows, no live push:
            //   - The Briefs unread badge. The store's refresh no-ops (zeroes the
            //     badge) when experimental mode is off, so it's cheap even with the
            //     feature off.
            //   - The Privacy badge. A held answer expires, so the count has to
            //     be read afresh rather than carried from whenever the Privacy
            //     screen was last visited.
            //   - The conversation list. The agent SSE feed is scoped to the
            //     active session's transcript, so a conversation created or
            //     advanced on another device never pushes to us; re-fetching on
            //     open is how the list picks up cross-device activity without a
            //     full relaunch.
            .onChange(of: isOpen) { _, nowOpen in
                if nowOpen {
                    Task { await store.refreshBriefsUnreadCount() }
                    Task { await store.refreshPrivacyPendingCount() }
                    Task { await store.agent.refreshConversations() }
                    // Siri and Watch capture can enqueue through separate
                    // store instances while the app is alive. Disk is the
                    // queue authority, so refresh before deciding whether
                    // the warning triangle belongs in the drawer.
                    Task { await store.notes.refreshPending() }
                    scheduleWarningDeadline()
                } else {
                    warningDeadlineTask?.cancel()
                }
            }
            .onChange(of: store.notes.pending) { _, _ in
                scheduleWarningDeadline()
            }
            .onDisappear { warningDeadlineTask?.cancel() }
    }

    private var panel: some View {
        // One scroll context spans the whole menu: header → navigation rows
        // → "Conversations" → prior sessions. With a long history, scrolling
        // lifts the navigation rows off-screen so the full viewport can show
        // conversations. Only the action bar is pinned, because its two
        // actions have to stay reachable at any scroll position.
        ScrollView {
            VStack(spacing: 0) {
                header
                menuSection
                conversationsHeader
                AgentConversationsList(onSelect: { item in
                    // Always return to the Agent surface before resuming
                    // — taps from non-Agent sections (e.g. Search) would
                    // otherwise load the conversation in the background
                    // without bringing its transcript on-screen.
                    selection = .agent
                    Task { await store.agent.resumeConversation(id: item.sessionId) }
                    close()
                })
            }
        }
        .refreshable { await store.agent.refreshConversations() }
        // The bar is an inset, not an overlay: the list scrolls *under* it but
        // comes to rest clear of it, and the room it needs is measured from
        // the bar itself. A hand-kept constant would drift the moment the
        // bar's padding changed, and would be wrong outright at large Dynamic
        // Type, leaving the last conversation stranded behind it.
        .safeAreaInset(edge: .bottom, spacing: 0) { actionBar }
    }

    private var header: some View {
        HStack {
            Text("Omnesis")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            Spacer()
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.md)
    }

    /// The two actions that are not destinations, held across the bottom of
    /// the menu so neither scrolls away: open Settings, and start a fresh
    /// conversation. Settings is a quiet round target on the leading side;
    /// Ask is the app's one primary action, carries the accent fill, and sits
    /// trailing — under the thumb, and on the side the app itself is on.
    private var actionBar: some View {
        HStack(spacing: Theme.Spacing.md) {
            Button {
                onOpenSettings()
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(Theme.textPrimary)
                    .frame(width: Theme.tapTarget, height: Theme.tapTarget)
                    .background(Circle().fill(Theme.bgSecondary))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")

            Spacer(minLength: 0)

            Button {
                store.agent.newConversation()
                selection = .agent
                close()
            } label: {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 16, weight: .semibold))
                    Text("Ask")
                        .font(.system(size: 16, weight: .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.vertical, Theme.Spacing.md)
                .background(Capsule().fill(Theme.accent))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New conversation")
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.sm)
        .padding(.bottom, Theme.Spacing.md)
        // The bar absorbs taps across its whole footprint, including the gap
        // between the two buttons. Without this the gap is not hit-testable
        // and a tap there lands on whatever conversation row happens to be
        // scrolled behind the fade, which the user can barely see.
        .contentShape(Rectangle())
        // The list scrolls *under* the bar rather than stopping at it, so the
        // fade is what keeps the last row legible as it passes behind. It
        // reaches above the bar's own box, and past the home indicator below.
        //
        // The ramp runs the full height of that box rather than finishing
        // half way down it: completing early leaves a flat slab from the
        // buttons' waistline to the bottom of the screen, and the eye reads
        // that hard line as the edge of the menu. It also stops short of
        // opaque, so a row passing behind the very bottom is still faintly
        // there instead of being cut off mid-word.
        .background(
            LinearGradient(
                stops: [
                    .init(color: Theme.bgDrawer.opacity(0), location: 0.0),
                    .init(color: Theme.bgDrawer.opacity(0.55), location: 0.45),
                    .init(color: Theme.bgDrawer.opacity(0.82), location: 1.0),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .padding(.top, -Theme.Spacing.xl)
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
        )
    }

    /// Navigation destinations form one continuous list — every row here is a
    /// place to go, which is why starting a conversation is not among them and
    /// lives on the action bar instead. Experimental gating hides some rows
    /// unless the mode is active.
    private var menuSection: some View {
        VStack(spacing: 0) {
            row(id: "search", icon: "magnifyingglass", label: "Search", isActive: selection == .search) {
                select(.search)
            }
            // Omnesis Briefs — the proactive awareness feed. Experimental mode
            // keeps historical briefs available even while the background
            // agent is parked. A marked row still opens the feed; its warning
            // banner owns the shortcut to the model picker.
            if let destination = store.briefsMenuEntry.destination {
                row(
                    id: "briefs",
                    icon: "rectangle.stack",
                    label: "Briefs",
                    isActive: selection == .briefs,
                    badge: store.briefsUnreadCount,
                    warning: store.briefsMenuEntry == .needsAttention
                        ? RowWarning(label: "Background agent needs attention")
                        : nil
                ) {
                    switch destination {
                    case .feed: select(.briefs)
                    }
                }
            }

            row(id: "sources", icon: "square.grid.2x2", label: "Sources", isActive: selection == .sources) {
                select(.sources)
            }
            row(id: "people", icon: "person.2", label: "People", isActive: selection == .people) {
                select(.people)
            }
            // Tell Omnesis is generally available. The offline queue still
            // preserves captures when paired to an older gateway without /notes.
            tellOmnesisRow
            // Privacy is a standard control surface, not an experimental one:
            // an integration asking a question can require an owner decision
            // in ordinary operation, and the badge is how the owner learns a
            // decision is waiting without opening the screen.
            row(
                id: "audit",
                icon: "checkmark.shield",
                label: "Audit",
                isActive: selection == .privacy,
                badge: store.privacyPendingCount,
                badgeDescription: "decisions waiting for you"
            ) {
                select(.privacy)
            }

            if store.experimentalEnabled {
                row(
                    id: "watches",
                    // An eye rather than a bell: a watch is a standing question
                    // about the corpus, and most of them never notify at all.
                    icon: "eye",
                    label: "Watches",
                    isActive: selection == .watches
                ) {
                    select(.watches)
                }
            }
        }
    }

    /// Capture and queue recovery deliberately use separate tap targets:
    /// the wide row always starts listening, while the exceptional yellow
    /// triangle opens diagnostics without pretending to start a note.
    private var tellOmnesisRow: some View {
        let warningCount = store.notes.warnedPending(now: warningClock).count
        return row(
            id: "tellOmnesis",
            icon: "mic.fill",
            label: "Tell Omnesis",
            isActive: false,
            warning: warningCount > 0
                ? RowWarning(
                    label: "\(warningCount) unsent \(warningCount == 1 ? "note" : "notes"). "
                        + "Show delivery details",
                    onTap: { showPendingNotes = true }
                )
                : nil
        ) {
            close()
            openCapture?()
        }
    }

    /// Redraw exactly when the oldest quiet note crosses the five-minute
    /// threshold. Queue changes reschedule this one-shot task, so there is
    /// no polling timer and no stale warning after delivery/discard.
    private func scheduleWarningDeadline() {
        warningDeadlineTask?.cancel()
        let now = Date()
        warningClock = now
        guard isOpen, let deadline = store.notes.nextWarningDeadline(now: now) else { return }
        let delay = max(0, deadline.timeIntervalSince(now))
        warningDeadlineTask = Task {
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            warningClock = Date()
        }
    }

    private var conversationsHeader: some View {
        HStack {
            Text("Conversations")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Theme.textMuted)
            Spacer()
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.lg)
        .padding(.bottom, Theme.Spacing.sm)
    }

    /// One navigation row. `warning` is the drawer's single way to say "this
    /// destination needs attention", and never a sentence of diagnostics.
    private func row(
        id: String,
        icon: String,
        label: String,
        isActive: Bool,
        badge: Int = 0,
        badgeDescription: String = MenuBadge.unreadDescription,
        warning: RowWarning? = nil,
        action: @escaping () -> Void
    )
        -> some View {
        HStack(spacing: 0) {
            Button(action: action) {
                HStack(spacing: 14) {
                    Image(systemName: icon)
                        .font(.system(size: 18))
                        .foregroundStyle(isActive ? Theme.accent : Theme.textPrimary)
                        .frame(width: 22)
                    Text(label)
                        .font(.system(size: 18, weight: isActive ? .semibold : .regular))
                        .foregroundStyle(Theme.textPrimary)
                    Spacer()
                    if badge > 0 {
                        MenuBadge(count: badge, describing: badgeDescription)
                    }
                    if let warning, warning.onTap == nil {
                        warningGlyph
                            .accessibilityLabel(warning.label)
                    }
                }
                .padding(.leading, Theme.Spacing.md)
                // A warning row ends in a 48pt glyph block, whichever shape the
                // triangle takes, so the two align down the trailing edge when
                // both are on screen. Rows without one pad to the margin.
                .padding(.trailing, warning == nil ? Theme.Spacing.md : 0)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isActive ? Theme.accent.opacity(0.14) : Color.clear)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("menu.\(id)")

            if let warning, let onTap = warning.onTap {
                Button(action: onTap) {
                    // Its own target, so it takes the full 48pt touch height
                    // the row's padded label already spans.
                    warningGlyph
                        .frame(height: 48)
                        .background(isActive ? Theme.accent.opacity(0.14) : Color.clear)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(warning.label)
            }
        }
    }

    /// A row's attention marker: an amber triangle at the trailing edge, sized
    /// so both shapes line up. `onTap` gives it its own target for the one case
    /// where it leads somewhere the row does not — unsent notes open delivery
    /// details while the row still starts a capture. Left nil, the row is a
    /// single target whose own action is the repair route.
    ///
    /// The label is not optional: an unlabelled triangle is a visible warning
    /// that VoiceOver cannot announce.
    struct RowWarning {
        let label: String
        var onTap: (() -> Void)?
    }

    /// The marker itself. Fixed **width** only: a 48pt block at the trailing
    /// edge centres the triangle identically in both shapes, so the two line up
    /// when a marked row and Tell Omnesis are on screen together. Height is
    /// left to the row, which would otherwise grow to 48pt of glyph plus its
    /// own vertical padding and sit taller than every unmarked row.
    private var warningGlyph: some View {
        Image(systemName: "exclamationmark.triangle.fill")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(Theme.warning)
            .frame(width: 48)
    }

    private func select(_ tab: HomeTab) {
        selection = tab
        close()
    }

    private func close() {
        withAnimation(MenuReveal.openCloseAnimation) { isOpen = false }
    }
}

/// Small notification-style count pill for a drawer row. In-app only — this is
/// opt-in attention on a surface the user already opened, never an OS app-icon
/// badge or a push. Caps at `99+` so a large backlog never widens the row.
@available(iOS 17.0, *)
private struct MenuBadge: View {
    /// What the number counts, spoken after it. The pill itself is a bare
    /// digit, so without this VoiceOver announces a number and nothing else.
    static let unreadDescription = "unread"

    let count: Int
    var describing: String = unreadDescription

    var body: some View {
        Text(count > 99 ? "99+" : "\(count)")
            .font(.system(size: 13, weight: .semibold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(Theme.accent))
            .accessibilityLabel("\(count) \(describing)")
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("MainMenuDrawer — open, agent selected") {
    @Previewable @State var isOpen = true
    @Previewable @State var selection: HomeTab = .agent
    return ZStack(alignment: .leading) {
        Theme.bgDrawer.ignoresSafeArea()
        MainMenuDrawer(isOpen: $isOpen, selection: $selection, onOpenSettings: {})
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
            .environment(AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich))
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MainMenuDrawer — open, sources selected") {
    @Previewable @State var isOpen = true
    @Previewable @State var selection: HomeTab = .sources
    return ZStack(alignment: .leading) {
        Theme.bgDrawer.ignoresSafeArea()
        MainMenuDrawer(isOpen: $isOpen, selection: $selection, onOpenSettings: {})
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
            .environment(AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich))
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MainMenuDrawer - experimental entries shown") {
    @Previewable @State var isOpen = true
    @Previewable @State var selection: HomeTab = .agent
    return ZStack(alignment: .leading) {
        Theme.bgDrawer.ignoresSafeArea()
        MainMenuDrawer(isOpen: $isOpen, selection: $selection, onOpenSettings: {})
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
            .environment(AppStore.preview(
                statusSnapshot: PreviewMocks.statusSnapshotExperimental,
                agentPreview: PreviewMocks.agentConversationsRich
            ))
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MainMenuDrawer — Briefs unread badge") {
    @Previewable @State var isOpen = true
    @Previewable @State var selection: HomeTab = .agent
    return ZStack(alignment: .leading) {
        Theme.bgDrawer.ignoresSafeArea()
        MainMenuDrawer(isOpen: $isOpen, selection: $selection, onOpenSettings: {})
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
            .environment(AppStore.preview(
                statusSnapshot: PreviewMocks.statusSnapshotBriefsActive,
                briefsUnreadCount: 3,
                agentPreview: PreviewMocks.agentConversationsRich
            ))
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MainMenuDrawer — Privacy decisions waiting") {
    @Previewable @State var isOpen = true
    @Previewable @State var selection: HomeTab = .agent
    return ZStack(alignment: .leading) {
        Theme.bgDrawer.ignoresSafeArea()
        MainMenuDrawer(isOpen: $isOpen, selection: $selection, onOpenSettings: {})
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
            .environment(AppStore.preview(
                privacyPendingCount: 2,
                agentPreview: PreviewMocks.agentConversationsRich
            ))
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MainMenuDrawer — Briefs needs attention") {
    @Previewable @State var isOpen = true
    @Previewable @State var selection: HomeTab = .agent
    return ZStack(alignment: .leading) {
        Theme.bgDrawer.ignoresSafeArea()
        MainMenuDrawer(isOpen: $isOpen, selection: $selection, onOpenSettings: {})
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
            .environment(AppStore.preview(
                statusSnapshot: PreviewMocks.statusSnapshotBriefsNeedsAttention,
                agentPreview: PreviewMocks.agentConversationsRich
            ))
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MainMenuDrawer — empty conversations") {
    @Previewable @State var isOpen = true
    @Previewable @State var selection: HomeTab = .agent
    return ZStack(alignment: .leading) {
        Theme.bgDrawer.ignoresSafeArea()
        MainMenuDrawer(isOpen: $isOpen, selection: $selection, onOpenSettings: {})
            .frame(width: MenuReveal.menuWidth(forContainerWidth: 393), alignment: .leading)
            .environment(AppStore.preview(agentPreview: .init()))
    }
    .preferredColorScheme(.dark)
}
#endif
#endif
