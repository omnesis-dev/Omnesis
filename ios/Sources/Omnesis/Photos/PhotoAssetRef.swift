// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Everything `PhotosSource`'s paging/dedup/document-building logic
/// needs from a photo asset, as plain values — decoupled from PhotoKit
/// so the cursor/backfill/dedup logic is unit-testable without a
/// simulator (`PHAsset` has no public initializer, so it can't be
/// constructed in test code; production code converts a real `PHAsset`
/// into this shape once per fetch — see `PHPhotoLibraryReader`).
public struct PhotoAssetRef: Sendable, Equatable {
    /// Device-local identifier — NOT the gateway `externalId` (see
    /// `StableAssetId`), but the key `AnalyzedAssetStore` etc. use for
    /// same-process dedup and what `PHPhotoLibraryChangeObserver`
    /// reports for inserted/removed objects.
    public let localIdentifier: String
    /// Stable, cross-device id (`StableAssetId.resolve`) — what's sent
    /// to the gateway as `DocumentInput.externalId`.
    public let externalId: String
    public let creationDate: Date
    public let modificationDate: Date
    public let isScreenshot: Bool

    public init(
        localIdentifier: String,
        externalId: String,
        creationDate: Date,
        modificationDate: Date,
        isScreenshot: Bool
    ) {
        self.localIdentifier = localIdentifier
        self.externalId = externalId
        self.creationDate = creationDate
        self.modificationDate = modificationDate
        self.isScreenshot = isScreenshot
    }
}

/// Which analyzer tier to run for an asset. The historical backfill
/// (`.screenshots`/`.recent`/`.backfill` cursor phases) is OCR + place
/// only — deliberately cheap, per the issue's "backfill is the cheap
/// tier" constraint. Only genuinely new arrivals (caught by the live
/// observer or the `.steady`-phase Recently Added sweep) get `.new`,
/// the full rich-analysis suite.
public enum AnalysisTier: Sendable, Equatable {
    case backfill
    case new
}
