// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import android.content.Intent
import android.os.Bundle
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Which deliveries of a launch intent are requests to act on. */
@RunWith(RobolectricTestRunner::class)
class OneShotLaunchesTest {
    private val request = Intent("example.action.REQUEST")
    private val replayed = Intent(request).addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)

    private fun restored(from: OneShotLaunches) = OneShotLaunches(Bundle().also(from::save))

    @Test
    fun a_stamped_request_is_acted_on_once_however_often_it_is_handed_back() {
        val launches = OneShotLaunches(null)
        assertTrue(launches.accept("kind", request, stamp = 10, LaunchDelivery.CREATED))

        assertFalse(launches.accept("kind", request, stamp = 10, LaunchDelivery.RECREATED))
        assertFalse(restored(launches).accept("kind", request, stamp = 10, LaunchDelivery.RECREATED))
    }

    @Test
    fun the_first_request_handed_back_after_a_later_one_was_handled_is_refused() {
        val launches = OneShotLaunches(null)
        assertTrue(launches.accept("kind", request, stamp = 10, LaunchDelivery.CREATED))
        assertTrue(launches.accept("kind", request, stamp = 20, LaunchDelivery.NEW_INTENT))

        assertFalse(restored(launches).accept("kind", request, stamp = 10, LaunchDelivery.RECREATED))
    }

    @Test
    fun a_later_request_handed_back_after_an_earlier_one_arrived_last_is_refused() {
        // Two notifications posted in order and tapped in reverse: the kept intent is the newer one.
        val launches = OneShotLaunches(null)
        assertTrue(launches.accept("kind", request, stamp = 20, LaunchDelivery.CREATED))
        assertTrue(launches.accept("kind", request, stamp = 10, LaunchDelivery.NEW_INTENT))

        assertFalse(restored(launches).accept("kind", request, stamp = 20, LaunchDelivery.RECREATED))
    }

    @Test
    fun a_new_intent_is_always_a_request() {
        val launches = OneShotLaunches(null)
        assertTrue(launches.accept("kind", request, stamp = 20, LaunchDelivery.NEW_INTENT))
        assertTrue(launches.accept("kind", request, stamp = 10, LaunchDelivery.NEW_INTENT))
        assertTrue(launches.accept("kind", request, stamp = 0, LaunchDelivery.NEW_INTENT))
        assertTrue(launches.accept("kind", replayed, stamp = 0, LaunchDelivery.NEW_INTENT))
    }

    @Test
    fun a_request_newer_than_any_handled_is_acted_on_even_in_a_rebuilt_activity() {
        val launches = OneShotLaunches(null)
        assertTrue(launches.accept("kind", request, stamp = 10, LaunchDelivery.CREATED))

        assertTrue(restored(launches).accept("kind", request, stamp = 30, LaunchDelivery.RECREATED))
    }

    @Test
    fun an_unstamped_request_is_acted_on_only_by_a_new_activity() {
        assertTrue(OneShotLaunches(null).accept("kind", request, stamp = 0, LaunchDelivery.CREATED))
        assertFalse(OneShotLaunches(Bundle()).accept("kind", request, stamp = 0, LaunchDelivery.RECREATED))
    }

    @Test
    fun a_task_reopened_from_the_recent_apps_list_asks_for_nothing() {
        assertFalse(OneShotLaunches(null).accept("kind", replayed, stamp = 0, LaunchDelivery.CREATED))
        assertFalse(OneShotLaunches(null).accept("kind", replayed, stamp = 10, LaunchDelivery.CREATED))
        assertFalse(OneShotLaunches(Bundle()).accept("kind", replayed, stamp = 10, LaunchDelivery.RECREATED))
    }

    @Test
    fun each_kind_of_request_is_counted_on_its_own() {
        val launches = OneShotLaunches(null)
        assertTrue(launches.accept("first", request, stamp = 50, LaunchDelivery.CREATED))

        assertTrue(restored(launches).accept("second", request, stamp = 10, LaunchDelivery.RECREATED))
    }
}
