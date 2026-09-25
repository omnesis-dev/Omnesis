// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// "Waiting for iOS…" is shown only while a prompt is really up, and an answer
/// the user has already given never counts as one.
@MainActor
final class SystemPromptActivityTests: XCTestCase {
    private struct Refused: Error {}

    func testAnAnswerAlreadyGivenNeverCountsAsAPrompt() async {
        let activity = SystemPromptActivity()
        var sawPrompt = false

        let value = await activity.during(false) {
            sawPrompt = activity.isPromptUp
            return 7
        }

        XCTAssertEqual(value, 7)
        XCTAssertFalse(sawPrompt)
        XCTAssertFalse(activity.isPromptUp)
    }

    func testAPromptCountsOnlyWhileItsRequestRuns() async {
        let activity = SystemPromptActivity()
        var sawPrompt = false

        await activity.during(true) {
            sawPrompt = activity.isPromptUp
        }

        XCTAssertTrue(sawPrompt)
        XCTAssertFalse(activity.isPromptUp)
    }

    func testAFailedRequestStillEndsItsPrompt() async {
        let activity = SystemPromptActivity()

        do {
            try await activity.during(true) { throw Refused() }
        } catch {}

        XCTAssertFalse(activity.isPromptUp)
    }

    func testOverlappingPromptsStayUpUntilTheLastEnds() {
        let activity = SystemPromptActivity()

        activity.begin()
        activity.begin()
        activity.end()
        XCTAssertTrue(activity.isPromptUp)
        activity.end()
        XCTAssertFalse(activity.isPromptUp)
        activity.end()
        XCTAssertFalse(activity.isPromptUp, "an extra end cannot go below zero")
    }
}
