// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import Security
import XCTest

final class PinnedTrustPlatformFailureTests: XCTestCase {
    func testSecuritySetupErrorsRejectAnOtherwiseValidCertificate() throws {
        let trust = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        let root = try TrustFixtures.certificate(TrustFixtures.root)
        func evaluate(_ operations: PinnedTrustPlatformOperations) -> Bool {
            PinnedSession.evaluateSystemTrust(
                trust,
                host: TrustFixtures.host,
                anchors: [root],
                verifyDate: TrustFixtures.verifyDate,
                operations: operations
            )
        }
        XCTAssertTrue(evaluate(.live))
        var operations = PinnedTrustPlatformOperations.live
        operations.certificateChain = { _ in nil }
        XCTAssertFalse(evaluate(operations))
        operations.certificateChain = { _ in [] }
        XCTAssertFalse(evaluate(operations))
        operations = .live
        operations.createTrust = { _, _ in (errSecAllocate, nil) }
        XCTAssertFalse(evaluate(operations))
        operations.createTrust = { _, _ in (errSecSuccess, nil) }
        XCTAssertFalse(evaluate(operations))
        operations = .live
        operations.setAnchors = { _, _ in errSecParam }
        XCTAssertFalse(evaluate(operations))
        operations = .live
        operations.setAnchorOnly = { _, _ in errSecParam }
        XCTAssertFalse(evaluate(operations))
        operations = .live
        operations.setNetworkFetch = { _, _ in errSecParam }
        XCTAssertFalse(evaluate(operations))
        operations = .live
        operations.setVerifyDate = { _, _ in errSecParam }
        XCTAssertFalse(evaluate(operations))
        XCTAssertTrue(evaluate(.live))
    }

    func testMissingPlatformCertificateChainCannotMatchEitherPin() throws {
        let trust = try TrustFixtures.servedTrust(TrustFixtures.leafOne)
        let certificate = try TrustFixtures.certificate(TrustFixtures.leafOne)
        let der = SecCertificateCopyData(certificate) as Data
        let leafPin = der.sha256Hex
        let keyPin = try GatewayKeyFingerprint.spki(der)
        XCTAssertTrue(PinnedSession.verifyFingerprint(trust: trust, against: leafPin))
        XCTAssertTrue(PinnedSession.verifySPKI(trust: trust, against: keyPin))
        let missingChains: [[SecCertificate]?] = [nil, []]
        for missing in missingChains {
            var operations = PinnedTrustPlatformOperations.live
            operations.certificateChain = { _ in missing }
            XCTAssertFalse(PinnedSession.verifyFingerprint(trust: trust, against: leafPin, operations: operations))
            XCTAssertFalse(PinnedSession.verifySPKI(trust: trust, against: keyPin, operations: operations))
        }
    }
}
