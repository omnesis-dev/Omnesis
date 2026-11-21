// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import SwiftUI
import UIKit
import XCTest

/// The Timeline drawer's scrim as UIKit draws it. The drawer is mounted for
/// as long as a conversation is on screen, open or not, so whatever its
/// closed state keeps alive stays alive with it: a paused animation there
/// never finishes, and XCUITest, which waits for an app's animations to
/// finish before every tap, then waits out its full timeout on each one.
@MainActor
final class CitationsDrawerScrimTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        super.tearDown()
    }

    private func drawer(open: Bool) -> AnyView {
        AnyView(
            ZStack {
                Theme.bgPrimary.ignoresSafeArea()
                CitationsDrawer(isOpen: .constant(open))
            }
            .environment(AppStore.preview(agentPreview: .init()))
        )
    }

    /// Hosts the drawer in a visible window and lets it settle.
    private func host(open: Bool) throws -> UIHostingController<AnyView> {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
            "the hosted test run has no window scene"
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let controller = UIHostingController(rootView: drawer(open: open))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        settle()
        return controller
    }

    private func settle() {
        for _ in 0 ..< 10 {
            window?.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
    }

    /// The effect views that draw a blur.
    private func blurs(in view: UIView) -> [UIVisualEffectView] {
        if let effectView = view as? UIVisualEffectView { return effectView.effect == nil ? [] : [effectView] }
        return view.subviews.flatMap(blurs)
    }

    /// Animations that never finish on their own: paused, or repeating forever.
    private func unendingAnimations(in layer: CALayer) -> [String] {
        let own = (layer.animationKeys() ?? []).compactMap { key -> String? in
            guard let animation = layer.animation(forKey: key) else { return nil }
            return animation.speed == 0 || animation.repeatCount == .infinity
                || animation.repeatCount >= Float(Int32.max) ? "\(type(of: layer)).\(key)" : nil
        }
        return own + (layer.sublayers ?? []).flatMap(unendingAnimations)
    }

    func testAClosedDrawerKeepsNoBlurOrUnfinishedAnimation() throws {
        _ = try host(open: false)
        let window = try XCTUnwrap(window)
        XCTAssertEqual(blurs(in: window).count, 0, "the closed drawer still draws its blur")
        XCTAssertEqual(unendingAnimations(in: window.layer), [])
    }

    func testTheOpenDrawerBlursTheConversationAndDropsTheBlurWhenClosed() throws {
        let controller = try host(open: true)
        let window = try XCTUnwrap(window)
        XCTAssertEqual(blurs(in: window).count, 1, "the open drawer does not blur the conversation")

        controller.rootView = drawer(open: false)
        settle()
        XCTAssertEqual(blurs(in: window).count, 0, "closing the drawer leaves its blur behind")
        XCTAssertEqual(unendingAnimations(in: window.layer), [])
    }
}
