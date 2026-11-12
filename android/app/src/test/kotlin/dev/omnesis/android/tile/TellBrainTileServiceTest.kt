// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.tile

import android.app.Application
import android.content.Intent
import android.service.quicksettings.Tile
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.MainActivity
import dev.omnesis.android.ui.capture.CaptureSurface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The Quick Settings tile's appearance and what a tap launches. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class TellBrainTileServiceTest {

    private val application: Application = ApplicationProvider.getApplicationContext()

    private fun service(paired: Boolean) =
        Robolectric.buildService(TellBrainTileService::class.java).create().get().also { it.paired = { paired } }

    @Test
    fun a_paired_phone_shows_an_inactive_tile_that_says_what_a_tap_does() {
        val service = service(paired = true)

        service.onStartListening()

        val tile = service.qsTile
        assertEquals(Tile.STATE_INACTIVE, tile.state)
        assertEquals("Omnesis", tile.label.toString())
        assertEquals("Speak", tile.subtitle.toString())
    }

    @Test
    fun an_unpaired_phone_is_told_it_is_not_paired() {
        val service = service(paired = false)

        service.onStartListening()

        val tile = service.qsTile
        assertEquals(Tile.STATE_INACTIVE, tile.state)
        assertEquals("Omnesis", tile.label.toString())
        assertEquals("Not paired", tile.subtitle.toString())
    }

    @Test
    fun a_subtitle_is_short_enough_for_a_tile_to_show_whole() {
        // "No alarm set" and "Unavailable" are subtitles the system's own tiles show without scrolling.
        for (paired in listOf(true, false)) {
            val service = service(paired)
            service.onStartListening()
            val subtitle = service.qsTile.subtitle.toString()
            assertTrue(subtitle, subtitle.length <= 10 && subtitle.split(' ').size <= 2)
        }
    }

    @Test
    fun a_screen_reader_is_given_the_whole_sentence() {
        val ready = service(paired = true).also { it.onStartListening() }.qsTile
        assertEquals("Omnesis", ready.contentDescription.toString())
        assertEquals("Speak to Omnesis", ready.stateDescription.toString())

        val unpaired = service(paired = false).also { it.onStartListening() }.qsTile
        assertEquals("Omnesis", unpaired.contentDescription.toString())
        assertEquals("Open Omnesis to pair", unpaired.stateDescription.toString())
    }

    @Test
    @Config(sdk = [28])
    fun before_tiles_had_a_state_description_the_sentence_follows_the_label() {
        val ready = service(paired = true).also { it.onStartListening() }.qsTile
        assertEquals("Omnesis, Speak to Omnesis", ready.contentDescription.toString())

        val unpaired = service(paired = false).also { it.onStartListening() }.qsTile
        assertEquals("Omnesis, Open Omnesis to pair", unpaired.contentDescription.toString())
    }

    @Test
    fun the_subtitle_follows_a_pairing_made_while_the_tile_was_hidden() {
        var paired = false
        val service = service(paired = false).also { it.paired = { paired } }
        service.onStartListening()
        assertEquals("Not paired", service.qsTile.subtitle.toString())

        paired = true
        service.onStopListening()
        service.onStartListening()

        assertEquals("Speak", service.qsTile.subtitle.toString())
    }

    @Test
    fun a_tap_launches_capture_in_the_app_as_the_tile_surface() {
        val service = service(paired = true)

        service.onClick()

        val launched = shadowOf(application).nextStartedActivity
        assertEquals(MainActivity::class.java.name, launched.component?.className)
        assertEquals(MainActivity.ACTION_VOICE_INPUT, launched.action)
        assertEquals(CaptureSurface.TILE, launched.getStringExtra(MainActivity.EXTRA_SURFACE))
        assertEquals("android-tile", launched.getStringExtra(MainActivity.EXTRA_SURFACE))
        assertTrue(launched.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertNull(shadowOf(application).nextStartedActivity)
    }

    @Test
    fun each_tap_carries_its_own_launch_stamp() {
        val service = service(paired = true)

        service.onClick()
        val first = shadowOf(application).nextStartedActivity
        org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofSeconds(3))
        service.onClick()
        val second = shadowOf(application).nextStartedActivity

        assertTrue(first.hasExtra(MainActivity.EXTRA_LAUNCH_STAMP))
        assertNotEquals(
            first.getLongExtra(MainActivity.EXTRA_LAUNCH_STAMP, -1),
            second.getLongExtra(MainActivity.EXTRA_LAUNCH_STAMP, -1),
        )
    }

    @Test
    fun an_unpaired_phone_still_opens_the_app_on_a_tap() {
        val service = service(paired = false)

        service.onClick()

        assertEquals(MainActivity.ACTION_VOICE_INPUT, shadowOf(application).nextStartedActivity.action)
    }
}
