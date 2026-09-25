// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@MainActor
final class ModelOverviewRefreshGateTests: XCTestCase {
    func testDeferredPrePatchGetCannotReplacePostPatchOverview() async {
        let firstStarted = expectation(description: "pre-PATCH GET started")
        var releaseFirst: CheckedContinuation<ModelsOverview, Never>?
        let gate = ModelOverviewRefreshGate()
        let before = overview(effort: "low")
        let after = overview(effort: "high")

        let first = Task {
            await gate.fetch {
                firstStarted.fulfill()
                return await withCheckedContinuation { releaseFirst = $0 }
            }
        }
        await fulfillment(of: [firstStarted], timeout: 2)
        let second = await gate.fetch { after }
        releaseFirst?.resume(returning: before)

        guard case .loaded(let current, let ticket) = second else {
            XCTFail("post-PATCH overview should be accepted")
            return
        }
        XCTAssertTrue(gate.isCurrent(ticket))
        XCTAssertEqual(current.modelSettings["agent"]?.values.reasoningEffort, "high")
        guard case .stale = await first.value else {
            XCTFail("deferred pre-PATCH GET must be ignored")
            return
        }
    }

    func testDeferredGetFailureCannotReplaceNewerSuccessfulOverview() async {
        let firstStarted = expectation(description: "older GET started")
        var releaseFirst: CheckedContinuation<ModelsOverview, Error>?
        let gate = ModelOverviewRefreshGate()
        let first = Task {
            await gate.fetch {
                firstStarted.fulfill()
                return try await withCheckedThrowingContinuation { releaseFirst = $0 }
            }
        }
        await fulfillment(of: [firstStarted], timeout: 2)
        let second = await gate.fetch { overview(effort: "medium") }
        releaseFirst?.resume(throwing: URLError(.cannotConnectToHost))

        guard case .loaded(let current, _) = second else {
            XCTFail("newer successful GET should be accepted")
            return
        }
        XCTAssertEqual(current.modelSettings["agent"]?.values.reasoningEffort, "medium")
        guard case .stale = await first.value else {
            XCTFail("older failure must not become the visible load error")
            return
        }
    }

    private func overview(effort: String) -> ModelsOverview {
        ModelsOverview(
            assignmentDisplays: [:],
            capabilities: [],
            inference: InferenceOverview(backends: [:], assignments: [:]),
            catalog: [],
            installed: [],
            modelSettings: [
                "agent": ModelSettings(
                    assignment: "openai/gpt-example",
                    values: ModelBehaviorValues(reasoningEffort: effort)
                ),
            ]
        )
    }
}
