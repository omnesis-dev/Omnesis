// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Pins the per-store data-protection policy. The store → class mapping
/// is the contract this suite guards: a store silently falling back to
/// the OS default class is exactly the regression these assertions
/// exist to catch.
final class FileProtectionTests: XCTestCase {
    func testOfflineBufferAllowsLockedTimeCreation() {
        // Batches are enqueued from HealthKit background-delivery wakes
        // and BGTask sync runs while the phone may be locked;
        // `.complete` would drop that data on the floor.
        XCTAssertEqual(ProtectedStore.offlineBuffer.protectionLevel, .completeUnlessOpen)
    }

    func testPhotosAssetIndexAllowsLockedTimeFlush() {
        // The Photos backfill BGProcessingTask typically runs while the
        // device is locked and charging; its per-page flushes create a
        // new index file each time, which `.complete` would reject.
        XCTAssertEqual(ProtectedStore.photosAssetIndex.protectionLevel, .completeUnlessOpen)
    }

    func testPendingNotesAllowLockedTimeCreation() {
        // The Siri capture intent enqueues notes from a background app
        // launch that can happen while the phone is locked; `.complete`
        // would silently drop the spoken note — the one unacceptable
        // outcome for user-authored content with no upstream copy.
        XCTAssertEqual(ProtectedStore.pendingNotes.protectionLevel, .completeUnlessOpen)
    }

    func testEveryStoreWritesAtomically() {
        for store in ProtectedStore.allCases {
            XCTAssertTrue(
                store.writingOptions.contains(.atomic),
                "\(store) must atomically replace its files so a crash mid-write can't corrupt the store"
            )
        }
    }

    func testEveryCorpusStoreIsExcludedFromBackup() {
        for store in ProtectedStore.allCases {
            XCTAssertTrue(store.isExcludedFromBackup, "\(store) must never enter a device backup")
        }
    }

    func testApplyBackupExclusionMarksTheDirectory() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-backup-exclusion-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertTrue(ProtectedStore.offlineBuffer.applyBackupExclusion(to: directory))
        XCTAssertEqual(
            try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
            true
        )
    }

    func testRequireBackupExclusionFailsClosedWhenDirectoryIsMissing() {
        let missing = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-backup-exclusion-missing-\(UUID().uuidString)")

        XCTAssertThrowsError(
            try ProtectedStore.pendingNotes.requireBackupExclusion(to: missing)
        ) { error in
            XCTAssertEqual(
                error as? ProtectedStoreError,
                .backupExclusionFailed(.pendingNotes)
            )
        }
    }

    func testApplyProtectionOnMissingDirectoryIsANoOp() {
        let missing = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-file-protection-\(UUID().uuidString)")
        ProtectedStore.offlineBuffer.applyProtection(toContentsOf: missing)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: missing.path),
            "stamping must never create the store directory as a side effect"
        )
    }

    func testApplyProtectionLeavesContentsIntact() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("omnesis-file-protection-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("batch.json")
        try Data("{}".utf8).write(to: file)

        ProtectedStore.photosAssetIndex.applyProtection(toContentsOf: directory)

        XCTAssertEqual(
            try String(contentsOf: file, encoding: .utf8),
            "{}",
            "stamping only changes protection attributes, never file contents"
        )
    }
}
