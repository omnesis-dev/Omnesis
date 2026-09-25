// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

/**
 * Seam through which the health feature (settings UI, [HealthSyncWorker])
 * reaches the live gateway session without depending on the app's composition
 * root. The app binds it to the current session; both accessors return null
 * while unpaired (callers then skip).
 */
interface HealthSessionProvider {
    /** The active session's sync coordinator, or null while unpaired. */
    fun coordinator(): HealthSyncCoordinator?

    /** The active pairing's gateway-assigned device id, or null while unpaired. */
    fun deviceId(): String?
}
