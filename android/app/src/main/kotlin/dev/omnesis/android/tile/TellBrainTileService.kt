// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.tile

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.service.quicksettings.TileService
import dev.omnesis.android.MainActivity
import dev.omnesis.android.ui.capture.CaptureSurface

/**
 * "Tell Omnesis" Quick Settings tile: one tap from anywhere straight into
 * the capture screen. On a locked device, [TileService.unlockAndRun] prompts
 * for the keyguard first and launches only after a successful unlock — notes
 * are personal data, so there is no capture-while-locked path.
 */
class TellBrainTileService : TileService() {

    override fun onClick() {
        super.onClick()
        unlockAndRun { launchCapture() }
    }

    private fun launchCapture() {
        val intent = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_TELL_BRAIN)
            .putExtra(MainActivity.EXTRA_SURFACE, CaptureSurface.TILE)
            // Per-tap stamp so MainActivity can tell a fresh tile tap from the
            // same intent re-delivered on a process-death relaunch. Requires
            // FLAG_UPDATE_CURRENT below so each tap refreshes the extra.
            .putExtra(MainActivity.EXTRA_LAUNCH_STAMP, SystemClock.elapsedRealtime())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34+ requires the PendingIntent overload; the Intent one throws.
            startActivityAndCollapse(
                PendingIntent.getActivity(
                    this,
                    0,
                    intent,
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }
}
