// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class AnalyzedAssetStoreTests: XCTestCase {
    private var directory: URL!

    override func setUp() {
        super.setUp()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("omnesis-photos-index-\(UUID().uuidString)")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        super.tearDown()
    }

    private var indexFile: URL {
        directory.appendingPathComponent("photos-asset-index.json")
    }

    private func setIndexReadable(_ readable: Bool) throws {
        try FileManager.default.setAttributes(
            [.posixPermissions: readable ? 0o644 : 0o000],
            ofItemAtPath: indexFile.path
        )
    }

    func testUnknownAndRecordedAssets() async {
        let store = AnalyzedAssetStore(directory: directory)
        let unknownRich = await store.isRichlyAnalyzed("asset-1")
        let unknownPushed = await store.wasPushed("asset-1", inEpoch: 1)
        XCTAssertFalse(unknownRich)
        XCTAssertFalse(unknownPushed)

        await store.record(localIdentifier: "asset-1", richlyAnalyzed: true, epoch: 1)
        let rich = await store.isRichlyAnalyzed("asset-1")
        let pushed = await store.wasPushed("asset-1", inEpoch: 1)
        XCTAssertTrue(rich)
        XCTAssertTrue(pushed)
    }

    func testBackfillNeverDowngradesRichAnalysisOrEpoch() async {
        let store = AnalyzedAssetStore(directory: directory)
        await store.record(localIdentifier: "asset-1", richlyAnalyzed: true, epoch: 2)
        await store.record(localIdentifier: "asset-1", richlyAnalyzed: false, epoch: 1)
        let rich = await store.isRichlyAnalyzed("asset-1")
        let pushed = await store.wasPushed("asset-1", inEpoch: 2)
        XCTAssertTrue(rich)
        XCTAssertTrue(pushed)
    }

    func testRecordPersistsOnlyAfterFlush() async throws {
        let store = AnalyzedAssetStore(directory: directory)
        await store.record(localIdentifier: "asset-1", richlyAnalyzed: true, epoch: 1)
        let beforeFlush = await AnalyzedAssetStore(directory: directory).isRichlyAnalyzed("asset-1")
        XCTAssertFalse(beforeFlush)

        try await store.flush()
        let reloaded = AnalyzedAssetStore(directory: directory)
        let reloadedRich = await reloaded.isRichlyAnalyzed("asset-1")
        let reloadedPushed = await reloaded.wasPushed("asset-1", inEpoch: 1)
        XCTAssertTrue(reloadedRich)
        XCTAssertTrue(reloadedPushed)
    }

    func testUnreadableBaselineIsNeverOverwrittenAndMergesAfterUnlock() async throws {
        let seeded = AnalyzedAssetStore(directory: directory)
        await seeded.record(localIdentifier: "asset-1", richlyAnalyzed: true, epoch: 1)
        try await seeded.flush()
        try setIndexReadable(false)
        defer { try? setIndexReadable(true) }

        let locked = AnalyzedAssetStore(directory: directory)
        await locked.record(localIdentifier: "asset-2", richlyAnalyzed: false, epoch: 2)
        do {
            try await locked.flush()
            XCTFail("flush must refuse to replace an unreadable baseline")
        } catch {}

        try setIndexReadable(true)
        try await locked.flush()
        let reloaded = AnalyzedAssetStore(directory: directory)
        let keptBaseline = await reloaded.isRichlyAnalyzed("asset-1")
        let mergedSession = await reloaded.wasPushed("asset-2", inEpoch: 2)
        XCTAssertTrue(keptBaseline)
        XCTAssertTrue(mergedSession)
    }

    func testBaselineProbeRetriesAfterUnlock() async throws {
        let seeded = AnalyzedAssetStore(directory: directory)
        await seeded.record(localIdentifier: "asset-1", richlyAnalyzed: true)
        try await seeded.flush()
        try setIndexReadable(false)

        let locked = AnalyzedAssetStore(directory: directory)
        let whileLocked = await locked.baselineIsReadable()
        XCTAssertFalse(whileLocked)
        try setIndexReadable(true)
        let afterUnlock = await locked.baselineIsReadable()
        let retained = await locked.isRichlyAnalyzed("asset-1")
        XCTAssertTrue(afterUnlock)
        XCTAssertTrue(retained)
    }
}
