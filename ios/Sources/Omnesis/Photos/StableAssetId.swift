// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Photos)
import Photos

/// Resolves a photo asset's stable `externalId` for gateway ingest.
///
/// `PHAsset.localIdentifier` is device-local — it changes on delete/
/// re-import, on a library restore, and differs across a user's devices
/// even for the SAME iCloud photo. Using it alone would duplicate rows
/// once a user syncs the same library from a second device or restores
/// from backup. `PHAsset.cloudIdentifier` (via the batch
/// `cloudIdentifierMappings` API) is stable across devices and restores
/// for iCloud-synced assets, so it's preferred; `localIdentifier` is only
/// the fallback for local-only assets (iCloud Photos disabled, or an
/// asset not yet uploaded).
public enum StableAssetId {
    /// Batch-resolve stable ids for a set of assets in one call — the
    /// cloud-identifier lookup is a single round-trip regardless of count.
    public static func resolve(for assets: [PHAsset]) -> [String: String] {
        let localIdentifiers = assets.map(\.localIdentifier)
        guard !localIdentifiers.isEmpty else { return [:] }
        let mappings = PHPhotoLibrary.shared()
            .cloudIdentifierMappings(forLocalIdentifiers: localIdentifiers)
        var result: [String: String] = [:]
        for localIdentifier in localIdentifiers {
            switch mappings[localIdentifier] {
            case .success(let cloudIdentifier):
                result[localIdentifier] = cloudIdentifier.stringValue
            case .failure, .none:
                // No iCloud identifier (local-only asset, or iCloud Photos
                // disabled) — fall back to the device-local identifier.
                result[localIdentifier] = localIdentifier
            }
        }
        return result
    }

    /// Single-asset convenience over `resolve(for:)`.
    public static func resolve(for asset: PHAsset) -> String {
        resolve(for: [asset])[asset.localIdentifier] ?? asset.localIdentifier
    }
}
#endif
