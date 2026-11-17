// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import OSLog
#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit
#endif

/// Where UI automation's taps land, and whether the control under them acted.
///
/// A failed UI journey records what was on screen, but not whether a tap
/// reached the app at all, which view it hit, or whether the control's action
/// ran. A DEBUG build launched with `DEMO_TOUCH_LOG=1` logs each of these
/// under the `touch` category of `AppLog.subsystem`, and the journey lane keeps
/// the simulator's log of that category beside the result bundle. A release
/// build installs nothing and logs nothing.
enum AutomationTouchLog {
    #if DEBUG
    static let enabled = ProcessInfo.processInfo.environment["DEMO_TOUCH_LOG"] == "1"
    static let log = AppLog.make(category: "touch")
    #endif

    /// Records that a menu control's action ran. `id` matches the control's
    /// accessibility identifier, so a line pairs with the test step that
    /// tapped it.
    static func menuAction(_ id: String) {
        #if DEBUG
        guard enabled else { return }
        log.notice("menu action ran: \(id, privacy: .public)")
        #endif
    }
}

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
@available(iOS 17.0, *)
extension View {
    /// Installs the window-level touch log when `DEMO_TOUCH_LOG` asks for it.
    /// No-op otherwise.
    @ViewBuilder
    func automationTouchLog() -> some View {
        if AutomationTouchLog.enabled {
            background(TouchDeliveryInstaller())
        } else {
            self
        }
    }
}

/// Owns the observer's lifetime alongside the SwiftUI tree and attaches it to
/// the window, the one place every touch passes through.
private struct TouchDeliveryInstaller: UIViewRepresentable {
    func makeUIView(context: Context) -> TouchDeliveryHostView {
        TouchDeliveryHostView()
    }

    func updateUIView(_ view: TouchDeliveryHostView, context: Context) {}
}

private final class TouchDeliveryHostView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        // A system alert over the app makes it resign active, which cancels
        // the touch in progress: the log says when that happened. Selector
        // observers are dropped with the view.
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil
        )
    }

    @objc
    private func willResignActive() {
        AutomationTouchLog.log.notice("app will resign active")
    }

    @objc
    private func didBecomeActive() {
        AutomationTouchLog.log.notice("app became active")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard let window,
              !(window.gestureRecognizers ?? []).contains(where: { $0 is TouchDeliveryObserver })
        else { return }
        window.addGestureRecognizer(TouchDeliveryObserver())
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        nil
    }
}

/// Watches every touch on its window and never recognises anything: it
/// cancels, delays and blocks no touch, and fails once the touch ends. It
/// recognises alongside every other recogniser, so one that takes the touch
/// does not stop it from seeing how the touch ended.
///
/// For each touch it logs where it went down and the chain of views it hit,
/// then how it ended and the state every recogniser attached to it reached.
/// A tap that never shows up here did not reach the app's window. For one that
/// hit the control while its action line is missing, the end line's recogniser
/// states say which gesture took the touch or failed to act on it.
private final class TouchDeliveryObserver: UIGestureRecognizer, UIGestureRecognizerDelegate {
    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    )
        -> Bool {
        true
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        for touch in touches {
            let point = Self.describe(touch.location(in: nil))
            let chain = Self.viewChain(from: view?.hitTest(touch.location(in: view), with: event))
            AutomationTouchLog.log.notice("touch began at \(point, privacy: .public) on \(chain, privacy: .public)")
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        log(touches, phase: "ended")
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        log(touches, phase: "cancelled")
        state = .failed
    }

    private func log(_ touches: Set<UITouch>, phase: String) {
        for touch in touches {
            let point = Self.describe(touch.location(in: nil))
            let recognizers = (touch.gestureRecognizers ?? [])
                .filter { $0 !== self }
                .map { "\(type(of: $0))=\(Self.describe($0.state))" }
                .joined(separator: ", ")
            AutomationTouchLog.log.notice(
                "touch \(phase, privacy: .public) at \(point, privacy: .public); recognizers: \(recognizers, privacy: .public)"
            )
        }
    }

    /// The hit view and its first ancestors, innermost first. Type names only:
    /// the classes say which layer took the touch without carrying content.
    private static func viewChain(from hit: UIView?) -> String {
        guard let hit else { return "no view" }
        return sequence(first: hit, next: \.superview)
            .prefix(8)
            .map { String(describing: type(of: $0)) }
            .joined(separator: " < ")
    }

    private static func describe(_ point: CGPoint) -> String {
        "(\(Int(point.x.rounded())), \(Int(point.y.rounded())))"
    }

    private static func describe(_ state: UIGestureRecognizer.State) -> String {
        switch state {
        case .possible: "possible"
        case .began: "began"
        case .changed: "changed"
        case .ended: "recognized"
        case .cancelled: "cancelled"
        case .failed: "failed"
        @unknown default: "unknown"
        }
    }
}
#endif
