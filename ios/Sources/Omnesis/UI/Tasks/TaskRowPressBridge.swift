// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// The long press on a task row, as one UIKit recognizer on the list's
/// scroll view.
///
/// SwiftUI's long-press gesture reports no location, and a drag gesture
/// that could supply one takes the touch from the scroll view. A
/// `UILongPressGestureRecognizer` on the scroll view itself gives both: it
/// reports where the finger is from the moment the press is recognized, it
/// fails as soon as the finger moves before the press is held long enough —
/// so a drag still scrolls — and, once it begins, it cancels the touch for
/// the views under it, so a long press never also completes a task or opens
/// its details.
///
/// While a press owns the touch the bridge switches the scroll view's own
/// pan off, so sliding over the fan cannot scroll the list, and switches it
/// back on in the same step that ends the press — `TaskPressLifecycle`
/// guarantees that step comes exactly once, however the press ends. Nothing
/// about scrolling is left to view state, which can lag or be lost.
///
/// Two invisible probes wire it up: one inside the scroll content finds the
/// scroll view to attach to, and one behind the list marks
/// `TaskFanOverlay.space`, the coordinates the press is reported in.
@available(iOS 17.0, *)
@MainActor
final class TaskRowPressBridge: NSObject, UIGestureRecognizerDelegate {
    /// Whether a fan may open at a point — a press elsewhere is not a press
    /// on a task.
    var canBegin: (CGPoint) -> Bool = { _ in false }
    var began: (CGPoint) -> Void = { _ in }
    var moved: (CGPoint) -> Void = { _ in }
    /// The finger lifted at a point, or the touch was taken away (nil).
    var ended: (CGPoint?) -> Void = { _ in }

    /// How long a press is held before the fan opens.
    static let pressDuration: TimeInterval = 0.4

    private lazy var recognizer: UILongPressGestureRecognizer = {
        let recognizer = UILongPressGestureRecognizer(target: self, action: #selector(handle(_:)))
        recognizer.minimumPressDuration = Self.pressDuration
        recognizer.allowableMovement = 10
        recognizer.delegate = self
        return recognizer
    }()

    private var lifecycle = TaskPressLifecycle()
    /// The scroll view whose pan this press switched off, to switch back on.
    private weak var suspendedScrollView: UIScrollView?

    fileprivate weak var spaceView: UIView?

    fileprivate func attach(to scrollView: UIScrollView) {
        guard recognizer.view !== scrollView else { return }
        if recognizer.view != nil { run(lifecycle.handle(.detached)) }
        recognizer.view?.removeGestureRecognizer(recognizer)
        scrollView.addGestureRecognizer(recognizer)
    }

    /// Taken off screen: end any press it was in and give scrolling back.
    fileprivate func detach() {
        run(lifecycle.handle(.detached))
        recognizer.view?.removeGestureRecognizer(recognizer)
    }

    private func location(of recognizer: UIGestureRecognizer) -> CGPoint? {
        spaceView.map { recognizer.location(in: $0) }
    }

    @objc private func handle(_ recognizer: UILongPressGestureRecognizer) {
        let point = location(of: recognizer)
        let report: TaskPressLifecycle.Report? = switch recognizer.state {
        case .began: point.map { .began($0) }
        case .changed: point.map { .changed($0) }
        case .ended: .ended(point)
        case .cancelled: .cancelled
        case .failed: .failed
        default: nil
        }
        if let report { run(lifecycle.handle(report)) }
    }

    private func run(_ commands: [TaskPressLifecycle.Command]) {
        for command in commands {
            switch command {
            case .suspendScrolling:
                // Switching the pan off also cancels one already under way.
                let scrollView = recognizer.view as? UIScrollView
                scrollView?.panGestureRecognizer.isEnabled = false
                suspendedScrollView = scrollView
            case .resumeScrolling:
                suspendedScrollView?.panGestureRecognizer.isEnabled = true
                suspendedScrollView = nil
            case .begin(let point): began(point)
            case .move(let point): moved(point)
            case .end(let point): ended(point)
            }
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let point = location(of: gestureRecognizer) else { return false }
        return canBegin(point)
    }
}

/// Placed inside the scroll content: attaches the bridge to the enclosing
/// scroll view.
@available(iOS 17.0, *)
struct TaskRowPressScrollProbe: UIViewRepresentable {
    let bridge: TaskRowPressBridge

    func makeUIView(context _: Context) -> ProbeView {
        let view = ProbeView()
        view.bridge = bridge
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: ProbeView, context _: Context) {
        view.bridge = bridge
        view.attachIfPossible()
    }

    final class ProbeView: UIView {
        weak var bridge: TaskRowPressBridge?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window == nil {
                bridge?.detach()
            } else {
                attachIfPossible()
            }
        }

        func attachIfPossible() {
            var ancestor = superview
            while let view = ancestor, !(view is UIScrollView) {
                ancestor = view.superview
            }
            if let scrollView = ancestor as? UIScrollView { bridge?.attach(to: scrollView) }
        }
    }
}

/// Placed behind the list, filling it: the view presses are measured in.
@available(iOS 17.0, *)
struct TaskFanSpaceProbe: UIViewRepresentable {
    let bridge: TaskRowPressBridge

    func makeUIView(context _: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        bridge.spaceView = view
        return view
    }

    func updateUIView(_ view: UIView, context _: Context) {
        bridge.spaceView = view
    }
}
#endif
