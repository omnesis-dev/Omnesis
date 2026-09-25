// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class DeferredPresentationQueueTests: XCTestCase {
    func testPresentersReleasedTogetherGoOneAtATimeInOrder() {
        var queue = DeferredPresentationQueue()
        queue.request(.composerFocus)
        queue.request(.privacyApproval)
        queue.request(.relayConsent)
        queue.request(.pushTarget)

        XCTAssertEqual(queue.next(gateOpen: true, screenIsFree: true), .pushTarget)
        XCTAssertNil(queue.next(gateOpen: true, screenIsFree: true), "one presenter at a time")

        queue.finish(.pushTarget)
        XCTAssertEqual(queue.next(gateOpen: true, screenIsFree: true), .relayConsent)
        queue.finish(.relayConsent)
        XCTAssertEqual(queue.next(gateOpen: true, screenIsFree: true), .privacyApproval)
        queue.finish(.privacyApproval)
        XCTAssertEqual(queue.next(gateOpen: true, screenIsFree: true), .composerFocus)
        queue.finish(.composerFocus)
        XCTAssertNil(queue.next(gateOpen: true, screenIsFree: true))
    }

    func testNothingPresentsWhileTheGateIsShutOrTheScreenIsTaken() {
        var queue = DeferredPresentationQueue()
        queue.request(.capture)

        XCTAssertNil(queue.next(gateOpen: false, screenIsFree: true))
        XCTAssertNil(queue.next(gateOpen: true, screenIsFree: false))
        XCTAssertEqual(queue.waiting, [.capture], "a blocked request keeps its place")
        XCTAssertEqual(queue.next(gateOpen: true, screenIsFree: true), .capture)
    }

    func testFinishingAnotherPresenterDoesNotReleaseTheCurrentOne() {
        var queue = DeferredPresentationQueue()
        queue.request(.accessAuthorization)
        queue.request(.privacyApproval)
        _ = queue.next(gateOpen: true, screenIsFree: true)

        queue.finish(.privacyApproval)

        XCTAssertEqual(queue.current, .accessAuthorization)
        XCTAssertNil(queue.next(gateOpen: true, screenIsFree: true))
    }

    func testWithdrawnRequestsNeverPresentAndRepeatedRequestsPresentOnce() {
        var queue = DeferredPresentationQueue()
        queue.request(.relayConsent)
        queue.request(.relayConsent)
        queue.request(.capture)
        queue.withdraw(.relayConsent)

        XCTAssertEqual(queue.next(gateOpen: true, screenIsFree: true), .capture)
        queue.finish(.capture)
        XCTAssertNil(queue.next(gateOpen: true, screenIsFree: true))
    }

    func testARequestMadeWhileItsPresenterIsOnScreenGoesAgainAfterIt() {
        var queue = DeferredPresentationQueue()
        queue.request(.pushTarget)
        _ = queue.next(gateOpen: true, screenIsFree: true)
        queue.request(.pushTarget)

        XCTAssertNil(queue.next(gateOpen: true, screenIsFree: true))
        queue.finish(.pushTarget)
        XCTAssertEqual(queue.next(gateOpen: true, screenIsFree: true), .pushTarget)
    }

    // MARK: - Home's decisions

    func testATurnEndsOnceItsPresentationHasGoneButRelayConsentKeepsItsTurn() {
        var queue = DeferredPresentationQueue()
        queue.request(.accessAuthorization)
        _ = queue.next(gateOpen: true, screenIsFree: true)

        queue.settle(on: DeferredPresentationScreen(accessAuthorization: true))
        XCTAssertEqual(queue.current, .accessAuthorization, "still on screen")
        queue.settle(on: DeferredPresentationScreen())
        XCTAssertNil(queue.current, "a stale turn ends")

        queue.request(.relayConsent)
        _ = queue.next(gateOpen: true, screenIsFree: true)
        queue.settle(on: DeferredPresentationScreen())
        XCTAssertEqual(queue.current, .relayConsent, "the root owns the relay sheet")
    }

    func testAPushTargetTurnLastsWhileEitherSheetItOpensIsUp() {
        var queue = DeferredPresentationQueue()
        queue.request(.pushTarget)
        _ = queue.next(gateOpen: true, screenIsFree: true)

        queue.settle(on: DeferredPresentationScreen(settings: true))
        XCTAssertEqual(queue.current, .pushTarget)
        queue.settle(on: DeferredPresentationScreen(capture: true))
        XCTAssertNil(queue.current)
    }

    func testAPrivacyLookupHoldsItsTurnUntilItFinishes() {
        var queue = DeferredPresentationQueue()
        queue.request(.privacyApproval)
        _ = queue.next(gateOpen: true, screenIsFree: true)

        queue.settle(on: DeferredPresentationScreen(privacyLookup: true))
        XCTAssertEqual(queue.current, .privacyApproval)
        queue.settle(on: DeferredPresentationScreen())
        XCTAssertNil(queue.current)
    }

    func testRelayConsentStepsAsideForSetupAndComesBack() {
        var queue = DeferredPresentationQueue()
        queue.request(.relayConsent)
        _ = queue.next(gateOpen: true, screenIsFree: true)

        queue.stepAsideForSetup()

        XCTAssertNil(queue.current)
        XCTAssertEqual(queue.waiting, [.relayConsent])
        XCTAssertNil(queue.next(gateOpen: false, screenIsFree: true))
        XCTAssertEqual(queue.next(gateOpen: true, screenIsFree: true), .relayConsent)
    }

    func testStepAsideLeavesOtherTurnsAlone() {
        var queue = DeferredPresentationQueue()
        queue.request(.capture)
        _ = queue.next(gateOpen: true, screenIsFree: true)

        queue.stepAsideForSetup()

        XCTAssertEqual(queue.current, .capture)
    }

    func testComposerFocusBehindASheetIsDroppedOutsideSetupOnly() {
        XCTAssertFalse(DeferredPresentationQueue.admits(.composerFocus, gateOpen: true, screenIsFree: false))
        XCTAssertTrue(DeferredPresentationQueue.admits(.composerFocus, gateOpen: true, screenIsFree: true))
        XCTAssertTrue(DeferredPresentationQueue.admits(.composerFocus, gateOpen: false, screenIsFree: false))
        XCTAssertTrue(DeferredPresentationQueue.admits(.capture, gateOpen: true, screenIsFree: false))
    }

    func testUserRequestsPreemptHomesSheetOnlyOutsideSetup() {
        for presenter in [DeferredPresenter.pushTarget, .accessAuthorization, .capture] {
            XCTAssertTrue(DeferredPresentationQueue.preempts(presenter, gateOpen: true))
            XCTAssertFalse(DeferredPresentationQueue.preempts(presenter, gateOpen: false))
        }
        for presenter in [DeferredPresenter.relayConsent, .privacyApproval, .composerFocus] {
            XCTAssertFalse(DeferredPresentationQueue.preempts(presenter, gateOpen: true))
        }
    }

    func testCaptureCountsAsTakingTheScreen() {
        XCTAssertTrue(DeferredPresentationScreen().isFree)
        XCTAssertFalse(DeferredPresentationScreen(capture: true).isFree)
        XCTAssertTrue(DeferredPresentationScreen(relayConsent: true).isFree, "the root's sheet is not home's")
    }

    // MARK: - Sheets that never appear

    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    func testASheetThatNeverAppearsGivesBackItsTurnAndIsAskedForOnce() {
        var queue = DeferredPresentationQueue()
        let stuck = DeferredPresentationScreen(accessAuthorization: true)
        queue.request(.accessAuthorization)
        _ = queue.next(gateOpen: true, screenIsFree: true)
        queue.markPresenting(.accessAuthorization, now: start)

        XCTAssertNil(queue.expireUnappeared(on: stuck, now: start.addingTimeInterval(0.5)), "still within its time")
        XCTAssertEqual(queue.expireUnappeared(on: stuck, now: start.addingTimeInterval(1.5)), .accessAuthorization)
        XCTAssertNil(queue.current)
        XCTAssertEqual(queue.waiting, [.accessAuthorization], "asked for once more")

        _ = queue.next(gateOpen: true, screenIsFree: true)
        queue.markPresenting(.accessAuthorization, now: start.addingTimeInterval(2))
        XCTAssertEqual(queue.expireUnappeared(on: stuck, now: start.addingTimeInterval(3.5)), .accessAuthorization)
        XCTAssertNil(queue.current)
        XCTAssertTrue(queue.waiting.isEmpty, "a second failure is not retried")
    }

    func testASheetThatAppearedKeepsItsTurn() {
        var queue = DeferredPresentationQueue()
        queue.request(.pushTarget)
        _ = queue.next(gateOpen: true, screenIsFree: true)
        queue.markPresenting(.pushTarget, now: start)
        queue.didAppear(.pushTarget)

        XCTAssertNil(queue.expireUnappeared(on: DeferredPresentationScreen(settings: true), now: start.addingTimeInterval(60)))
        XCTAssertEqual(queue.current, .pushTarget)
    }

    func testOnlyASheetThatWasAskedForCanExpire() {
        var queue = DeferredPresentationQueue()
        queue.request(.privacyApproval)
        _ = queue.next(gateOpen: true, screenIsFree: true)

        let lookingUp = DeferredPresentationScreen(privacyLookup: true)
        XCTAssertNil(queue.expireUnappeared(on: lookingUp, now: start.addingTimeInterval(60)), "a lookup is not a sheet")
        XCTAssertEqual(queue.current, .privacyApproval)
    }

    func testAPresentationThatAppearedEarnsAFreshRetryNextTime() {
        var queue = DeferredPresentationQueue()
        let stuck = DeferredPresentationScreen(accessAuthorization: true)
        queue.request(.accessAuthorization)
        _ = queue.next(gateOpen: true, screenIsFree: true)
        queue.markPresenting(.accessAuthorization, now: start)
        _ = queue.expireUnappeared(on: stuck, now: start.addingTimeInterval(1.5))

        _ = queue.next(gateOpen: true, screenIsFree: true)
        queue.didAppear(.accessAuthorization)
        queue.finish(.accessAuthorization)

        queue.request(.accessAuthorization)
        _ = queue.next(gateOpen: true, screenIsFree: true)
        queue.markPresenting(.accessAuthorization, now: start.addingTimeInterval(10))
        _ = queue.expireUnappeared(on: stuck, now: start.addingTimeInterval(11.5))
        XCTAssertEqual(queue.waiting, [.accessAuthorization])
    }

    func testAClosingSheetPresentsTheNextFromItsDismissal() {
        let settings = DeferredPresentationScreen(settings: true)
        let captureUp = DeferredPresentationScreen(capture: true)
        let free = DeferredPresentationScreen()

        XCTAssertFalse(DeferredPresentationQueue.presentsWhenScreenChanges(from: settings, to: free))
        XCTAssertTrue(DeferredPresentationQueue.presentsWhenScreenChanges(from: captureUp, to: free))
        XCTAssertTrue(DeferredPresentationQueue.presentsWhenScreenChanges(from: DeferredPresentationScreen(privacyLookup: true), to: free))
        XCTAssertFalse(DeferredPresentationQueue.presentsWhenScreenChanges(from: free, to: captureUp))
    }
}
