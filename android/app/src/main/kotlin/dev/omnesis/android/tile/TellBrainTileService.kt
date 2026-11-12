// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.tile

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import dev.omnesis.android.MainActivity
import dev.omnesis.android.R
import dev.omnesis.android.ui.capture.CaptureSurface
import dev.omnesis.android.widgets.TaskWidgetUpdates

/**
 * Omnesis Quick Settings tile: one tap from anywhere straight into
 * the capture screen. On a locked device, [TileService.unlockAndRun] prompts
 * for the keyguard first and launches only after a successful unlock — notes
 * are personal data, so there is no capture-while-locked path.
 *
 * The tile is a shortcut, not a switch: it always shows inactive, the state Quick
 * Settings draws for a tile that does something when tapped without staying on. Its
 * subtitle says what a tap does, or — on a phone not paired with a gateway — that the
 * phone is not paired, in words short enough for a tile to show whole. A screen reader is
 * given the full sentence. A tap opens the app either way.
 */
class TellBrainTileService : TileService() {

    /** Whether this phone holds a pairing. An unreadable pairing store is not reported as unpaired. */
    internal var paired: () -> Boolean = {
        runCatching { TaskWidgetUpdates.pairing(applicationContext) != null }.getOrDefault(true)
    }

    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        tile.state = Tile.STATE_INACTIVE
        tile.label = getString(R.string.tile_tell_brain)
        val isPaired = paired()
        val description =
            getString(if (isPaired) R.string.tile_description_ready else R.string.tile_description_unpaired)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = getString(if (isPaired) R.string.tile_subtitle_ready else R.string.tile_subtitle_unpaired)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Read in place of the subtitle, after the label.
            tile.contentDescription = tile.label
            tile.stateDescription = description
        } else {
            tile.contentDescription = "${tile.label}, $description"
        }
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        unlockAndRun { launchCapture() }
    }

    private fun launchCapture() {
        val intent = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_VOICE_INPUT)
            .putExtra(MainActivity.EXTRA_SURFACE, CaptureSurface.TILE)
            // When this tap was made, so MainActivity acts on it once and never on
            // an old one. FLAG_UPDATE_CURRENT below gives each tap its own stamp.
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
