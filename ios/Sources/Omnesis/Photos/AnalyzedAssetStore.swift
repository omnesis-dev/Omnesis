// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// One asset's bookkeeping record: whether it completed rich analysis and
/// the latest authorization epoch in which it was pushed.
public struct PhotoAssetRecord: Codable, Sendable, Equatable {
    public let richlyAnalyzed: Bool
    public let lastPushedEpoch: Int

    public init(richlyAnalyzed: Bool, lastPushedEpoch: Int = 0) {
        self.richlyAnalyzed = richlyAnalyzed
        self.lastPushedEpoch = lastPushedEpoch
    }

    private enum CodingKeys: String, CodingKey { case richlyAnalyzed, lastPushedEpoch }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        richlyAnalyzed = try values.decode(Bool.self, forKey: .richlyAnalyzed)
        lastPushedEpoch = try values.decodeIfPresent(Int.self, forKey: .lastPushedEpoch) ?? 0
    }
}

/// Durable per-asset index, keyed by `PHAsset.localIdentifier`. Two
/// jobs:
///
///  1. **Rich-analysis idempotency** — `richlyAnalyzed` is what makes
///     "new / rich-eligible = inserted after enable AND not yet
///     analyzed" true regardless of which path reaches an asset first:
///     `PhotoLibraryObserver`'s live foreground callback and
///     `PhotosSource`'s `.steady`-phase Recently-Added sweep both check
///     this store before running rich analysis, and both mark the
///     asset analyzed afterward — so a photo processed by one path is
///     skipped by the other.
///  2. **Restoration generation** — `lastPushedEpoch` makes a restored Full
///     Photos grant replay every previously visible asset exactly once while
///     preserving ordinary same-epoch deduplication.
///
/// Backed by a single JSON file rather than SQLite — matches
/// `OfflineBuffer`'s "disk is the source of truth, cache in memory"
/// philosophy. Grows to full library size over time (every pushed
/// asset gets an entry, not just richly-analyzed ones), but that's
/// still just short string pairs — tens of thousands of entries is a
/// few MB, well within an in-memory dictionary's comfort zone.
public actor AnalyzedAssetStore {
    private let fileURL: URL
    private let fileManager: FileManager
    private var records: [String: PhotoAssetRecord]?
    /// Set by `record()` when the in-memory state has changed
    /// since the last `flush()`. Persistence is caller-driven (see
    /// `flush()`) rather than automatic per-call, so a backfill page
    /// processing dozens of assets pays for one disk write, not one per
    /// asset.
    private var dirty = false
    /// True when the index file exists on disk but could not be read at
    /// load time — under `ProtectedStore.photosAssetIndex`'s
    /// `.completeUnlessOpen` class this is what a load during a
    /// locked-device background run looks like. While set, the disk
    /// copy (not the empty in-memory stand-in) is the real baseline:
    /// `flush()` re-reads and merges instead of overwriting, so a
    /// locked-time session can never wipe the index.
    private var baselineUnreadable = false

    /// Default per-install directory — mirrors
    /// `PairingCoordinator.bufferDirectory()`'s Application Support
    /// pattern.
    public static func defaultDirectory() -> URL {
        let root = (try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return root.appendingPathComponent("Omnesis/photos-index", isDirectory: true)
    }

    public init(directory: URL, fileManager: FileManager = .default) {
        fileURL = directory.appendingPathComponent("photos-asset-index.json")
        self.fileManager = fileManager
        // Self-heal pass: upgrade an index that carries a weaker
        // protection class than the store's policy. See
        // `ProtectedStore.photosAssetIndex` for the class choice.
        ProtectedStore.photosAssetIndex.applyProtection(
            toContentsOf: directory, fileManager: fileManager
        )
        ProtectedStore.photosAssetIndex.applyBackupExclusion(
            to: directory, fileManager: fileManager
        )
    }

    public func isRichlyAnalyzed(_ localIdentifier: String) async -> Bool {
        await loaded()[localIdentifier]?.richlyAnalyzed ?? false
    }

    public func isRichlyAnalyzed(_ localIdentifier: String, inEpoch epoch: Int) async -> Bool {
        guard let record = await loaded()[localIdentifier] else { return false }
        return record.richlyAnalyzed && record.lastPushedEpoch == epoch
    }

    public func wasPushed(_ localIdentifier: String, inEpoch epoch: Int) async -> Bool {
        await loaded()[localIdentifier]?.lastPushedEpoch == epoch
    }

    /// A missing gateway cursor means this device's stream needs replay.
    /// Retain analysis quality while invalidating only delivery acknowledgments.
    public func resetDeliveryAcknowledgments() async throws {
        guard await baselineIsReadable() else { throw CocoaError(.fileReadNoPermission) }
        records = await loaded().mapValues {
            PhotoAssetRecord(richlyAnalyzed: $0.richlyAnalyzed, lastPushedEpoch: -1)
        }
        dirty = true
        try await flush()
    }

    /// Record that an asset was pushed, and whether this push included the
    /// full rich-analysis suite. Updates
    /// in-memory state only — call `flush()` (once per sync page/sweep)
    /// to persist. An app kill between `record()` and the next `flush()`
    /// loses only that unflushed window's entries: the backfill's real
    /// resume authority is the cursor, not this store, and a lost
    /// rich-analysis mark just costs one redundant re-analysis on the
    /// next pass, not a correctness bug.
    public func record(
        localIdentifier: String,
        richlyAnalyzed: Bool,
        epoch: Int = 0
    ) async {
        var current = await loaded()
        let existing = current[localIdentifier]
        // A backfill-tier push (richlyAnalyzed: false) must never
        // downgrade a prior rich-analysis push for the same asset.
        let resolved = richlyAnalyzed || (existing?.richlyAnalyzed ?? false)
        let resolvedEpoch = max(epoch, existing?.lastPushedEpoch ?? 0)
        guard existing?.richlyAnalyzed != resolved
            || existing?.lastPushedEpoch != resolvedEpoch else { return }
        current[localIdentifier] = PhotoAssetRecord(
            richlyAnalyzed: resolved,
            // An older collector generation can finish after Full access was
            // restored. Never let that late write roll this shared baseline
            // back to its prior authorization epoch.
            lastPushedEpoch: resolvedEpoch
        )
        records = current
        dirty = true
    }

    /// Persist in-memory state to disk if it changed since the last
    /// flush. Call once per sync page/sweep, not per asset. When the
    /// baseline was unreadable at load time, this first re-reads the
    /// disk copy and merges this session's changes over it — rethrowing
    /// (with `dirty` left set, so a later flush retries) while the disk
    /// copy is still unreadable.
    public func flush() async throws {
        guard dirty else { return }
        if baselineUnreadable {
            try await mergeDiskBaselineIntoSession()
        }
        try await persist(loaded())
        dirty = false
    }

    public func count() async -> Int {
        await loaded().count
    }

    /// True when the rich-analysis idempotency baseline can be trusted —
    /// the on-disk index either loaded successfully or was merged into
    /// the session after an earlier failed load. False while the index
    /// file exists but cannot be read (a `.completeUnlessOpen`-protected
    /// file opened during a locked-device background run): the empty
    /// stand-in served in that state makes `isRichlyAnalyzed` fail open,
    /// so callers whose correctness depends on it (see
    /// `PhotosSource.sync`) must skip work instead. Re-attempts the disk
    /// read on every call, so the gate reopens as soon as the device is
    /// unlocked — even within the same store instance.
    public func baselineIsReadable() async -> Bool {
        _ = await loaded()
        guard baselineUnreadable else { return true }
        do {
            try await mergeDiskBaselineIntoSession()
            return true
        } catch {
            return false
        }
    }

    // MARK: - Internals

    private func loaded() async -> [String: PhotoAssetRecord] {
        if let records {
            return records
        }
        let loadedRecords: [String: PhotoAssetRecord]
        do {
            loadedRecords = try load()
        } catch {
            // The file exists but can't be read right now — e.g. a
            // `.completeUnlessOpen`-protected index touched by a
            // background run while the device is locked. Serve an empty
            // stand-in for this session's idempotency checks (cost: a
            // redundant re-analysis per touched asset), but remember
            // that disk holds the real baseline so `flush()` merges
            // rather than overwrites.
            baselineUnreadable = true
            loadedRecords = [:]
        }
        records = loadedRecords
        return loadedRecords
    }

    private func load() throws -> [String: PhotoAssetRecord] {
        guard fileManager.fileExists(atPath: fileURL.path) else { return [:] }
        let data = try Data(contentsOf: fileURL)
        // A file that reads but doesn't decode is corruption, not a
        // protection lock-out — rebuilding from empty is the designed
        // self-heal (a lost rich mark costs one redundant re-analysis).
        return (try? JSONDecoder().decode([String: PhotoAssetRecord].self, from: data)) ?? [:]
    }

    /// Re-read the on-disk index and lay this session's records over it,
    /// never downgrading a disk-side rich-analysis mark (the same stickiness
    /// rule `record()` enforces within a session). Throws while the disk
    /// copy is still unreadable.
    private func mergeDiskBaselineIntoSession() async throws {
        var disk: [String: PhotoAssetRecord] = [:]
        if fileManager.fileExists(atPath: fileURL.path) {
            let data = try Data(contentsOf: fileURL)
            disk = (try? JSONDecoder().decode([String: PhotoAssetRecord].self, from: data)) ?? [:]
        }
        var merged = disk
        for (key, record) in await loaded() {
            let rich = record.richlyAnalyzed || (merged[key]?.richlyAnalyzed ?? false)
            merged[key] = PhotoAssetRecord(
                richlyAnalyzed: rich,
                lastPushedEpoch: max(record.lastPushedEpoch, merged[key]?.lastPushedEpoch ?? 0)
            )
        }
        records = merged
        baselineUnreadable = false
    }

    private func persist(_ records: [String: PhotoAssetRecord]) throws {
        let directory = fileURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        // Stamp the (possibly just-created) directory so the atomic
        // write's temporary file inherits the store's protection class.
        ProtectedStore.photosAssetIndex.applyProtection(
            toContentsOf: directory, fileManager: fileManager
        )
        try ProtectedStore.photosAssetIndex.requireBackupExclusion(
            to: directory, fileManager: fileManager
        )
        let data = try JSONEncoder().encode(records)
        try data.write(to: fileURL, options: ProtectedStore.photosAssetIndex.writingOptions)
    }
}
