// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The capture-request funnel's counter + freshness semantics: a
/// request consumed long after it was filed (control tap before pairing,
/// consumed when HomeView first appears) must read as stale so the
/// capture surface doesn't pop out of nowhere.
@MainActor
final class CaptureRouterTests: XCTestCase {
    func testRequestBumpsCountAndRecordsSurface() {
        let router = CaptureRouter()
        XCTAssertEqual(router.requestCount, 0)

        router.requestCapture(surfaceSlug: "ios-control")

        XCTAssertEqual(router.requestCount, 1)
        XCTAssertEqual(router.lastSurfaceSlug, "ios-control")

        router.requestCapture(surfaceSlug: "ios-control")

        XCTAssertEqual(router.requestCount, 2)
        XCTAssertEqual(router.lastSurfaceSlug, "ios-control")
    }

    func testNoRequestYetIsNotFresh() {
        XCTAssertFalse(CaptureRouter().isFresh())
    }

    func testRecentRequestIsFresh() {
        let router = CaptureRouter()
        let t0 = Date(timeIntervalSince1970: 1_772_000_000)
        router.requestCapture(at: t0)

        XCTAssertTrue(router.isFresh(asOf: t0))
        XCTAssertTrue(router.isFresh(asOf: t0.addingTimeInterval(CaptureRouter.freshnessWindow - 1)))
    }

    func testStaleRequestIsNotFresh() {
        let router = CaptureRouter()
        let t0 = Date(timeIntervalSince1970: 1_772_000_000)
        router.requestCapture(at: t0)

        XCTAssertFalse(router.isFresh(asOf: t0.addingTimeInterval(CaptureRouter.freshnessWindow)))
        XCTAssertFalse(router.isFresh(asOf: t0.addingTimeInterval(300)))
    }

    func testNewRequestRefreshesStaleness() {
        let router = CaptureRouter()
        let t0 = Date(timeIntervalSince1970: 1_772_000_000)
        router.requestCapture(at: t0)
        let later = t0.addingTimeInterval(600)
        XCTAssertFalse(router.isFresh(asOf: later))

        router.requestCapture(at: later)

        XCTAssertTrue(router.isFresh(asOf: later))
    }
}

@MainActor
final class CaptureRequestHandlingTests: XCTestCase {
    func testFreshShortcutHidesDrawerAndKeyboardWithoutReplacingExistingCapture() {
        let router = CaptureRouter()
        router.requestCapture()
        var menuOpen = true
        var keyboardFocused = true
        var presentations = 0
        CaptureRequestHandling.handle(
            isFresh: router.isFresh(),
            isPresented: true,
            reveal: { menuOpen = false; keyboardFocused = false },
            enqueue: { presentations += 1 }
        )
        XCTAssertFalse(menuOpen)
        XCTAssertFalse(keyboardFocused)
        XCTAssertEqual(presentations, 0, "An existing draft and microphone must keep their capture instance")
    }

    func testNewCaptureIsRevealedBeforePresentationIsQueued() {
        var drawerOpen = true
        var queued = false
        CaptureRequestHandling.handle(
            isFresh: true,
            isPresented: false,
            reveal: { drawerOpen = false },
            enqueue: { XCTAssertFalse(drawerOpen); queued = true }
        )
        XCTAssertTrue(queued)
    }

    func testStaleShortcutLeavesExistingDrawerAndCaptureUntouched() {
        let router = CaptureRouter()
        let requested = Date(timeIntervalSince1970: 1_775_000_000)
        router.requestCapture(at: requested)
        var menuOpen = true
        var queued = false
        CaptureRequestHandling.handle(
            isFresh: router.isFresh(asOf: requested.addingTimeInterval(CaptureRouter.freshnessWindow)),
            isPresented: true,
            reveal: { menuOpen = false },
            enqueue: { queued = true }
        )
        XCTAssertTrue(menuOpen)
        XCTAssertFalse(queued)
    }

    func testOnlyCaptureURLsCanRevealTheCapture() throws {
        let accepted = ["omnesis://capture", "omnesis://capture?surface=ios-control", "omnesis:/capture"]
        let rejected = ["https://capture", "omnesis://tasks", "omnesis://capture/other", "omnesis://user@capture", "omnesis://capture#other"]
        for raw in accepted {
            XCTAssertTrue(CaptureRequestHandling.accepts(try XCTUnwrap(URL(string: raw))), raw)
        }
        for raw in rejected {
            XCTAssertFalse(CaptureRequestHandling.accepts(try XCTUnwrap(URL(string: raw))), raw)
        }
    }
}
