// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// The navigation menu's Briefs entry is derived, not branched on in the view,
/// so the two blocked states stay told apart: an install that asked for the
/// feature and cannot run its model keeps a marked entry, while an install that
/// only previews the feature shows none.
final class BriefsMenuEntryTests: XCTestCase {
    func testGatewayWithoutTheFieldOffersNothing() {
        XCTAssertEqual(BriefsMenuEntry(status: nil), .hidden)
    }

    func testSwitchedOffFeatureOffersNothing() {
        XCTAssertEqual(
            BriefsMenuEntry(status: BriefsStatus(enabled: false, modelAssigned: false, active: false)),
            .hidden
        )
    }

    /// The common state on a configured install that never opted in: the model
    /// is fine, the feature is simply off. Not a fault, so not an entry.
    func testSwitchedOffFeatureWithARunnableModelOffersNothing() {
        XCTAssertEqual(
            BriefsMenuEntry(status: BriefsStatus(enabled: false, modelAssigned: true, active: false)),
            .hidden
        )
    }

    func testRunningFeatureIsANormalDestination() {
        XCTAssertEqual(
            BriefsMenuEntry(status: BriefsStatus(enabled: true, modelAssigned: true, active: true)),
            .available
        )
    }

    /// A background-agent backend that cannot run — no assignment, a missing
    /// key, an unreachable endpoint — on an install that switched the feature
    /// on. The feed remains the destination; its in-view warning points at repair.
    func testSwitchedOnFeatureWithAnUnrunnableModelNeedsAttention() {
        XCTAssertEqual(
            BriefsMenuEntry(status: BriefsStatus(enabled: true, modelAssigned: false, active: false)),
            .needsAttention
        )
    }

    func testBothVisibleMenuStatesNavigateToTheFeed() {
        XCTAssertEqual(
            BriefsMenuEntry(status: BriefsStatus(enabled: true, modelAssigned: true, active: true)).destination,
            .feed
        )
        XCTAssertEqual(
            BriefsMenuEntry(status: BriefsStatus(enabled: true, modelAssigned: false, active: false)).destination,
            .feed
        )
        XCTAssertNil(BriefsMenuEntry(status: nil).destination)
    }

    /// A demo gateway runs synthetic-visible without the feature switched on,
    /// and seeds no background-agent model. Flagging that would put a permanent
    /// warning on every demo and screenshot build, for a repair the operator
    /// did not ask for.
    func testPreviewOnlyInstallIsNotFlagged() {
        XCTAssertEqual(
            BriefsMenuEntry(status: BriefsStatus(enabled: false, modelAssigned: false, active: false)),
            .hidden
        )
    }

    /// Feed access follows `enabled`; an inconsistent active flag cannot hide
    /// the model warning the status explicitly requests.
    func testActiveFlagDoesNotSuppressAModelWarning() {
        XCTAssertEqual(
            BriefsMenuEntry(status: BriefsStatus(enabled: true, modelAssigned: false, active: true)),
            .needsAttention
        )
    }
}
