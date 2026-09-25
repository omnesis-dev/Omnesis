// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// The reveal's drag, as a real `UIPanGestureRecognizer` rather than a
/// SwiftUI `DragGesture`.
///
/// SwiftUI's gesture has no way to *lose*. Attached with `simultaneousGesture`
/// it fires alongside whatever UIKit is doing, and UIKit owns three rightward
/// drags this one competes with: going back, a row putting its swipe actions
/// away, and horizontal scrolling. Every attempt to infer those from outside
/// either could not see them — a `NavigationStack` exposes no navigation
/// controller to find, and preferences do not cross a navigation destination —
/// or was so broad it suppressed the reveal everywhere.
///
/// A recogniser can simply be told to lose. `shouldRequireFailureOf` names the
/// competitors as objects, so the reveal begins only once they have declined
/// the touch, and `cancelsTouchesInView = false` keeps every button and row
/// underneath behaving exactly as it would without it.
///
/// The recogniser lives on the **window**, not on this view: a recogniser only
/// receives touches delivered to its own view or a descendant, and this view
/// deliberately hit-tests to nothing so it never takes a touch from the app.
@available(iOS 17.0, *)
struct MenuRevealPanGesture: UIViewRepresentable {
    /// Decides, once per touch, whether this is a reveal. Called when the pan
    /// clears its own slop, with the translation and velocity so far.
    let shouldBegin: (_ start: CGPoint, _ translation: CGPoint, _ velocity: CGPoint) -> Bool
    let onChanged: (_ translation: CGPoint) -> Void
    let onEnded: (_ velocity: CGPoint) -> Void
    /// A touch taken away mid-drag — a system gesture winning late, the app
    /// leaving the foreground. Without it the app is left part-revealed and
    /// inert, with nothing to tap and no way back short of a relaunch.
    let onCancelled: () -> Void

    func makeUIView(context: Context) -> MenuRevealPanHostView {
        MenuRevealPanHostView(coordinator: context.coordinator)
    }

    func updateUIView(_ view: MenuRevealPanHostView, context: Context) {
        context.coordinator.gesture = self
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(gesture: self)
    }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var gesture: MenuRevealPanGesture
        /// Where the touch went down, in window coordinates.
        private var start: CGPoint = .zero

        init(gesture: MenuRevealPanGesture) {
            self.gesture = gesture
        }

        @objc
        func handle(_ recognizer: UIPanGestureRecognizer) {
            switch recognizer.state {
            case .began, .changed:
                gesture.onChanged(recognizer.translation(in: recognizer.view))
            case .ended:
                gesture.onEnded(recognizer.velocity(in: recognizer.view))
            case .cancelled, .failed:
                gesture.onCancelled()
            default:
                break
            }
        }

        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
            // This recogniser sits on the window, above SwiftUI's presentation
            // boundary. A sheet therefore does not shield the presenter from
            // it: without this gate, dragging modal content moves the menu and
            // app underneath while the modal itself stays put.
            let window = recognizer.view as? UIWindow ?? recognizer.view?.window
            guard !Self.hasPresentedContent(
                in: window?.rootViewController
            ) else { return false }
            start = pan.location(in: nil)
            let translation = pan.translation(in: pan.view)
            // `location` is where the finger is *now*; the touch went down a
            // translation ago, and the reveal's rules are about where it began.
            let origin = CGPoint(x: start.x - translation.x, y: start.y - translation.y)
            start = origin
            return gesture.shouldBegin(origin, translation, pan.velocity(in: pan.view))
        }

        /// Whether any controller hosted by the window currently owns a modal
        /// presentation. SwiftUI may present from a nested hosting controller,
        /// so checking only the root's `presentedViewController` is not enough.
        private static func hasPresentedContent(in controller: UIViewController?) -> Bool {
            guard let controller else { return false }
            if controller.presentedViewController != nil { return true }
            return controller.children.contains { hasPresentedContent(in: $0) }
        }

        /// Runs alongside everything by default — vertical scrolling has to
        /// keep working, and this recogniser has already refused any touch
        /// that is not a horizontal reveal.
        func gestureRecognizer(
            _ recognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        )
            -> Bool {
            true
        }

        /// The arbitration this whole type exists for: the reveal waits for
        /// the gestures UIKit owns to decline the touch first, and never
        /// begins at all if one of them takes it.
        func gestureRecognizer(
            _ recognizer: UIGestureRecognizer,
            shouldRequireFailureOf other: UIGestureRecognizer
        )
            -> Bool {
            Self.ownsRightwardDrags(other)
        }

        /// Recognisers whose job is also "a rightward drag means something".
        ///
        /// Matched partly by class *name* because the swipe-action and
        /// navigation-transition recognisers are not public types. That is a
        /// read of a name, never a call into one, and it fails safe: if a name
        /// changes this stops matching and the behaviour is what it is today,
        /// rather than broken.
        static func ownsRightwardDrags(_ other: UIGestureRecognizer) -> Bool {
            if other is UIScreenEdgePanGestureRecognizer { return true }
            let name = NSStringFromClass(type(of: other))
            if name.contains("SwipeAction") { return true }
            // The interactive back gesture, whichever shape it takes.
            if name.contains("InteractivePop") || name.contains("NavigationTransition") {
                return true
            }
            // A scroll view that can actually scroll horizontally: a code
            // block, a wide table, a rail of cards.
            if let pan = other as? UIPanGestureRecognizer,
               let scroll = pan.view as? UIScrollView,
               scroll.contentSize.width > scroll.bounds.width + 1 {
                return true
            }
            return false
        }
    }
}

/// Hosts the recogniser without ever taking a touch itself.
@available(iOS 17.0, *)
final class MenuRevealPanHostView: UIView {
    private let recognizer: UIPanGestureRecognizer

    init(coordinator: MenuRevealPanGesture.Coordinator) {
        recognizer = UIPanGestureRecognizer(
            target: coordinator,
            action: #selector(MenuRevealPanGesture.Coordinator.handle(_:))
        )
        recognizer.delegate = coordinator
        // Everything underneath keeps its own touches: buttons still press,
        // rows still swipe. Without this the reveal would cancel them the
        // moment it started watching, which is how a list row's swipe actions
        // came to stop responding to taps entirely.
        recognizer.cancelsTouchesInView = false
        recognizer.delaysTouchesBegan = false
        recognizer.delaysTouchesEnded = false
        super.init(frame: .zero)
        isUserInteractionEnabled = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        recognizer.view?.removeGestureRecognizer(recognizer)
        window?.addGestureRecognizer(recognizer)
    }

    /// Never the target of a touch — the recogniser is on the window, and this
    /// view exists only to own its lifetime alongside the SwiftUI view tree.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        nil
    }
}
#endif
