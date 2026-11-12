// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.time.Duration.Companion.seconds

class WearLaunchTest {
    private val now = 1_790_000_000_000L

    // Deep links.

    @Test
    fun each_route_has_its_own_link() {
        assertEquals("omnesis-watch://ask", WearRoute.ASK.uri)
        assertEquals("omnesis-watch://note", WearRoute.NOTE.uri)
    }

    @Test
    fun every_link_round_trips() {
        for (route in WearRoute.entries) assertEquals(route, WearRoute.parse(route.uri))
    }

    @Test
    fun scheme_and_host_are_case_insensitive() {
        assertEquals(WearRoute.ASK, WearRoute.parse("OMNESIS-WATCH://ASK"))
        assertEquals(WearRoute.NOTE, WearRoute.parse("Omnesis-Watch://Note"))
    }

    @Test
    fun links_this_app_never_produces_are_rejected() {
        val rejected = listOf(
            "",
            "omnesis-watch://",
            "omnesis-watch://search",
            "omnesis://ask",
            "https://ask",
            "omnesis-watch:ask",
            "omnesis-watch://ask/",
            "omnesis-watch://ask/now",
            "omnesis-watch://ask?text=hello",
            "omnesis-watch://ask#top",
            "omnesis-watch://user@ask",
            "omnesis-watch://ask:8080",
            "omnesis-watch://ask note",
            "not a link",
        )
        for (link in rejected) assertNull(link, WearRoute.parse(link))
    }

    // Capture launch requests.

    @Test
    fun a_request_waits_for_its_screen_and_is_consumed_once() {
        val requests = CaptureLaunchRequests()
        assertFalse(requests.consume(now))
        requests.request(now)
        assertTrue(requests.consume(now + 2_000))
        assertFalse(requests.consume(now + 2_001))
    }

    @Test
    fun repeated_presses_merge_into_one_launch() {
        val requests = CaptureLaunchRequests()
        requests.request(now)
        requests.request(now + 300)
        requests.request(now + 600)
        assertTrue(requests.consume(now + 1_000))
        assertFalse(requests.consume(now + 1_100))
    }

    @Test
    fun a_stale_request_is_dropped_and_a_new_press_opens_the_recorder() {
        val requests = CaptureLaunchRequests()
        assertEquals(30.seconds, CaptureLaunchRequests.FRESHNESS_WINDOW)
        requests.request(now)
        assertFalse(requests.consume(now + 30_000))
        assertFalse(requests.consume(now + 30_001))
        requests.request(now + 40_000)
        assertTrue(requests.consume(now + 69_999))
    }

    // Addressing.

    @Test
    fun paths_and_capabilities_are_stable() {
        assertEquals("omnesis_phone_relay", WearDataLayer.PHONE_CAPABILITY)
        assertEquals("omnesis_watch", WearDataLayer.WATCH_CAPABILITY)
        assertEquals("/omnesis/ask", WearDataLayer.ASK_PATH)
        assertEquals("/omnesis/note", WearDataLayer.NOTE_PATH)
        assertEquals("/omnesis/voice-nudge", WearDataLayer.VOICE_NUDGE_PATH)
        assertEquals("/omnesis/progress", WearDataLayer.PROGRESS_PATH)
        assertEquals("/omnesis/result", WearDataLayer.RESULT_PATH)
        assertEquals("/omnesis/capture-update", WearDataLayer.CAPTURE_UPDATE_PATH)
        assertEquals("/omnesis/displayed", WearDataLayer.DISPLAYED_PATH)
        assertEquals("/omnesis/recording-received", WearDataLayer.RECORDING_RECEIVED_PATH)
        assertEquals("/omnesis/dictation-gate", WearDataLayer.GATE_PATH)
        assertEquals("payload", WearDataLayer.PAYLOAD_KEY)
        assertEquals("audio", WearDataLayer.AUDIO_KEY)
    }

    @Test
    fun message_paths_are_distinct_and_no_item_prefix_swallows_one() {
        val paths = listOf(
            WearDataLayer.ASK_PATH, WearDataLayer.NOTE_PATH, WearDataLayer.VOICE_NUDGE_PATH,
            WearDataLayer.PROGRESS_PATH, WearDataLayer.RESULT_PATH, WearDataLayer.CAPTURE_UPDATE_PATH,
            WearDataLayer.DISPLAYED_PATH, WearDataLayer.RECORDING_RECEIVED_PATH, WearDataLayer.GATE_PATH,
        )
        assertEquals(paths.size, paths.toSet().size)
        for (path in paths) {
            assertNull(path, WearDataLayer.recordingRef(path))
            assertNull(path, WearDataLayer.queuedRef(path))
        }
    }

    @Test
    fun item_paths_carry_their_ref() {
        val ref = "5b0c7a52-0d6f-4a57-9a53-7f2f4f1f0c11"
        assertEquals("/omnesis/recording/$ref", WearDataLayer.recordingPath(ref))
        assertEquals("/omnesis/queued/$ref", WearDataLayer.queuedPath(ref))
        assertEquals(ref, WearDataLayer.recordingRef(WearDataLayer.recordingPath(ref)))
        assertEquals(ref, WearDataLayer.queuedRef(WearDataLayer.queuedPath(ref)))
        assertNull(WearDataLayer.recordingRef(WearDataLayer.queuedPath(ref)))
        assertNull(WearDataLayer.recordingRef("/omnesis/recording/"))
        assertNull(WearDataLayer.recordingRef("/omnesis/recording/$ref/extra"))
    }
}
