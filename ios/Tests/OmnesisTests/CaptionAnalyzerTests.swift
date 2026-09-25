// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Records every call so tests can assert the analyzer sends each
/// photo's labels independently (no accumulated transcript state) and
/// skips the model entirely when there is nothing to describe.
private actor MockCaptionModel: CaptionLanguageModel {
    enum Behavior {
        case caption(String)
        case failure(Error)
        case unavailable
    }

    private let behavior: Behavior
    private(set) var captionCalls: [[String]] = []

    init(_ behavior: Behavior) {
        self.behavior = behavior
    }

    func isAvailable() async -> Bool {
        if case .unavailable = behavior { return false }
        return true
    }

    func caption(fromLabels labels: [String]) async throws -> String {
        captionCalls.append(labels)
        switch behavior {
        case .caption(let text): return text
        case .failure(let error): throw error
        case .unavailable: throw CaptionModelError.unavailable
        }
    }
}

private struct FakeModelError: Error {}

final class CaptionAnalyzerTests: XCTestCase {
    func testSuccessfulCaptionYieldsPrefixedTextLine() async {
        let model = MockCaptionModel(.caption("A dog runs along a sandy beach."))
        let fragment = await CaptionAnalyzer.captionFragment(labels: ["dog", "beach"], model: model)
        XCTAssertEqual(fragment?.textLines, ["LLM caption: A dog runs along a sandy beach."])
    }

    func testEachPhotoPromptsWithOnlyItsOwnLabels() async {
        // Regression net for the session-lifecycle bug: consecutive
        // photos must not accumulate transcript state — each prompt
        // carries exactly the current photo's labels.
        let model = MockCaptionModel(.caption("A caption."))
        _ = await CaptionAnalyzer.captionFragment(labels: ["dog", "beach"], model: model)
        _ = await CaptionAnalyzer.captionFragment(labels: ["mountain"], model: model)
        let calls = await model.captionCalls
        XCTAssertEqual(calls, [["dog", "beach"], ["mountain"]])
    }

    func testEmptyLabelsSkipTheModel() async {
        let model = MockCaptionModel(.caption("Never used."))
        let fragment = await CaptionAnalyzer.captionFragment(labels: [], model: model)
        XCTAssertNil(fragment)
        let calls = await model.captionCalls
        XCTAssertTrue(calls.isEmpty)
    }

    func testUnavailableModelYieldsNoFragment() async {
        let model = MockCaptionModel(.unavailable)
        let fragment = await CaptionAnalyzer.captionFragment(labels: ["dog"], model: model)
        XCTAssertNil(fragment)
        let calls = await model.captionCalls
        XCTAssertTrue(calls.isEmpty)
    }

    func testGenerationFailureFallsBackToNoFragment() async {
        let model = MockCaptionModel(.failure(FakeModelError()))
        let fragment = await CaptionAnalyzer.captionFragment(labels: ["dog"], model: model)
        XCTAssertNil(fragment)
    }

    func testAnalyzerAvailabilityFollowsTheModel() async {
        let available = CaptionAnalyzer(model: MockCaptionModel(.caption("A caption.")))
        let availableResult = await available.isAvailable()
        XCTAssertTrue(availableResult)

        let unavailable = CaptionAnalyzer(model: MockCaptionModel(.unavailable))
        let unavailableResult = await unavailable.isAvailable()
        XCTAssertFalse(unavailableResult)
    }

    func testFailureCategoryForUnavailableModel() {
        XCTAssertEqual(
            CaptionAnalyzer.failureCategory(for: CaptionModelError.unavailable),
            "model-unavailable"
        )
    }

    func testFailureCategoryFallsBackToErrorTypeName() {
        XCTAssertEqual(
            CaptionAnalyzer.failureCategory(for: FakeModelError()),
            "FakeModelError"
        )
    }
}
