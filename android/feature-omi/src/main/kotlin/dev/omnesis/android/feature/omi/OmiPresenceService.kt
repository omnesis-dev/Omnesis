// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.omi

import android.companion.AssociationInfo
import android.companion.CompanionDeviceService
import android.os.Build
import androidx.annotation.RequiresApi

/**
 * The system binds this when the associated pendant comes in range (Android
 * 12+), even with the app's process gone: it brings the link back up, so the
 * pendant's button works after a reboot or a process kill.
 */
@RequiresApi(Build.VERSION_CODES.S)
class OmiPresenceService : CompanionDeviceService() {
    @Deprecated("Below API 33")
    override fun onDeviceAppeared(address: String) {
        OmiLinkService.start(this)
    }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    override fun onDeviceAppeared(associationInfo: AssociationInfo) {
        OmiLinkService.start(this)
    }
}
