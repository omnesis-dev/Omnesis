// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class PhoneSetupSuccessDrawTests: XCTestCase {
    func testAPageThatOpensOnASuccessDrawsItsRing() {
        XCTAssertTrue(PhoneSetupSuccessDraw.drawsIn(from: nil, to: .on))
        XCTAssertFalse(PhoneSetupSuccessDraw.drawsIn(from: nil, to: .notAllowed))
    }

    func testAnOutcomeThatBecomesASuccessInPlaceDrawsItsRing() {
        XCTAssertTrue(PhoneSetupSuccessDraw.drawsIn(from: .notAllowed, to: .on), "back from Settings with access")
        XCTAssertTrue(PhoneSetupSuccessDraw.drawsIn(from: .failed(message: nil), to: .limited))
        XCTAssertTrue(PhoneSetupSuccessDraw.drawsIn(from: .choiceRequired(.exclusive), to: .partial))
    }

    func testASuccessThatStaysASuccessOrEndsDrawsNothingNew() {
        XCTAssertFalse(PhoneSetupSuccessDraw.drawsIn(from: .partial, to: .on))
        XCTAssertFalse(PhoneSetupSuccessDraw.drawsIn(from: .on, to: .notAllowed))
    }
}
