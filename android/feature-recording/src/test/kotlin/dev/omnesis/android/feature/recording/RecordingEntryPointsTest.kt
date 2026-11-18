// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.recording

import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.feature.recording.RecordingEntryPoints.Companion.entryPoints
import dev.omnesis.android.feature.recording.ui.RecordingAvailability
import dev.omnesis.android.feature.recording.ui.RecordingAvailability.Availability
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The tile and the shortcut follow the gateway's availability and the recording. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RecordingEntryPointsTest {

    private val context = ApplicationProvider.getApplicationContext<Context>()

    private fun entryPointsFor(): RecordingEntryPoints {
        val availability = object : RecordingAvailability {
            override val state: StateFlow<Availability> = MutableStateFlow(Availability.UNAVAILABLE)
        }
        val controller = RecordingController(InMemoryRecordingOutbox(), RecordingFiles(context.cacheDir.resolve("rec")), onWorkQueued = {})
        return RecordingEntryPoints(context, availability, controller)
    }

    private fun tileState() =
        context.packageManager.getComponentEnabledSetting(RecordingTileService.component(context))

    private fun shortcutIds() = ShortcutManagerCompat.getDynamicShortcuts(context).map { it.id }

    @Test
    fun only_a_gateway_that_takes_recordings_gets_the_tile_and_the_shortcut() {
        assertEquals(RecordingEntryPoints.Wanted(tile = true, shortcut = true), entryPoints(Availability.AVAILABLE, recording = false))
        assertEquals(RecordingEntryPoints.Wanted(tile = false, shortcut = false), entryPoints(Availability.UNAVAILABLE, recording = false))
        // Transcription switched off on the gateway: a recording could not be transcribed.
        assertEquals(RecordingEntryPoints.Wanted(tile = false, shortcut = false), entryPoints(Availability.TRANSCRIPTION_OFF, recording = false))
    }

    @Test
    fun a_running_recording_keeps_the_tile_so_it_can_be_stopped() {
        assertEquals(RecordingEntryPoints.Wanted(tile = true, shortcut = false), entryPoints(Availability.UNAVAILABLE, recording = true))
    }

    @Test
    fun the_tile_is_off_until_the_gateway_takes_recordings() {
        // As the manifest declares it.
        assertTrue(tileState() != PackageManager.COMPONENT_ENABLED_STATE_ENABLED)
    }

    @Test
    fun available_enables_the_tile_and_publishes_the_shortcut() {
        val points = entryPointsFor()

        points.apply(entryPoints(Availability.AVAILABLE, recording = false))

        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, tileState())
        assertEquals(listOf(RecordingEntryPoints.SHORTCUT_ID), shortcutIds())
        val shortcut = ShortcutManagerCompat.getDynamicShortcuts(context).single()
        assertEquals(RecordingStartActivity::class.java.name, shortcut.intent.component?.className)
    }

    @Test
    fun unavailable_removes_them_again() {
        val points = entryPointsFor()
        points.apply(entryPoints(Availability.AVAILABLE, recording = false))

        points.apply(entryPoints(Availability.UNAVAILABLE, recording = false))

        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, tileState())
        assertEquals(emptyList<String>(), shortcutIds())
    }

    @Test
    fun available_again_brings_the_shortcut_back() {
        val points = entryPointsFor()
        points.apply(entryPoints(Availability.AVAILABLE, recording = false))
        points.apply(entryPoints(Availability.UNAVAILABLE, recording = false))

        points.apply(entryPoints(Availability.AVAILABLE, recording = false))

        assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, tileState())
        assertEquals(listOf(RecordingEntryPoints.SHORTCUT_ID), shortcutIds())
    }
}
