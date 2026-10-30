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

    func testDisappearingDuringInitialLoadCannotStartPollingAfterLateResponse() async {
        let started = expectation(description: "initial models request started")
        var release: CheckedContinuation<ModelsOverview, Never>?
        var sleeps = 0
        var refreshes = 0
        let gate = ModelOverviewRefreshGate()
        let lifetime = Task {
            await gate.refreshWhileVisible(
                load: {
                    let outcome = await gate.fetch {
                        started.fulfill()
                        return await withCheckedContinuation { release = $0 }
                    }
                    guard case .stale = outcome else {
                        XCTFail("the canceled screen must ignore the late response")
                        return
                    }
                },
                interval: { .seconds(15) },
                refresh: { refreshes += 1 },
                sleep: { _ in sleeps += 1 }
            )
        }
        await fulfillment(of: [started], timeout: 2)
        lifetime.cancel()
        release?.resume(returning: overview(effort: "high"))
        await lifetime.value
        XCTAssertEqual(sleeps, 0)
        XCTAssertEqual(refreshes, 0)
    }

    func testDisappearingDuringDelayDoesNotIssueAnotherRequest() async {
        let sleeping = expectation(description: "visible models screen waiting to refresh")
        var release: CheckedContinuation<Void, Never>?
        var refreshes = 0
        let gate = ModelOverviewRefreshGate()
        let lifetime = Task {
            await gate.refreshWhileVisible(
                load: {},
                interval: { .seconds(15) },
                refresh: { refreshes += 1 },
                sleep: { _ in
                    sleeping.fulfill()
                    await withCheckedContinuation { release = $0 }
                }
            )
        }
        await fulfillment(of: [sleeping], timeout: 2)
        lifetime.cancel()
        release?.resume()
        await lifetime.value
        XCTAssertEqual(refreshes, 0)
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
