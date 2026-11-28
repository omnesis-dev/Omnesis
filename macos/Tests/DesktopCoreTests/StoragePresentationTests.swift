// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class StoragePresentationTests: XCTestCase {
    func testMemoryBudgetValidationMatchesMinimumAndRejectsFractions() {
        for value in ["0", "255", "256.5", "inf", "1048577"] {
            XCTAssertNil(DesktopMemorySettings.mebibytes(value))
        }
        XCTAssertEqual(DesktopMemorySettings.mebibytes("256"), 256)
        XCTAssertEqual(DesktopMemorySettings.mebibytes("4096"), 4096)
    }

    func testQuotaRejectsInvalidOverflowAndNonpositiveLimits() {
        for value in ["", "NaN", "inf", "-1", "0", "0.000000000000000001", "1000000000000000"] {
            XCTAssertNil(DesktopStorageSnapshot.quotaBytes(gibibytes: value))
        }
        XCTAssertEqual(DesktopStorageSnapshot.quotaBytes(gibibytes: "1.5"), 1_610_612_736)
    }

    func testRetentionRequiresBoundedWholeDays() {
        for value in ["", "0", "-1", "1.5", "36501"] {
            XCTAssertNil(DesktopStorageSnapshot.retentionDays(value))
        }
        XCTAssertEqual(DesktopStorageSnapshot.retentionDays("30"), 30)
    }

    func testCleanupCutoffMatchesCanonicalUTCWithMilliseconds() {
        XCTAssertEqual(DesktopStorageSnapshot.cutoff(Date(timeIntervalSince1970: 0)), "1970-01-01T00:00:00.000Z")
    }

    func testCancelledAndPendingDeletionNeverClaimCompletion() throws {
        let decoder = JSONDecoder()
        let cancelled = try decoder.decode(
            DesktopStorageSnapshot.CleanupJob.self,
            from: Data(
                #"{"id":"fixture","target":"backups","state":"cancelled","removed":2,"protected":1,"hasPendingRemoval":false,"error":null}"#
                    .utf8
            )
        )
        XCTAssertFalse(cancelled.active)
        XCTAssertTrue(cancelled.outcome.contains("cannot be restored"))
        let pending = try decoder.decode(
            DesktopStorageSnapshot.CleanupJob.self,
            from: Data(
                #"{"id":"fixture","target":"backups","state":"failed","removed":2,"protected":1,"hasPendingRemoval":true,"error":"Fixture refusal"}"#
                    .utf8
            )
        )
        XCTAssertTrue(pending.outcome.contains("work remains"))
        XCTAssertFalse(pending.outcome.contains("complete"))
    }

    func testUnknownMeasurementNeverBecomesZero() throws {
        let snapshot = try JSONDecoder().decode(
            DesktopStorageSnapshot.self,
            from: Data(
                #"{"pressure":{"state":"unknown","usageBytes":null,"measuredAt":null},"policy":{"maxBytes":null},"cleanupJobs":[],"retention":[]}"#
                    .utf8
            )
        )
        XCTAssertNil(snapshot.pressure.usageBytes)
        XCTAssertTrue(snapshot.pressure.message.contains("not been measured"))
    }
}
