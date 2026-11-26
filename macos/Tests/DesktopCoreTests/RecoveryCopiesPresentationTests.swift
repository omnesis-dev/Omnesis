// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import XCTest

final class RecoveryCopiesPresentationTests: XCTestCase {
    func testUnknownAndInterruptedCopiesStayDistinctFromRegisteredProtectedCopies() throws {
        let value = try JSONDecoder().decode(DesktopRecoveryCopiesCatalog.self, from: Data(Self.catalog.utf8))
        XCTAssertTrue(value.valid)
        XCTAssertEqual(value.items.first?.protectionLabel, "Kept by your choice")
        XCTAssertNotNil(value.items.first?.retainedDate)
        XCTAssertEqual(value.partialCopies.first?.ownership, .unknown)
        XCTAssertEqual(value.unregisteredCopies, 2)
    }

    func testOldCatalogStillReadsButCannotAuthorizeAnUnidentifiedPendingRemoval() throws {
        let text = Self.catalog.replacingOccurrences(
            of: "\"pending\":null",
            with:
            #""pending":{"id":"33333333-3333-4333-8333-333333333333","phase":"planned","canCancel":true}"#
        )
        let catalog = try JSONDecoder().decode(DesktopRecoveryCopiesCatalog.self, from: Data(text.utf8))
        XCTAssertTrue(catalog.valid)
        XCTAssertFalse(catalog.pending?.hasCleanupBinding ?? true)
    }

    func testCleanupPreviewRequiresTheActualDifferentKeeperAndMeasuredSelectedCopy() throws {
        let text = #"{"kind":"desktopRecoveryCleanup","phase":"preview","id":"11111111-1111-4111-8111-111111111111","confirmationId":"TOKEN","bytes":1024,"mode":"redundant-snapshot","message":"Personal backups are kept.","selected":{"id":"11111111-1111-4111-8111-111111111111","purpose":"update","oldVersion":"1.2.3","registeredAt":"2030-01-01T12:00:00.000Z","bytes":1024,"order":1},"keeper":{"id":"22222222-2222-4222-8222-222222222222","purpose":"restore","oldVersion":"1.2.3","registeredAt":"2030-01-02T12:00:00.000Z","bytes":2048,"order":2}}"#
            .replacingOccurrences(of: "TOKEN", with: String(repeating: "a", count: 64))
        let good = try JSONDecoder().decode(DesktopRecoveryCleanupPreview.self, from: Data(text.utf8))
        XCTAssertTrue(good.valid)
        for refused in [
            text.replacingOccurrences(of: "22222222-2222-4222-8222-222222222222", with: good.id),
            text.replacingOccurrences(of: "\"bytes\":1024,\"mode\"", with: "\"bytes\":null,\"mode\""),
            text.replacingOccurrences(of: "2030-01-01T12:00:00.000Z", with: "unknown"),
        ] {
            XCTAssertFalse(try JSONDecoder().decode(DesktopRecoveryCleanupPreview.self, from: Data(refused.utf8)).valid)
        }
    }

    func testInvalidIdentityCountsAndUnknownProtectionAreNotPresentedAsValidCopies() throws {
        for json in [
            Self.catalog.replacingOccurrences(of: "11111111-1111-4111-8111-111111111111", with: "not-an-id"),
            Self.catalog.replacingOccurrences(of: "\"bytes\":1024", with: "\"bytes\":-1"),
            Self.catalog.replacingOccurrences(of: "\"unregisteredCopies\":2", with: "\"unregisteredCopies\":-1"),
        ] {
            XCTAssertFalse(try JSONDecoder().decode(DesktopRecoveryCopiesCatalog.self, from: Data(json.utf8)).valid)
        }
        XCTAssertThrowsError(try JSONDecoder().decode(DesktopRecoveryCopiesCatalog.self, from: Data(
            Self.catalog.replacingOccurrences(of: "\"disposition\":\"pinned\"", with: "\"disposition\":\"future-policy\"").utf8
        )))
    }

    private static let catalog = #"{"kind":"desktopRecoveryCopies","limit":16,"items":[{"id":"11111111-1111-4111-8111-111111111111","purpose":"update","oldVersion":"1.2.3","registeredAt":"2026-01-01T12:00:00.000Z","bytes":1024,"pinned":true,"order":1,"disposition":"pinned","canReview":false}],"partialCopies":[{"id":"22222222-2222-4222-8222-222222222222","purpose":"restore","staging":true,"ownership":"unknown","canReview":false}],"pending":null,"unregisteredCopies":2}"#
}
