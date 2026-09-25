// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

/**
 * Seam through which the photos feature (settings UI, the sync worker, the
 * media-observer job) reaches the live gateway session without depending on
 * the app's composition root. The app binds it to the current session; both
 * accessors return null while unpaired (callers then skip).
 */
interface PhotosSessionProvider {
    /** The active session's sync coordinator, or null while unpaired. */
    fun coordinator(): PhotosSyncCoordinator?

    /** The active pairing's gateway-assigned device id, or null while unpaired. */
    fun deviceId(): String?
}
