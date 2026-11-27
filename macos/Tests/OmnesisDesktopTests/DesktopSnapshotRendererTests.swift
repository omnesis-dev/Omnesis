// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import ScreenCaptureKit
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
}
