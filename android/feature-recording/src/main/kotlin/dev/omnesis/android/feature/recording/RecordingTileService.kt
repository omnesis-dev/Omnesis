// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent

/**
 * The Quick Settings tile that starts and stops a recorded conversation. It is
 * a switch: on while a recording runs, off otherwise. Turning it on opens
 * [RecordingStartActivity] for a moment, after the keyguard on a locked phone,
 * because a microphone service starts only from a visible window; turning it
 * off stops the recording at once, the same as the notification's Stop.
 *
 * The tile exists only while the gateway takes recordings: the component is
 * disabled in the manifest and [RecordingEntryPoints] turns it on and off.
 */
class RecordingTileService : TileService() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun recordingController(): RecordingController
    }

    /** Whether a recording is running; replaced in tests. */
    internal var recording: () -> Boolean = {
        EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
            .recordingController().state.value is RecordingState.Active
    }

    override fun onStartListening() {
        super.onStartListening()
        val tile = qsTile ?: return
        val on = recording()
        tile.state = if (on) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = LABEL
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = if (on) "Recording" else "Off"
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            tile.contentDescription = LABEL
            tile.stateDescription = if (on) "Recording. Tap to stop" else "Tap to start recording"
        } else {
            tile.contentDescription = if (on) "$LABEL, recording. Tap to stop" else "$LABEL, tap to start recording"
        }
        tile.updateTile()
    }

    override fun onClick() {
        super.onClick()
        if (recording()) {
            RecordingForegroundService.send(this, RecordingForegroundService.ACTION_STOP)
            return
        }
        unlockAndRun { openStart() }
    }

    private fun openStart() {
        val intent = RecordingStartActivity.intent(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // API 34+ requires the PendingIntent overload; the Intent one throws.
            startActivityAndCollapse(
                PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
            )
        } else {
            @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
            startActivityAndCollapse(intent)
        }
    }

    companion object {
        const val LABEL = "Record conversation"

        fun component(context: Context) = ComponentName(context, RecordingTileService::class.java)

        /** Ask Quick Settings to redraw the tile, if it is showing. */
        fun refresh(context: Context) {
            runCatching { requestListeningState(context, component(context)) }
        }
    }
}
