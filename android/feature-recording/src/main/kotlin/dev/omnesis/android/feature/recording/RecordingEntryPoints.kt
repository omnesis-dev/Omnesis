// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.feature.recording.ui.RecordingAvailability
import dev.omnesis.android.feature.recording.ui.RecordingAvailability.Availability
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * The quick ways into a recorded conversation, besides the Recordings screen:
 * the Quick Settings tile and the launcher shortcut. Both exist only while the
 * paired gateway takes recordings ([Availability.AVAILABLE], remembered while
 * the gateway is out of reach), and the tile also while a recording runs, so
 * it can stop it. The tile is redrawn whenever a recording starts, pauses or
 * stops. Started once by the app.
 */
@Singleton
class RecordingEntryPoints @Inject constructor(
    @ApplicationContext private val context: Context,
    private val availability: RecordingAvailability,
    private val controller: RecordingController,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch {
            combine(availability.state, controller.state) { a, s -> entryPoints(a, s is RecordingState.Active) }
                .distinctUntilChanged()
                .collect(::apply)
        }
        scope.launch {
            controller.state.collect { RecordingTileService.refresh(context) }
        }
    }

    /** What should exist for this availability and recording state. */
    internal data class Wanted(val tile: Boolean, val shortcut: Boolean)

    internal fun apply(wanted: Wanted) {
        runCatching { setTile(wanted.tile) }.onFailure { Log.w(TAG, "Tile not updated", it) }
        runCatching { setShortcut(wanted.shortcut) }.onFailure { Log.w(TAG, "Shortcut not updated", it) }
    }

    private fun setTile(enabled: Boolean) {
        val component = RecordingTileService.component(context)
        val state = if (enabled) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        } else {
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        }
        val pm = context.packageManager
        if (pm.getComponentEnabledSetting(component) == state) return
        pm.setComponentEnabledSetting(component, state, PackageManager.DONT_KILL_APP)
    }

    private fun setShortcut(enabled: Boolean) {
        if (!enabled) {
            ShortcutManagerCompat.removeDynamicShortcuts(context, listOf(SHORTCUT_ID))
            // A copy pinned to the home screen stays, greyed, with this message.
            ShortcutManagerCompat.disableShortcuts(context, listOf(SHORTCUT_ID), UNAVAILABLE_MESSAGE)
            return
        }
        ShortcutManagerCompat.enableShortcuts(context, listOf(shortcut()))
        ShortcutManagerCompat.pushDynamicShortcut(context, shortcut())
    }

    private fun shortcut(): ShortcutInfoCompat =
        ShortcutInfoCompat.Builder(context, SHORTCUT_ID)
            .setShortLabel("Record")
            .setLongLabel(RecordingTileService.LABEL)
            .setIcon(IconCompat.createWithResource(context, R.drawable.ic_shortcut_record))
            .setIntent(RecordingStartActivity.intent(context))
            .build()

    companion object {
        private const val TAG = "Omnesis:Recording"
        const val SHORTCUT_ID = "record_conversation"
        const val UNAVAILABLE_MESSAGE = "The gateway does not take recordings"

        internal fun entryPoints(availability: Availability, recording: Boolean): Wanted {
            val available = availability == Availability.AVAILABLE
            return Wanted(tile = available || recording, shortcut = available)
        }
    }
}
