// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.app.Application
import android.service.quicksettings.Tile
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The recording tile: a switch that shows the recording and stops it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RecordingTileServiceTest {

    private val application: Application = ApplicationProvider.getApplicationContext()

    private fun service(recording: Boolean) =
        Robolectric.buildService(RecordingTileService::class.java).create().get().also { it.recording = { recording } }

    @Test
    fun off_while_nothing_is_recorded() {
        val tile = service(recording = false).also { it.onStartListening() }.qsTile

        assertEquals(Tile.STATE_INACTIVE, tile.state)
        assertEquals("Record conversation", tile.label.toString())
        assertEquals("Off", tile.subtitle.toString())
        assertEquals("Tap to start recording", tile.stateDescription.toString())
    }

    @Test
    fun on_while_a_recording_runs() {
        val tile = service(recording = true).also { it.onStartListening() }.qsTile

        assertEquals(Tile.STATE_ACTIVE, tile.state)
        assertEquals("Recording", tile.subtitle.toString())
        assertEquals("Recording. Tap to stop", tile.stateDescription.toString())
    }

    @Test
    fun a_subtitle_is_short_enough_for_a_tile_to_show_whole() {
        for (recording in listOf(true, false)) {
            val subtitle = service(recording).also { it.onStartListening() }.qsTile.subtitle.toString()
            assertTrue(subtitle, subtitle.length <= 10 && subtitle.split(' ').size <= 2)
        }
    }

    @Test
    fun a_tap_while_recording_stops_it_without_opening_anything() {
        service(recording = true).onClick()

        val started = shadowOf(application).nextStartedService
        assertEquals(RecordingForegroundService::class.java.name, started.component?.className)
        assertEquals(RecordingForegroundService.ACTION_STOP, started.action)
        assertEquals(null, shadowOf(application).nextStartedActivity)
    }

    @Test
    @Config(sdk = [33]) // Robolectric has no Quick Settings host for API 34's PendingIntent overload.
    fun a_tap_while_off_opens_the_window_that_starts_the_recording() {
        service(recording = false).onClick()

        // Not the service itself: a microphone service starts only from a visible window.
        assertEquals(null, shadowOf(application).nextStartedService)
        val opened = shadowOf(application).nextStartedActivity
        assertEquals(RecordingStartActivity::class.java.name, opened?.component?.className)
    }
}
