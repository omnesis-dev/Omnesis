// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

@available(iOS 17.0, *)
extension MenuReveal {
    /// Every non-interactive open/close — a toolbar tap, a menu row, a
    /// deep-link that dismisses the menu on its way somewhere else.
    static let openCloseAnimation: Animation = .easeOut(duration: 0.22)

    /// Settle for a *released drag*, launched at the speed the finger left.
    static func releaseAnimation(initialVelocity: Double) -> Animation {
        .interpolatingSpring(mass: 1.0, stiffness: 240, damping: 28, initialVelocity: initialVelocity)
    }
}

/// Frames of the regions that own horizontal drags themselves.
///
/// A reference box rather than `@State`: the frames change on every frame of
/// any vertical scroll that carries one of these regions, and of the reveal
/// itself, since they are resolved in the container's coordinate space. Held
/// in `@State` that would invalidate the container's body — and with it the
/// whole app — once per frame. The gesture is the only reader, and it reads at
/// touch-down, so nothing needs to redraw when they move.
private final class MenuRevealExclusions {
    var frames: [CGRect] = []
}

/// Regions that own horizontal drags themselves, reported up to the container.
private struct MenuRevealExclusionKey: PreferenceKey {
    static var defaultValue: [CGRect] {
        []
    }

    static func reduce(value: inout [CGRect], nextValue: () -> [CGRect]) {
        value.append(contentsOf: nextValue())
    }
}

@available(iOS 17.0, *)
extension View {
    /// Marks a subtree that scrolls horizontally under the user's finger — a
    /// code block, a wide table, a rail of cards, a panel that closes on a
    /// rightward drag — so a drag starting inside it moves that content and
    /// nothing else.
    ///
    /// Without this both gestures fire: the region scrolls *and* the menu
    /// comes out from under the app, which is where a reveal spanning most of
    /// the screen is genuinely ambiguous. Declaring it at the scrolling view
    /// keeps the knowledge where it belongs — the container holds no list of
    /// special cases, and a new horizontal scroller opts in with one modifier.
    ///
    /// Pass `isActive: false` whenever the region is not currently taking
    /// touches — a panel parked off-screen, a rail that is hidden. The frame
    /// reported here is the **layout** frame, and `.offset` is a draw-time
    /// transform that does not move it: a panel slid out of sight still
    /// reports the frame it would occupy, and would go on excluding that whole
    /// area. Gate on the same condition that governs the region's hit-testing
    /// and the two can never disagree.
    ///
    /// Only meaningful inside a `MenuRevealContainer`; harmless anywhere else,
    /// and inert inside a sheet, whose content reports no preferences to the
    /// presenter it covers.
    func menuRevealExcluded(isActive: Bool = true) -> some View {
        background {
            GeometryReader { geo in
                Color.clear.preference(
                    key: MenuRevealExclusionKey.self,
                    value: isActive ? [geo.frame(in: .named(MenuReveal.coordinateSpace))] : []
                )
            }
        }
    }
}

/// Presents the main menu *beneath* the app, and slides the app aside to
/// reveal it.
///
/// Moving the app, rather than covering it, keeps it the object under the
/// user's hand: it steps aside, corners rounding as it lifts, and stays
/// visible on the trailing edge as somewhere to go back to. That also frees
/// the gesture to work across the whole screen, since there is no panel that
/// has to be dragged in from an edge.
///
/// Layering, bottom to top: `menu`, then `content` offset by `progress` of the
/// travel, washed by a scrim and cut to a corner radius that both scale with
/// the same `progress`. One drag gesture on the container drives that progress
/// in both directions; `MenuReveal` holds every value it is tuned by.
///
/// The container never lays out either layer differently from how they would
/// lay out alone — `offset` and `mask` are draw-time only — so the app keeps
/// its own safe areas, and the width the offset is measured against is read
/// from a background probe rather than a wrapping `GeometryReader`.
@available(iOS 17.0, *)
struct MenuRevealContainer<Menu: View, Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    @Binding var isOpen: Bool
    /// Freezes the reveal at a fixed point of its travel (0 closed, 1 open),
    /// ignoring `isOpen` and any drag. Previews and snapshot tests use it to
    /// render a mid-gesture frame, which is otherwise unreachable in a still;
    /// when set, the drag is inert so nothing can move behind a frozen render.
    let progressOverride: CGFloat?
    private let menu: Menu
    private let content: Content

    /// Container width, read from a background probe. Zero until first layout,
    /// which resolves to a closed menu — the state the app launches in anyway.
    @State private var width: CGFloat = 0
    /// Distance covered by the drag in progress, signed. Held in `@State`
    /// rather than `@GestureState` so it survives touch-up and can be animated
    /// back to zero in the same `withAnimation` block as `isOpen`: that joint
    /// settle is what carries the app on from wherever the finger left it,
    /// instead of snapping back and re-animating from the resting position.
    @State private var dragDistance: CGFloat = 0
    @State private var exclusions = MenuRevealExclusions()
    @State private var feedbackGenerator = UIImpactFeedbackGenerator(style: .soft)

    init(
        isOpen: Binding<Bool>,
        progressOverride: CGFloat? = nil,
        @ViewBuilder menu: () -> Menu,
        @ViewBuilder content: () -> Content
    ) {
        self._isOpen = isOpen
        self.progressOverride = progressOverride
        self.menu = menu()
        self.content = content()
    }

    /// Points the app travels between closed and fully open — which is also
    /// exactly the width it uncovers, hence the menu's own width.
    private var travel: CGFloat {
        MenuReveal.menuWidth(forContainerWidth: width)
    }

    private var restingDistance: CGFloat {
        isOpen ? travel : 0
    }

    private var progress: CGFloat {
        if let progressOverride { return MenuReveal.clamped(unit: progressOverride) }
        return MenuReveal.progress(
            restingDistance: restingDistance,
            dragDistance: dragDistance,
            travel: travel
        )
    }

    /// Width the menu lays out in. `nil` before first layout, which leaves it
    /// unconstrained for that one frame rather than collapsing it to nothing.
    private var menuWidth: CGFloat? {
        width > 0 ? travel : nil
    }

    var body: some View {
        ZStack(alignment: .leading) {
            // Painted edge to edge even though the menu is laid out narrower,
            // so no seam can show between the two at full travel.
            Theme.bgDrawer.ignoresSafeArea()
            menu
                // The menu is only ever as wide as the app moves — past that
                // it is behind the app and could never be seen. Laying it out
                // to the full screen instead would run its rows, and the
                // Settings button at its trailing edge, underneath the
                // standing strip where they are permanently unreachable.
                .frame(width: menuWidth, alignment: .leading)
                // Inert until the menu has fully arrived, so a finger that
                // lands on a row and then swipes the app back over it does not
                // also fire that row on release.
                .disabled(progress < 1)
                // Hidden from VoiceOver on the *committed* state, not on
                // `progress`: a pair of thresholds either side of a moving
                // value leaves mid-travel with both layers hidden and nothing
                // at all to read.
                .accessibilityHidden(!isOpen)
            contentLayer
        }
        .background {
            GeometryReader { geo in
                Color.clear
                    .onAppear { width = geo.size.width }
                    .onChange(of: geo.size.width) { _, newWidth in width = newWidth }
            }
        }
        .coordinateSpace(.named(MenuReveal.coordinateSpace))
        .onPreferenceChange(MenuRevealExclusionKey.self) { [exclusions] frames in
            exclusions.frames = frames
        }
        // A real recogniser, on the window, so the reveal can lose to the
        // gestures UIKit owns instead of firing alongside them. Laid in the
        // background: it hit-tests to nothing and only exists to own the
        // recogniser's lifetime.
        .background {
            MenuRevealPanGesture(
                shouldBegin: { start, translation, velocity in
                    let accepted = MenuReveal.mode(
                        velocity: velocity,
                        startLocation: start,
                        translation: translation,
                        width: width,
                        isOpen: isOpen,
                        exclusions: exclusions.frames
                    ) == .horizontal && progressOverride == nil
                    if accepted { feedbackGenerator.prepare() }
                    return accepted
                },
                onChanged: { translation in
                    dragDistance = MenuReveal.clampDragDistance(
                        translation.x,
                        restingDistance: restingDistance,
                        travel: travel
                    )
                },
                onEnded: { velocity in
                    guard travel > 0 else {
                        dragDistance = 0
                        return
                    }
                    settle(velocity: velocity.x)
                },
                onCancelled: {
                    withAnimation(MenuReveal.openCloseAnimation) { dragDistance = 0 }
                }
            )
        }
        // VoiceOver's two-finger scrub, and the equivalent on Switch Control:
        // without it the menu can be opened but only left by committing to a
        // destination, since the scrim is a tap target no assistive technology
        // announces and the toolbar button is inside the hidden app.
        .accessibilityAction(.escape) { close() }
    }

    private var contentLayer: some View {
        content
            // Cancels whatever the touch had started on the moment it becomes
            // a reveal, so a finger that landed on a row and then swiped does
            // not also fire that row on release.
            .disabled(progress > 0)
            // Applied before `.overlay` so the scrim, which is the way back,
            // stays both interactive and audible while the app is inert.
            .accessibilityHidden(isOpen)
            .overlay { scrim }
            // Masked rather than clipped, with the *mask* ignoring the safe
            // area. A clip would cut the app off at its safe-area frame and
            // let the menu show through behind the status bar; expanding the
            // app itself instead would push its navigation bar up under the
            // clock. Masking moves neither, and rounds the corners where the
            // screen's own corners are.
            .mask { revealShape.ignoresSafeArea() }
            // Drawn after the mask so it lands exactly on the cut edge. In
            // dark mode this hairline, not the scrim, is what separates the
            // app from the menu: the two surfaces are only a few levels
            // apart, and `Theme.border` is lighter than both.
            .overlay {
                revealShape
                    .strokeBorder(Theme.border.opacity(Double(progress)), lineWidth: 1)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
            }
            // The shadow is cast by a bare shape *behind* the app rather than
            // by the app itself — an identical edge, without rasterising a
            // live transcript offscreen on every frame of the drag. The fill
            // only exists to have something to cast it.
            .background {
                revealShape
                    .fill(Theme.bgPrimary)
                    .ignoresSafeArea()
                    .shadow(
                        color: .black.opacity(
                            MenuReveal.shadowOpacity(isLight: colorScheme == .light)
                                * Double(progress)
                        ),
                        radius: MenuReveal.shadowRadius(isLight: colorScheme == .light) * progress,
                        x: MenuReveal.shadowOffsetX * progress
                    )
            }
            .offset(x: travel * progress)
    }

    /// Corners round as the app lifts away, reaching the screen's own radius
    /// at full travel — so what stands on the trailing edge reads as the
    /// screen it came from, not a rectangle laid over one.
    private var revealShape: RoundedRectangle {
        RoundedRectangle(cornerRadius: MenuReveal.screenCornerRadius * progress, style: .continuous)
    }

    /// Wash over the departing app, and — once it has fully arrived — the tap
    /// target that brings it back.
    ///
    /// Always present, never conditional: a scrim inserted and removed by an
    /// `if` stays in the hierarchy for the length of its removal transition,
    /// still holding the hit-testing it had when the menu was open, and spends
    /// that time swallowing every tap in the app. Driven purely by `progress`
    /// it also cross-fades instead of popping.
    private var scrim: some View {
        Color.black
            .opacity(MenuReveal.scrimOpacity * Double(progress))
            // Reaches the status bar and the home indicator, which the app
            // paints behind and the overlay's own frame excludes.
            .ignoresSafeArea()
            .onTapGesture { close() }
            .accessibilityLabel("Close menu")
            .accessibilityAddTraits(.isButton)
            // Inert until the menu has fully arrived: transparent at rest, and
            // mid-drag it must never compete with the gesture placing it.
            .allowsHitTesting(progress >= 1)
            // Withdrawn from the accessibility tree by the same rule. Traits
            // survive `allowsHitTesting(false)`, so leaving this on would
            // spread a full-screen "Close menu" button across the app at rest:
            // VoiceOver would announce a control that is not there, and
            // everything beneath it — a list row's swipe actions among them —
            // would report as covered and refuse taps.
            .accessibilityHidden(progress < 1)
    }

    /// Carries the app on from where the finger left it, at the speed it left,
    /// to whichever end of the travel the drag committed to.
    private func settle(velocity: CGFloat) {
        let outcome = MenuReveal.releaseOutcome(
            velocity: velocity,
            dragDistance: dragDistance,
            travel: travel,
            isOpen: isOpen
        )
        let current = restingDistance + dragDistance
        let remaining = (outcome.shouldOpen ? travel : 0) - current
        if outcome.emitsFeedback {
            feedbackGenerator.impactOccurred(intensity: 0.7)
        }
        withAnimation(MenuReveal.releaseAnimation(
            initialVelocity: MenuReveal.initialVelocity(velocity: velocity, remaining: remaining)
        )) {
            isOpen = outcome.shouldOpen
            dragDistance = 0
        }
    }

    private func close() {
        withAnimation(MenuReveal.openCloseAnimation) { isOpen = false }
    }
}

#if DEBUG
/// Stand-in for a section view, so the container's own choreography can be
/// previewed and snapshotted without building a populated `AppStore`.
@available(iOS 17.0, *)
private struct MenuRevealPreviewContent: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HStack {
                Image(systemName: "line.3.horizontal").foregroundStyle(Theme.textPrimary)
                Spacer()
                Text("Ask").font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.textPrimary)
                Spacer()
                Image(systemName: "square.and.pencil").foregroundStyle(Theme.textPrimary)
            }
            .padding(.horizontal, Theme.Spacing.lg)
            ForEach(0 ..< 6) { index in
                RoundedRectangle(cornerRadius: Theme.Radius.large)
                    .fill(Theme.bgSecondary)
                    .frame(height: index.isMultiple(of: 2) ? 64 : 96)
                    .padding(.horizontal, Theme.Spacing.lg)
            }
            Spacer()
        }
        .padding(.top, Theme.Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
    }
}

@available(iOS 17.0, *)
private struct MenuRevealPreviewMenu: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            Text("Omnesis").font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            ForEach(["Search", "Briefs", "Sources", "People"], id: \.self) { label in
                Text(label).font(.system(size: 18)).foregroundStyle(Theme.textPrimary)
            }
            Spacer()
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, 60)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgDrawer.ignoresSafeArea())
    }
}

@available(iOS 17.0, *)
#Preview("MenuReveal — open") {
    MenuRevealContainer(isOpen: .constant(true)) {
        MenuRevealPreviewMenu()
    } content: {
        MenuRevealPreviewContent()
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MenuReveal — mid-drag") {
    MenuRevealContainer(isOpen: .constant(false), progressOverride: 0.45) {
        MenuRevealPreviewMenu()
    } content: {
        MenuRevealPreviewContent()
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MenuReveal — mid-drag, light") {
    MenuRevealContainer(isOpen: .constant(false), progressOverride: 0.45) {
        MenuRevealPreviewMenu()
    } content: {
        MenuRevealPreviewContent()
    }
    .preferredColorScheme(.light)
}

// The first moments of the travel, where the corner radius is only a few
// points on an already-lifted shape — the frame most likely to read as an
// artefact rather than an intention.
@available(iOS 17.0, *)
#Preview("MenuReveal — barely moved") {
    MenuRevealContainer(isOpen: .constant(false), progressOverride: 0.08) {
        MenuRevealPreviewMenu()
    } content: {
        MenuRevealPreviewContent()
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MenuReveal — closed") {
    MenuRevealContainer(isOpen: .constant(false)) {
        MenuRevealPreviewMenu()
    } content: {
        MenuRevealPreviewContent()
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("MenuReveal — open, light") {
    MenuRevealContainer(isOpen: .constant(true)) {
        MenuRevealPreviewMenu()
    } content: {
        MenuRevealPreviewContent()
    }
    .preferredColorScheme(.light)
}

// The real composition — the actual menu under the actual Agent surface —
// rather than the stand-ins above.
@available(iOS 17.0, *)
#Preview("MenuReveal — real menu over Agent") {
    @Previewable @State var isOpen = true
    return MenuRevealContainer(isOpen: $isOpen) {
        MainMenuDrawer(isOpen: $isOpen, selection: .constant(.agent), onOpenSettings: {})
    } content: {
        AgentView(menuOpen: $isOpen)
    }
    .environment(AppStore.preview(agentPreview: PreviewMocks.agentConversationsRich))
    .preferredColorScheme(.dark)
}
#endif
#endif
