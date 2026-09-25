// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

/**
 * Everything [PhotosSource]'s paging/dedup/document-building logic needs
 * from a photo asset, as plain values — decoupled from `MediaStore` so the
 * cursor/backfill/dedup logic is unit-testable without a device/emulator.
 *
 * Unlike iOS (which needs `PHAsset.cloudIdentifier` bridging because the
 * same iCloud photo can carry different `localIdentifier`s across
 * devices/restores), Android's `photos:local` source has no cross-device
 * identity problem — `MediaStore.Images.Media._ID` (stringified) serves as
 * both the local dedup key and the gateway `externalId` directly. There is
 * no `StableAssetId`-equivalent layer here.
 */
data class PhotoAssetRef(
    /** `MediaStore.Images.Media._ID`, stringified — also the gateway `externalId`. */
    val id: String,
    /** `MediaStore.MediaColumns.DATE_ADDED` — epoch SECONDS (not millis; see [PhotosCursor]). */
    val dateAddedSec: Long,
    /** `MediaStore.MediaColumns.DATE_MODIFIED` — epoch SECONDS. */
    val dateModifiedSec: Long,
    val isScreenshot: Boolean,
    /** `content://media/external/images/media/<id>` — the row to open for pixel access. */
    val uri: String,
)

/**
 * Which analyzer tier to run for an asset. The historical backfill is OCR +
 * place only — deliberately cheap. Only genuinely new arrivals (caught by
 * the live JobScheduler content-trigger path or the `.steady`-phase
 * catch-up sweep) get [NEW], the full rich-analysis suite.
 */
enum class AnalysisTier {
    BACKFILL,
    NEW,
}
