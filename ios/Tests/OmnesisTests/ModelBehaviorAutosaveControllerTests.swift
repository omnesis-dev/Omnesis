// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

@MainActor
final class ModelBehaviorAutosaveControllerTests: XCTestCase {
    func testRapidChoicesSendFirstThenOnlyLatest() async {
        let firstStarted = expectation(description: "first PATCH started")
        let latestSaved = expectation(description: "latest PATCH finished")
        var releaseFirst: CheckedContinuation<Void, Never>?
        var sent: [ModelBehaviorValues] = []
        var expected: [ModelBehaviorValues] = []
        let controller = ModelBehaviorAutosaveController(initialValues: ModelBehaviorValues()) { values, baseline in
            sent.append(values)
            expected.append(baseline)
            if sent.count == 1 {
                firstStarted.fulfill()
                await withCheckedContinuation { releaseFirst = $0 }
            } else {
                latestSaved.fulfill()
            }
            return "Saved"
        }
        let low = ModelBehaviorValues(reasoningEffort: "low")
        let medium = ModelBehaviorValues(reasoningEffort: "medium")
        let high = ModelBehaviorValues(reasoningEffort: "high")
        controller.submit(.success(low))
        await fulfillment(of: [firstStarted], timeout: 2)
        controller.submit(.success(medium))
        controller.submit(.success(high))
        releaseFirst?.resume()
        await fulfillment(of: [latestSaved], timeout: 2)
        await Task.yield()
        XCTAssertEqual(sent, [low, high])
        XCTAssertEqual(expected, [ModelBehaviorValues(), low])
        XCTAssertEqual(controller.acknowledgedValues, high)
        XCTAssertNil(controller.error)
    }

    func testBudgetTypingSendsOnlyValueAfterQuietPeriod() async {
        let saved = expectation(description: "latest budget saved")
        var sent: [ModelBehaviorValues] = []
        let controller = ModelBehaviorAutosaveController(
            initialValues: ModelBehaviorValues(),
            budgetDelayNanoseconds: 20_000_000
        ) { values, _ in
            sent.append(values)
            saved.fulfill()
            return "Saved"
        }
        let partial = ModelBehaviorValues(reasoningBudgetTokens: 256)
        let final = ModelBehaviorValues(reasoningBudgetTokens: 2048)
        controller.debounceBudget(.success(partial))
        controller.debounceBudget(.success(final))
        await fulfillment(of: [saved], timeout: 2)
        await Task.yield()
        XCTAssertEqual(sent, [final])
        XCTAssertEqual(controller.acknowledgedValues, final)
    }

    func testResetQueuesBehindInflightPatchAndBecomesFinalValue() async {
        let firstStarted = expectation(description: "first PATCH started")
        let resetSaved = expectation(description: "reset PATCH finished")
        var releaseFirst: CheckedContinuation<Void, Never>?
        var sent: [ModelBehaviorValues] = []
        var expected: [ModelBehaviorValues] = []
        let controller = ModelBehaviorAutosaveController(initialValues: ModelBehaviorValues()) { values, baseline in
            sent.append(values)
            expected.append(baseline)
            if sent.count == 1 {
                firstStarted.fulfill()
                await withCheckedContinuation { releaseFirst = $0 }
            } else {
                resetSaved.fulfill()
            }
            return "Saved"
        }
        let strong = ModelBehaviorValues(reasoningEffort: "high")
        controller.submit(.success(strong))
        await fulfillment(of: [firstStarted], timeout: 2)
        controller.reset()
        releaseFirst?.resume()
        await fulfillment(of: [resetSaved], timeout: 2)
        await Task.yield()
        XCTAssertEqual(sent, [strong, ModelBehaviorValues()])
        XCTAssertEqual(expected, [ModelBehaviorValues(), strong])
        XCTAssertEqual(controller.acknowledgedValues, ModelBehaviorValues())
        XCTAssertEqual(controller.resetGeneration, 1)
    }

    func testIdleRefreshAdoptsExternalValuesButInflightPatchKeepsItsBaseline() async {
        let started = expectation(description: "PATCH started")
        let saved = expectation(description: "PATCH finished")
        var release: CheckedContinuation<Void, Never>?
        var sent: [ModelBehaviorValues] = []
        var expected: [ModelBehaviorValues] = []
        let low = ModelBehaviorValues(reasoningEffort: "low")
        let medium = ModelBehaviorValues(reasoningEffort: "medium")
        let high = ModelBehaviorValues(reasoningEffort: "high")
        let controller = ModelBehaviorAutosaveController(initialValues: low) { values, baseline in
            sent.append(values)
            expected.append(baseline)
            if sent.count == 1 {
                started.fulfill()
                await withCheckedContinuation { release = $0 }
            }
            saved.fulfill()
            return "Saved"
        }
        XCTAssertFalse(controller.reconcileExternal(medium, hasLocalDraft: true))
        XCTAssertTrue(controller.reconcileExternal(medium, hasLocalDraft: false))
        XCTAssertEqual(controller.acknowledgedValues, medium)
        controller.submit(.success(high))
        await fulfillment(of: [started], timeout: 2)
        XCTAssertFalse(controller.reconcileExternal(low, hasLocalDraft: false))
        release?.resume()
        await fulfillment(of: [saved], timeout: 2)
        await Task.yield()
        XCTAssertEqual(sent, [high])
        XCTAssertEqual(expected, [medium], "CAS expects the refreshed value at dispatch")
        XCTAssertEqual(controller.acknowledgedValues, high)
        for _ in 0 ..< 100 {
            if !controller.isSaving { break }
            await Task.yield()
        }
        XCTAssertFalse(controller.isSaving)
        XCTAssertTrue(controller.retryDeferredExternal(low, hasLocalDraft: false))
        XCTAssertEqual(controller.acknowledgedValues, low, "a skipped prop can be retried after the worker becomes idle")
    }

    func testSuccessfulPatchDoesNotReAdoptUnchangedStaleOverviewProp() async {
        let saved = expectation(description: "PATCH saved")
        let oldOverview = ModelBehaviorValues(reasoningEffort: "low")
        let chosen = ModelBehaviorValues(reasoningEffort: "high")
        let controller = ModelBehaviorAutosaveController(initialValues: oldOverview) { _, _ in
            saved.fulfill()
            return "Saved"
        }
        controller.submit(.success(chosen))
        await fulfillment(of: [saved], timeout: 2)
        for _ in 0 ..< 100 {
            if !controller.isSaving { break }
            await Task.yield()
        }
        XCTAssertFalse(controller.isSaving)
        XCTAssertFalse(controller.retryDeferredExternal(oldOverview, hasLocalDraft: false))
        XCTAssertEqual(controller.acknowledgedValues, chosen)
        XCTAssertEqual(controller.notice, "Saved")
    }

    func testConflictDropsQueuedDraftAndBlocksStaleRetry() async {
        let started = expectation(description: "first PATCH started")
        var release: CheckedContinuation<Void, Never>?
        var sent: [ModelBehaviorValues] = []
        let controller = ModelBehaviorAutosaveController(initialValues: ModelBehaviorValues()) { values, _ in
            sent.append(values)
            started.fulfill()
            await withCheckedContinuation { release = $0 }
            throw GatewayClient.Error.serverError(status: 409, body: "conflict")
        }
        let low = ModelBehaviorValues(reasoningEffort: "low")
        let high = ModelBehaviorValues(reasoningEffort: "high")
        controller.submit(.success(low))
        await fulfillment(of: [started], timeout: 2)
        controller.submit(.success(high))
        release?.resume()
        for _ in 0 ..< 100 {
            if controller.hasConflict { break }
            await Task.yield()
        }
        XCTAssertTrue(controller.hasConflict)
        XCTAssertEqual(sent, [low], "the queued request still expected an obsolete baseline")
        controller.submit(.success(high))
        controller.reset()
        XCTAssertEqual(sent, [low])
        XCTAssertFalse(controller.reconcileExternal(high, hasLocalDraft: false))
    }
}
