// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Photos)
import Photos

/// Real PhotoKit-backed `PhotoLibraryReading` — the only place in this
/// source that touches `PHAsset`/`PHFetchOptions`/`PHImageManager`
/// directly. `PhotosSource` depends only on the protocol, so its
/// cursor/paging/dedup logic is unit-testable without PhotoKit.
///
/// Predicate note: `mediaSubtype`/`creationDate` are Apple's documented
/// supported `PHFetchOptions.predicate` keys.
///
/// Screenshot detection uses two signals, ORed together: `mediaSubtypes
/// .contains(.photoScreenshot)` and membership in the "Screenshots"
/// smart album (`smartAlbumScreenshots`). Confirmed against real device
/// Photos data that the subtype flag alone under-matches — a phone's
/// actual screenshots synced in showed up entirely as `.photo`, never
/// `.screenshot`, with none flagged by `mediaSubtypes`. The smart album
/// is what the Photos app itself uses to populate its Screenshots tab,
/// so it's the more authoritative signal; checking only one under-detects,
/// mirroring the Android source's own AOSP/OEM dual-path lesson for its
/// `RELATIVE_PATH` heuristic.
public final class PHPhotoLibraryReader: PhotoLibraryReading, @unchecked Sendable {
    public var accessState: PhotosAccessState {
        PhotosAuthorization.current
    }

    private let backfillAnalyzers: [any PhotoAnalyzer]
    private let newTierAnalyzers: [any PhotoAnalyzer]
    private let imageManager: PHImageManager
    private let targetSize: CGSize
    /// Photos taken within this many days of "now" fall into the
    /// `.recent` backfill phase (ahead of `.backfill`'s oldest-first
    /// remainder), per the issue's screenshots → recent → oldest
    /// priority order.
    private let recentWindow: TimeInterval

    public init(
        backfillAnalyzers: [any PhotoAnalyzer] = [OCRAnalyzer(), PlaceAnalyzer()],
        newTierAnalyzers: [any PhotoAnalyzer] = [
            OCRAnalyzer(), PlaceAnalyzer(), SceneLabelAnalyzer(), BarcodeAnalyzer(), CaptionAnalyzer(),
        ],
        imageManager: PHImageManager = .default(),
        targetSize: CGSize = CGSize(width: 1024, height: 1024),
        recentWindow: TimeInterval = 30 * 24 * 60 * 60
    ) {
        self.backfillAnalyzers = backfillAnalyzers
        self.newTierAnalyzers = newTierAnalyzers
        self.imageManager = imageManager
        self.targetSize = targetSize
        self.recentWindow = recentWindow
    }

    public func fetchPage(
        phase: PhotosCursor.Phase,
        after cursor: (dateString: String, externalId: String)?,
        limit: Int
    ) async
        -> [PhotoAssetRef] {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        // Only a well-documented `creationDate` floor goes into the
        // predicate (avoids relying on an unverified `localIdentifier >`
        // string-relational predicate); exact same-timestamp tie-breaking
        // against `cursor.externalId` happens below in Swift, bounded to
        // however many assets share that one timestamp (burst photos),
        // not the remainder of the library.
        let cursorDate = PhotosCursor.fetchDateFloor(after: cursor?.dateString)
        if let cursorDate {
            options.predicate = NSPredicate(format: "creationDate >= %@", cursorDate as NSDate)
        }

        let screenshotAlbum = Self.fetchScreenshotAlbum()
        let fetchResult = PHAsset.fetchAssets(with: .image, options: options)
        var matched = PhotoPageSelection<PHAsset>(limit: limit)
        // Once true, every subsequent asset (sorted ascending by
        // creationDate) is unconditionally past the cursor. Only ever
        // flips true when we've seen an asset whose date is STRICTLY
        // after the cursor's tied date — never based on encountering a
        // single same-date asset that clears the tie-break, since
        // `PHFetchResult`'s enumeration order for assets sharing one
        // exact timestamp isn't guaranteed identical across different
        // queries (e.g. this predicate-filtered page vs. an earlier
        // unfiltered one). Flipping early on the first tie-break match
        // would make every OTHER same-date asset pass through
        // unconditionally regardless of its own externalId — silently
        // resyncing some and skipping others depending on enumeration
        // order.
        var pastCursor = cursor == nil
        fetchResult.enumerateObjects { asset, _, stop in
            let dateString = PhotosCursor.dateFormatter.string(from: asset.creationDate ?? .distantPast)
            if matched.isPastBoundary(date: dateString) {
                stop.pointee = true
                return
            }
            var include = pastCursor
            if !pastCursor, let cursor {
                let assetDate = asset.creationDate ?? .distantPast
                // Compare FORMATTED strings, not raw `Date`s: a `Date`
                // decoded back from the cursor's stored string can lose
                // precision the freshly-fetched `assetDate` still has,
                // making an exact-match tie look like "after" the
                // cursor. Formatting both sides through the same
                // formatter before comparing avoids that asymmetry.
                let assetDateString = PhotosCursor.dateFormatter.string(from: assetDate)
                if assetDateString > cursor.dateString {
                    pastCursor = true
                    include = true
                } else if assetDateString == cursor.dateString {
                    // Same-timestamp tie: independently compare stable
                    // ids (order-independent), never "have we seen the
                    // exact cursor asset yet" (order-dependent).
                    include = StableAssetId.resolve(for: asset) > cursor.externalId
                } else {
                    include = false // strictly before the cursor's date
                }
            }
            guard include else { return }
            guard Self.matchesPhase(phase, asset: asset, screenshotAlbum: screenshotAlbum, recentWindow: self.recentWindow) else { return }
            matched.consider(asset, date: dateString, id: StableAssetId.resolve(for: asset))
        }
        return toRefs(matched.assets, screenshotAlbum: screenshotAlbum)
    }

    public func fetchRecentlyAdded(limit: Int) async -> [PhotoAssetRef] {
        let collections = PHAssetCollection.fetchAssetCollections(
            with: .smartAlbum, subtype: .smartAlbumRecentlyAdded, options: nil
        )
        guard let recentlyAdded = collections.firstObject else { return [] }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let fetchResult = PHAsset.fetchAssets(in: recentlyAdded, options: options)
        var assets: [PHAsset] = []
        assets.reserveCapacity(min(limit, fetchResult.count))
        fetchResult.enumerateObjects { asset, _, stop in
            assets.append(asset)
            if assets.count >= limit {
                stop.pointee = true
            }
        }
        return toRefs(assets, screenshotAlbum: Self.fetchScreenshotAlbum())
    }

    public func fetchCompleteSnapshot() async -> PhotoLibrarySnapshot {
        let before = PhotosAuthorization.current
        guard before.isComplete else { return .incomplete(access: before) }
        let options = PHFetchOptions()
        options.includeHiddenAssets = true
        let fetchResult = PHAsset.fetchAssets(with: .image, options: options)
        var assets: [PHAsset] = []
        assets.reserveCapacity(fetchResult.count)
        fetchResult.enumerateObjects { asset, _, _ in assets.append(asset) }
        let mapping = StableAssetId.resolve(for: assets)
        let ids = assets.map { mapping[$0.localIdentifier] ?? $0.localIdentifier }
        let after = PhotosAuthorization.current
        guard after.isComplete else { return .incomplete(access: after) }
        return .complete(externalIds: ids)
    }

    public func analyze(_ asset: PhotoAssetRef, tier: AnalysisTier) async -> PhotoAnalysisFragment {
        guard let phAsset = fetchPHAsset(localIdentifier: asset.localIdentifier) else {
            return PhotoAnalysisFragment()
        }
        let analyzers = tier == .new ? newTierAnalyzers : backfillAnalyzers
        let image = await loadImage(for: phAsset)
        let input = PhotoAnalysisInput(asset: phAsset, image: image)
        var fragments: [PhotoAnalysisFragment] = []
        for analyzer in analyzers {
            guard await analyzer.isAvailable() else { continue }
            if let fragment = await analyzer.analyze(input) {
                fragments.append(fragment)
            }
        }
        return PhotoAnalysisFragment.merge(fragments)
    }

    // MARK: - Internals

    /// The "Screenshots" smart album's members — the second of the two
    /// ORed screenshot-detection signals. `nil` if the album doesn't
    /// exist (e.g. an empty library that's never had one materialize),
    /// in which case detection falls back to the subtype flag alone.
    private static func fetchScreenshotAlbum() -> PHFetchResult<PHAsset>? {
        let collections = PHAssetCollection.fetchAssetCollections(
            with: .smartAlbum, subtype: .smartAlbumScreenshots, options: nil
        )
        guard let album = collections.firstObject else { return nil }
        return PHAsset.fetchAssets(in: album, options: nil)
    }

    private static func isScreenshot(_ asset: PHAsset, screenshotAlbum: PHFetchResult<PHAsset>?) -> Bool {
        asset.mediaSubtypes.contains(.photoScreenshot) || (screenshotAlbum?.contains(asset) ?? false)
    }

    private static func matchesPhase(
        _ phase: PhotosCursor.Phase,
        asset: PHAsset,
        screenshotAlbum: PHFetchResult<PHAsset>?,
        recentWindow: TimeInterval
    )
        -> Bool {
        let isScreenshot = isScreenshot(asset, screenshotAlbum: screenshotAlbum)
        switch phase {
        case .screenshots:
            return isScreenshot
        case .recent:
            guard !isScreenshot else { return false }
            let createdAt = asset.creationDate ?? .distantPast
            return Date().timeIntervalSince(createdAt) <= recentWindow
        case .backfill:
            guard !isScreenshot else { return false }
            let createdAt = asset.creationDate ?? .distantPast
            return Date().timeIntervalSince(createdAt) > recentWindow
        case .steady:
            return true
        }
    }

    private func toRefs(_ assets: [PHAsset], screenshotAlbum: PHFetchResult<PHAsset>?) -> [PhotoAssetRef] {
        guard !assets.isEmpty else { return [] }
        let mapping = StableAssetId.resolve(for: assets)
        return assets.map { asset in
            let now = Date()
            return PhotoAssetRef(
                localIdentifier: asset.localIdentifier,
                externalId: mapping[asset.localIdentifier] ?? asset.localIdentifier,
                creationDate: asset.creationDate ?? .distantPast,
                modificationDate: asset.modificationDate ?? asset.creationDate ?? now,
                isScreenshot: Self.isScreenshot(asset, screenshotAlbum: screenshotAlbum)
            )
        }
    }

    private func fetchPHAsset(localIdentifier: String) -> PHAsset? {
        PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil).firstObject
    }

    private func loadImage(for asset: PHAsset) async -> CGImage? {
        #if canImport(UIKit)
        return await withCheckedContinuation { continuation in
            let options = PHImageRequestOptions()
            options.isSynchronous = false
            options.deliveryMode = .highQualityFormat
            options.isNetworkAccessAllowed = true
            options.resizeMode = .fast
            imageManager.requestImage(
                for: asset,
                targetSize: targetSize,
                contentMode: .aspectFit,
                options: options
            ) { image, _ in
                continuation.resume(returning: image?.cgImage)
            }
        }
        #else
        // `PHImageManager.requestImage` returns `UIImage` and is
        // unavailable on native macOS — this file only needs to
        // TYPE-CHECK there (the SwiftPM logic-lane target), since
        // `PHPhotoLibraryReader` is never actually invoked outside a
        // real iOS device/simulator; `PhotosSource`'s own tests inject
        // a fake `PhotoLibraryReading` instead.
        return nil
        #endif
    }
}
#endif
