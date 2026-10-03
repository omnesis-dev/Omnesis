// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import SwiftUI
import UIKit
import XCTest

/// The breadcrumb's rich text as UIKit builds it on screen: the long-press
/// gestures a person can make on a linked document title, and what VoiceOver
/// is offered for the same links.
@MainActor
final class SearchBreadcrumbInteractionTests: XCTestCase {
    private var window: UIWindow?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        super.tearDown()
    }

    /// Hosts the breadcrumbs in a visible window and returns each rendered
    /// fact's text view, in reading order.
    private func renderedFacts() throws -> [UITextView] {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
            "the hosted test run has no window scene"
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = UIHostingController(rootView: NavigationStack {
            SearchBreadcrumbsView(
                provenance: PreviewMocks.searchProvenance,
                documentId: "sample-root",
                store: AppStore.preview()
            ).padding()
        })
        window.makeKeyAndVisible()
        self.window = window
        for _ in 0 ..< 5 {
            window.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        let views = textViews(in: window)
        XCTAssertFalse(views.isEmpty, "the breadcrumbs rendered no text")
        return views
    }

    private func textViews(in view: UIView) -> [UITextView] {
        if let text = view as? UITextView { return [text] }
        return view.subviews.flatMap(textViews)
    }

    private func linkRanges(_ view: UITextView) -> [NSRange] {
        var ranges: [NSRange] = []
        let text = view.attributedText ?? NSAttributedString()
        text.enumerateAttribute(.link, in: NSRange(location: 0, length: text.length)) { value, range, _ in
            if value != nil { ranges.append(range) }
        }
        return ranges
    }

    /// UIKit's text drag of a link range holding the document's icon raises
    /// a range exception while it builds the drag item, so a long-press on a
    /// linked title must only ever reach the link's menu.
    func testLongPressOnALinkedTitleNeverStartsATextDrag() throws {
        let facts = try renderedFacts()
        XCTAssertTrue(facts.contains { !linkRanges($0).isEmpty }, "no fact rendered a document link")
        for view in facts {
            let drag = try XCTUnwrap(view.textDragInteraction, "a breadcrumb has no text drag to turn off")
            XCTAssertFalse(drag.isEnabled, "a long-press on \(view.text ?? "") would start a text drag")
        }
    }

    /// VoiceOver reads each fact as one sentence and offers every linked
    /// document as its own action.
    func testEveryLinkedDocumentStaysReachableForVoiceOver() throws {
        let facts = SearchBreadcrumbFormatter.facts(PreviewMocks.searchProvenance, documentId: "sample-root")
        let views = try renderedFacts()
        XCTAssertEqual(views.count, facts.count)
        for (view, fact) in zip(views, facts) {
            XCTAssertEqual(view.accessibilityLabel, fact.plainText)
            XCTAssertEqual(
                view.accessibilityCustomActions?.map(\.name),
                fact.links.map { "Open \($0.displayTitle)" }
            )
        }
    }
}
