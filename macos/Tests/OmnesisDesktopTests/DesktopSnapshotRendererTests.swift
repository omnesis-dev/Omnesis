// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import AppKit
import Foundation
import ScreenCaptureKit
import SwiftUI
import XCTest

@MainActor
final class DesktopSnapshotRendererTests: XCTestCase {
    func testScreenCaptureFailureKeepsOnlyPublicCategoryCodeAndObservedStage() throws {
        let privateText = "invented private capture context"
        let failure = NSError(
            domain: SCStreamErrorDomain, code: -3811,
            userInfo: [NSLocalizedDescriptionKey: privateText, "nested": ["arbitrary": privateText]]
        )
        let facts = DesktopSnapshotRenderer.captureFailureFacts(failure, stage: .captureImage)
        XCTAssertEqual(Set(facts.keys), ["captureStage", "captureErrorCategory", "captureErrorCode", "captureErrorCodeClamped"])
        XCTAssertEqual(facts["captureStage"] as? String, "capture-image")
        XCTAssertEqual(facts["captureErrorCategory"] as? String, "screen-capture-kit")
        XCTAssertEqual(facts["captureErrorCode"] as? Int, -3811)
        XCTAssertEqual(facts["captureErrorCodeClamped"] as? Bool, false)
        let bytes = try JSONSerialization.data(withJSONObject: facts)
        XCTAssertLessThanOrEqual(bytes.count, 256)
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains(privateText))
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains(SCStreamErrorDomain))
    }

    func testOtherErrorDomainsAndUnboundedMessagesCannotEnterCaptureFacts() throws {
        let domain = "invented-private-error-domain"
        let secret = String(repeating: "invented confidential message ", count: 1000)
        for (code, expected) in [(Int.min, Int(Int32.min)), (Int.max, Int(Int32.max)), (0, 0)] {
            let failure = NSError(domain: domain, code: code, userInfo: [NSLocalizedDescriptionKey: secret])
            let facts = DesktopSnapshotRenderer.captureFailureFacts(failure, stage: .currentProcessContent)
            XCTAssertEqual(facts["captureStage"] as? String, "current-process-content")
            XCTAssertEqual(facts["captureErrorCategory"] as? String, "other")
            XCTAssertEqual(facts["captureErrorCode"] as? Int, expected)
            XCTAssertEqual(facts["captureErrorCodeClamped"] as? Bool, code != expected)
            let bytes = try JSONSerialization.data(withJSONObject: facts)
            XCTAssertLessThanOrEqual(bytes.count, 256)
            let text = String(decoding: bytes, as: UTF8.self)
            XCTAssertFalse(text.contains(domain))
            XCTAssertFalse(text.contains("confidential"))
        }
    }

    func testOrdinaryViewportDoesNotShrinkToANaturallySizedRoot() async throws {
        let size = CGSize(width: 620, height: 560)
        let compact = VStack(alignment: .leading) {
            Text("Fictional naturally sized content").accessibilityIdentifier("renderer-natural-content")
        }.padding(24).frame(width: 300).fixedSize(horizontal: false, vertical: true)
        var appearances = 0
        try await DesktopSnapshotRenderer.renderVisibleWindow(compact, name: "renderer-natural-root-viewport", size: size) { hosting in
            let window = try XCTUnwrap(hosting.window)
            XCTAssertEqual(hosting.bounds.size, size)
            XCTAssertGreaterThanOrEqual(window.contentLayoutRect.width, size.width)
            XCTAssertGreaterThanOrEqual(window.contentLayoutRect.height, size.height)
            let text = try DesktopAccessibilityDriver.element("renderer-natural-content", in: hosting)
            let frame = text.accessibilityFrame()
            let viewport = window.convertToScreen(hosting.convert(hosting.bounds, to: nil))
            XCTAssertTrue([frame.minX, frame.minY, frame.width, frame.height].allSatisfy(\.isFinite))
            XCTAssertGreaterThan(frame.width, 0)
            XCTAssertGreaterThan(frame.height, 0)
            XCTAssertLessThan(frame.height, size.height, "The fixture must not stretch the natural content to fake its viewport")
            XCTAssertTrue(viewport.contains(frame))
            appearances += 1
        }
        XCTAssertEqual(appearances, 2)
    }
}
