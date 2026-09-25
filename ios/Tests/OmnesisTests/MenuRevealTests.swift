// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CoreGraphics
@testable import Omnesis
import XCTest

/// The reveal's decisions, exercised without a simulator. `MenuReveal` is
/// deliberately free of SwiftUI so this lane can reach it; the rendering it
/// drives is covered by the snapshot suite instead.
final class MenuRevealTests: XCTestCase {
    private let width: CGFloat = 393
    private var travel: CGFloat {
        MenuReveal.menuWidth(forContainerWidth: width)
    }

    // MARK: - Geometry

    func testMenuWidthIsTheTravel() {
        XCTAssertEqual(MenuReveal.menuWidth(forContainerWidth: 393), 393 * 0.78, accuracy: 0.001)
        XCTAssertEqual(MenuReveal.menuWidth(forContainerWidth: 0), 0)
    }

    /// On a tablet the fraction alone would give a menu wide enough to strand
    /// a row's label at one end and the Settings button at the other.
    func testMenuWidthIsCappedOnAWideScreen() {
        XCTAssertEqual(MenuReveal.menuWidth(forContainerWidth: 1366), MenuReveal.maximumMenuWidth)
        // The phone stays under the cap, so it is unaffected by it.
        XCTAssertLessThan(MenuReveal.menuWidth(forContainerWidth: 430), MenuReveal.maximumMenuWidth)
    }

    /// Before first layout there is no width, and the reveal has to resolve to
    /// closed rather than to a division by zero.
    func testProgressIsZeroWithoutWidth() {
        XCTAssertEqual(MenuReveal.progress(restingDistance: 0, dragDistance: 40, travel: 0), 0)
    }

    func testProgressClampsBothEnds() {
        XCTAssertEqual(MenuReveal.progress(restingDistance: 0, dragDistance: -50, travel: travel), 0)
        XCTAssertEqual(
            MenuReveal.progress(restingDistance: travel, dragDistance: 999, travel: travel),
            1
        )
        XCTAssertEqual(
            MenuReveal.progress(restingDistance: 0, dragDistance: travel / 2, travel: travel),
            0.5,
            accuracy: 0.001
        )
    }

    /// A drag reversed past where it began pins at rest instead of pushing the
    /// app off its own resting position in the wrong direction.
    func testDragDistanceClampsToTheTravelAvailable() {
        // Closed: may travel forward the full width, never backwards.
        XCTAssertEqual(MenuReveal.clampDragDistance(-200, restingDistance: 0, travel: travel), 0)
        XCTAssertEqual(
            MenuReveal.clampDragDistance(9999, restingDistance: 0, travel: travel),
            travel
        )
        // Open: may travel back the full width, never further forward.
        XCTAssertEqual(
            MenuReveal.clampDragDistance(200, restingDistance: travel, travel: travel),
            0
        )
        XCTAssertEqual(
            MenuReveal.clampDragDistance(-9999, restingDistance: travel, travel: travel),
            -travel
        )
    }

    // MARK: - Claiming a touch

    private func mode(
        vx: CGFloat = 0,
        vy: CGFloat = 0,
        startX: CGFloat = 100,
        startY: CGFloat = 400,
        dx: CGFloat = 0,
        dy: CGFloat = 0,
        isOpen: Bool = false,
        exclusions: [CGRect] = []
    )
        -> MenuReveal.DragMode {
        MenuReveal.mode(
            velocity: CGPoint(x: vx, y: vy),
            startLocation: CGPoint(x: startX, y: startY),
            translation: CGPoint(x: dx, y: dy),
            width: width,
            isOpen: isOpen,
            exclusions: exclusions
        )
    }

    func testRightwardFlickWhileClosedRevealsTheMenu() {
        XCTAssertEqual(mode(vx: 400, vy: 40), .horizontal)
    }

    func testLeftwardFlickWhileOpenHidesTheMenu() {
        XCTAssertEqual(mode(vx: -400, vy: 40, isOpen: true), .horizontal)
    }

    /// A drag only ever moves the menu towards its *other* state, so the
    /// direction that would over-travel is ignored rather than clamped.
    func testDragAwayFromTheOtherStateIsNotClaimed() {
        XCTAssertEqual(mode(vx: -400, vy: 40), .undetermined)
        XCTAssertEqual(mode(vx: 400, vy: 40, isOpen: true), .undetermined)
    }

    func testTooSlowAndTooShortIsNotClaimed() {
        XCTAssertEqual(mode(vx: 140, dx: 8), .undetermined)
    }

    /// A deliberate slow drag never reaches the velocity threshold, so
    /// distance has to be able to claim the touch on its own — without it,
    /// moving the app aside slowly simply would not work.
    func testSlowButLongDragIsClaimedOnDistance() {
        XCTAssertEqual(mode(vx: 20, vy: 5, dx: 40, dy: 6), .horizontal)
    }

    func testDiagonalDragFailsAxisDominance() {
        XCTAssertEqual(mode(vx: 200, vy: 180), .undetermined)
    }

    func testDominantVerticalYieldsToTheScrollViewBeneath() {
        XCTAssertEqual(mode(vx: 10, vy: 300), .vertical)
        XCTAssertEqual(mode(dx: 4, dy: 40), .vertical)
    }

    /// With nothing to go back to — every section root — the edge is where a
    /// hand reaches for this gesture first, so it is claimed like anywhere
    /// else.
    func testDragFromTheVeryEdgeRevealsTheMenuAtASectionRoot() {
        XCTAssertEqual(mode(vx: 400, startX: 0), .horizontal)
        XCTAssertEqual(mode(vx: 400, startX: 2), .horizontal)
    }

    /// The trailing band is held clear so it belongs unambiguously to the
    /// Timeline's own edge gesture.
    func testDragFromTheTrailingBandIsLeftAlone() {
        XCTAssertEqual(mode(vx: 400, startX: width * 0.85), .undetermined)
        XCTAssertEqual(mode(vx: 400, startX: width * 0.75), .horizontal)
    }

    /// The whole contract of `menuRevealExcluded()`: a drag starting inside a
    /// region that scrolls horizontally itself belongs to that region.
    func testDragStartingInsideAnExcludedRegionIsLeftAlone() {
        let table = CGRect(x: 20, y: 300, width: 300, height: 200)
        XCTAssertEqual(mode(vx: 400, startX: 100, startY: 400, exclusions: [table]), .undetermined)
        // Just outside it, the same flick is claimed as normal.
        XCTAssertEqual(mode(vx: 400, startX: 100, startY: 550, exclusions: [table]), .horizontal)
    }

    /// Closing is not gated on where the touch began — once the menu is
    /// showing, a leftward drag anywhere brings the app back.
    func testClosingIgnoresStartLocationGates() {
        let table = CGRect(x: 0, y: 0, width: width, height: 900)
        XCTAssertEqual(mode(vx: -400, startX: 2, isOpen: true, exclusions: [table]), .horizontal)
    }

    /// An excluded region that is not currently taking touches reports no
    /// frame at all, so it cannot go on blocking the area it would occupy.
    /// This is what a panel parked off-screen relies on: `.offset` is a
    /// draw-time transform and leaves the layout frame where it was.
    func testInactiveExclusionsDoNotBlock() {
        XCTAssertEqual(mode(vx: 400, startX: 200, exclusions: []), .horizontal)
    }

    // MARK: - Where a released drag settles

    func testFlickDecidesOnDirectionAlone() {
        // Barely moved, but thrown hard enough to commit.
        XCTAssertTrue(MenuReveal.shouldOpen(velocity: 600, dragDistance: 1, travel: travel, isOpen: false))
        XCTAssertFalse(MenuReveal.shouldOpen(
            velocity: -600,
            dragDistance: -1,
            travel: travel,
            isOpen: true
        ))
    }

    func testSlowReleaseCommitsOnlyPastAThirdOfTheTravel() {
        let third = travel * MenuReveal.commitFraction
        // Opening.
        XCTAssertFalse(MenuReveal.shouldOpen(velocity: 0, dragDistance: third, travel: travel, isOpen: false))
        XCTAssertTrue(MenuReveal.shouldOpen(
            velocity: 0,
            dragDistance: third + 1,
            travel: travel,
            isOpen: false
        ))
        // Closing reads the same way: a third of the travel back commits.
        XCTAssertTrue(MenuReveal.shouldOpen(
            velocity: 0,
            dragDistance: -third + 1,
            travel: travel,
            isOpen: true
        ))
        XCTAssertFalse(MenuReveal.shouldOpen(
            velocity: 0,
            dragDistance: -third,
            travel: travel,
            isOpen: true
        ))
    }

    /// Nudged and released goes back where it started, in both directions.
    func testSmallNudgeSnapsBack() {
        XCTAssertFalse(MenuReveal.shouldOpen(velocity: 30, dragDistance: 12, travel: travel, isOpen: false))
        XCTAssertTrue(MenuReveal.shouldOpen(
            velocity: -30,
            dragDistance: -12,
            travel: travel,
            isOpen: true
        ))
    }

    func testOnlyACommittedSwipeGetsPhysicalFeedback() {
        let opening = MenuReveal.releaseOutcome(
            velocity: 0, dragDistance: 140, travel: 300, isOpen: false
        )
        XCTAssertEqual(opening, .init(shouldOpen: true, emitsFeedback: true))

        let closing = MenuReveal.releaseOutcome(
            velocity: 0, dragDistance: -140, travel: 300, isOpen: true
        )
        XCTAssertEqual(closing, .init(shouldOpen: false, emitsFeedback: true))

        let closedSnapBack = MenuReveal.releaseOutcome(
            velocity: 0, dragDistance: 40, travel: 300, isOpen: false
        )
        XCTAssertEqual(closedSnapBack, .init(shouldOpen: false, emitsFeedback: false))

        let openSnapBack = MenuReveal.releaseOutcome(
            velocity: 0, dragDistance: -40, travel: 300, isOpen: true
        )
        XCTAssertEqual(openSnapBack, .init(shouldOpen: true, emitsFeedback: false))
    }

    // MARK: - Launch speed for the settle

    func testInitialVelocityIsAFractionOfTheDistanceLeft() {
        XCTAssertEqual(MenuReveal.initialVelocity(velocity: 600, remaining: 300), 2.0, accuracy: 0.001)
    }

    /// Released with effectively nothing left to travel, the spring starts
    /// from rest rather than dividing by approximately nothing.
    func testInitialVelocityIsZeroWhenAlreadyThere() {
        XCTAssertEqual(MenuReveal.initialVelocity(velocity: 900, remaining: 0), 0)
        XCTAssertEqual(MenuReveal.initialVelocity(velocity: 900, remaining: 0.5), 0)
    }

    /// Dragged nearly open then thrown back: the finger is going one way and
    /// the distance left the other, and the spring must still launch forwards.
    func testInitialVelocityStaysPositiveWhenReversing() {
        XCTAssertGreaterThan(MenuReveal.initialVelocity(velocity: -800, remaining: -280), 0)
    }

    // MARK: - Lift shadow by appearance

    /// Light mode renders the shadow darker but thinner — a soft edge
    /// rather than a blur. Dark mode keeps the full value in both
    /// dimensions, strictly unchanged.
    func testShadowIsDarkerButThinnerInLightMode() {
        XCTAssertEqual(MenuReveal.shadowOpacity(isLight: false), MenuReveal.shadowOpacity)
        XCTAssertEqual(MenuReveal.shadowOpacity(isLight: true), MenuReveal.shadowOpacityLight)
        XCTAssertEqual(MenuReveal.shadowOpacity(isLight: false), 0.4, accuracy: 0.001)
        XCTAssertEqual(MenuReveal.shadowOpacity(isLight: true), 0.3, accuracy: 0.001)
        XCTAssertEqual(MenuReveal.shadowRadius(isLight: false), MenuReveal.shadowRadius)
        XCTAssertEqual(MenuReveal.shadowRadius(isLight: true), MenuReveal.shadowRadiusLight)
        XCTAssertEqual(MenuReveal.shadowRadius(isLight: false), 24, accuracy: 0.001)
        XCTAssertEqual(MenuReveal.shadowRadius(isLight: true), 6, accuracy: 0.001)
    }
}
