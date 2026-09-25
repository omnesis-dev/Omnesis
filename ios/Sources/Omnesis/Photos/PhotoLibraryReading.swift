// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Everything `PhotosSource` needs from the photo library, abstracted
/// behind a protocol so the cursor/paging/dedup/document-building
/// orchestration in `PhotosSource` is unit-testable with a fake
/// conformer — `PHAsset` has no public initializer, so it can't be
/// constructed in test code; `PHPhotoLibraryReader` is the real
/// PhotoKit-backed conformer used in production.
public protocol PhotoLibraryReading: Sendable {
    var accessState: PhotosAccessState { get }
    /// One page of assets in `phase`'s priority-order predicate,
    /// sorted `(creationDate, externalId)` ascending, starting strictly
    /// after `cursor` (`nil` = from the beginning of the phase).
    /// Returns fewer than `limit` assets only when the phase is
    /// exhausted.
    ///
    /// `cursor.dateString` is the SAME `PhotosCursor.dateFormatter`
    /// encoding used everywhere else in this feature — comparing
    /// formatted strings (not decoded `Date`s) deliberately, since
    /// round-tripping a `Date` through a lossy string format and then
    /// comparing it against a freshly-fetched, un-round-tripped `Date`
    /// is precision-asymmetric (the encode/decode can lose sub-format
    /// precision on one side only) and can wrongly treat the boundary
    /// asset as still pending. Formatting both sides with the same
    /// formatter before comparing avoids that asymmetry entirely.
    func fetchPage(
        phase: PhotosCursor.Phase,
        after cursor: (dateString: String, externalId: String)?,
        limit: Int
    ) async
        -> [PhotoAssetRef]

    /// Assets in Apple's "Recently Added" smart album, newest first,
    /// bounded to `limit` — the fast catch-up path for arrivals the live
    /// observer missed. A separate bounded whole-library walk provides
    /// eventual discovery outside this smart album (see `PhotosSource`).
    func fetchRecentlyAdded(limit: Int) async -> [PhotoAssetRef]

    /// Every asset's stable external id currently in the library — the
    /// whole-library snapshot for the periodic reconcile-deletion pass.
    func fetchCompleteSnapshot() async -> PhotoLibrarySnapshot

    /// Run the analyzer suite for `tier` against one asset and return
    /// its merged fragment.
    func analyze(_ asset: PhotoAssetRef, tier: AnalysisTier) async -> PhotoAnalysisFragment
}

public enum PhotoLibrarySnapshot: Sendable, Equatable {
    case complete(externalIds: [String])
    case incomplete(access: PhotosAccessState)
}

/// Bounded selection for a date-ordered PhotoKit enumeration whose same-date
/// identifiers have no guaranteed order. Inspect the entire boundary timestamp
/// group while retaining only the smallest page of compound keys.
struct PhotoPageSelection<Asset> {
    private struct Entry {
        let asset: Asset
        let date: String
        let id: String
    }

    private let limit: Int
    private var entries: [Entry] = []

    init(limit: Int) {
        precondition(limit > 0)
        self.limit = limit
    }

    var assets: [Asset] {
        entries.map(\.asset)
    }

    func isPastBoundary(date: String) -> Bool {
        entries.count == limit && date > entries[entries.count - 1].date
    }

    mutating func consider(_ asset: Asset, date: String, id: String) {
        let position = entries.firstIndex { date < $0.date || (date == $0.date && id < $0.id) } ?? entries.count
        guard position < limit else { return }
        entries.insert(Entry(asset: asset, date: date, id: id), at: position)
        if entries.count > limit { entries.removeLast() }
    }
}
