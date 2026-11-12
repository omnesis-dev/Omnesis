// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import dev.omnesis.android.wearprotocol.WearRoute
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which launches of the app's screen open the recorder. */
class LaunchIntentTest {
    @Test
    fun a_deep_link_as_the_intents_data_opens_the_recorder() {
        for (route in WearRoute.entries) {
            assertTrue(route.uri, MainActivity.opensRecorder(route.uri, null, replayed = false))
        }
    }

    @Test
    fun a_deep_link_as_the_route_extra_opens_the_recorder() {
        assertTrue(MainActivity.opensRecorder(null, WearRoute.ASK.uri, replayed = false))
    }

    @Test
    fun the_launcher_opens_no_recorder() {
        assertFalse(MainActivity.opensRecorder(null, null, replayed = false))
    }

    @Test
    fun a_link_the_app_does_not_produce_opens_no_recorder() {
        assertFalse(MainActivity.opensRecorder("omnesis-watch://settings", null, replayed = false))
        assertFalse(MainActivity.opensRecorder("omnesis-watch://ask/now", null, replayed = false))
        assertFalse(MainActivity.opensRecorder("https://example.com/ask", null, replayed = false))
        assertFalse(MainActivity.opensRecorder(null, "ask", replayed = false))
    }

    @Test
    fun an_unusable_data_link_is_not_rescued_by_the_extra() {
        assertFalse(MainActivity.opensRecorder("https://example.com/ask", WearRoute.ASK.uri, replayed = false))
    }

    @Test
    fun a_launch_replayed_from_the_recent_apps_list_opens_no_recorder() {
        assertFalse(MainActivity.opensRecorder(WearRoute.ASK.uri, null, replayed = true))
        assertFalse(MainActivity.opensRecorder(null, WearRoute.NOTE.uri, replayed = true))
    }
}
