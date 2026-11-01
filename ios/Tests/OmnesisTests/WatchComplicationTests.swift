// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class WatchComplicationTests: XCTestCase {
    @MainActor
    func testControlLaunchWaitsForItsSceneAndIsConsumedOnce() {
        let router = WatchControlRouter()
        XCTAssertFalse(router.consume())
        router.requestCapture()
        XCTAssertTrue(router.consume(), "A launch that precedes scene construction must not be lost")
        XCTAssertFalse(router.consume(), "Re-rendering the scene must not start another recording")
    }

    @MainActor
    func testRepeatedControlTapsCoalesceUntilTheSceneConsumesThem() {
        let router = WatchControlRouter()
        router.requestCapture()
        router.requestCapture()
        XCTAssertTrue(router.consume())
        XCTAssertFalse(router.consume())
        router.requestCapture()
        XCTAssertTrue(router.consume(), "A later invocation must still open capture")
    }

    @MainActor
    func testStaleControlLaunchIsDroppedAndANewPressCanOpenCapture() {
        let router = WatchControlRouter()
        let requested = Date(timeIntervalSince1970: 1_770_000_000)
        router.requestCapture(at: requested)
        XCTAssertFalse(router.consume(asOf: requested.addingTimeInterval(WatchControlRouter.freshnessWindow)))
        XCTAssertFalse(router.consume(asOf: requested), "A consumed stale request cannot become actionable again")
        let later = requested.addingTimeInterval(60)
        router.requestCapture(at: later)
        XCTAssertTrue(router.consume(asOf: later))
    }

    func testEachComplicationHasItsOwnLink() {
        XCTAssertEqual(WatchComplication.ask.url.absoluteString, "omnesis-watch://ask")
        XCTAssertEqual(WatchComplication.note.url.absoluteString, "omnesis-watch://note")
    }

    func testEveryLinkRoundTrips() {
        for complication in WatchComplication.allCases {
            XCTAssertEqual(WatchComplication(url: complication.url), complication)
        }
    }

    func testSchemeAndHostAreCaseInsensitive() throws {
        let url = try XCTUnwrap(URL(string: "OMNESIS-WATCH://Note"))
        XCTAssertEqual(WatchComplication(url: url), .note)
    }

    func testRejectsLinksThisAppNeverProduces() throws {
        let rejected = [
            // Wrong scheme: the iPhone app's own scheme, and a web link.
            "omnesis://ask",
            "https://ask",
            // Unknown flow.
            "omnesis-watch://capture",
            "omnesis-watch://",
            // Anything beyond the bare host.
            "omnesis-watch://ask/now",
            "omnesis-watch://ask/",
            "omnesis-watch://someone@ask",
            "omnesis-watch://ask:8080",
            "omnesis-watch://ask?text=hello",
            "omnesis-watch://note#top",
        ]
        for string in rejected {
            let url = try XCTUnwrap(URL(string: string), string)
            XCTAssertNil(WatchComplication(url: url), string)
        }
    }
}
