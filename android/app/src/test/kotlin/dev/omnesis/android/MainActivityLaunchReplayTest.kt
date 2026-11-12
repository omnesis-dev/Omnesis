// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import androidx.test.core.app.ApplicationProvider
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dev.omnesis.android.notifications.NotificationLaunchBus
import dev.omnesis.android.ui.capture.CaptureLaunchBus
import dev.omnesis.android.ui.capture.CaptureSurface
import dev.omnesis.android.ui.search.SearchLaunchBus
import dev.omnesis.android.ui.tasks.TaskFocusBus
import java.time.Duration
import javax.inject.Inject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSystemClock

/**
 * What the real activity does with the intent the system hands it, across the lifecycle
 * the system puts it through: created, sent a new intent, killed and rebuilt with the
 * intent that first opened it.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34])
class MainActivityLaunchReplayTest {
    @get:Rule
    val hilt = HiltAndroidRule(this)

    @Inject lateinit var captures: CaptureLaunchBus
    @Inject lateinit var notifications: NotificationLaunchBus
    @Inject lateinit var searches: SearchLaunchBus
    @Inject lateinit var tasks: TaskFocusBus

    private val context get() = ApplicationProvider.getApplicationContext<HiltTestApplication>()

    @Before
    fun setUp() {
        hilt.inject()
        // A device that has been up for a while, so a stamp is never mistaken for "none".
        passTime(Duration.ofMinutes(10))
    }

    private fun tileTap(): Intent = Intent(context, MainActivity::class.java)
        .setAction(MainActivity.ACTION_VOICE_INPUT)
        .putExtra(MainActivity.EXTRA_SURFACE, CaptureSurface.TILE)
        .putExtra(MainActivity.EXTRA_LAUNCH_STAMP, SystemClock.elapsedRealtime())
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun shortcut(action: String): Intent = Intent(context, MainActivity::class.java).setAction(action)

    private fun created(intent: Intent, saved: Bundle? = null): ActivityController<MainActivity> =
        Robolectric.buildActivity(MainActivity::class.java, intent).create(saved)

    /** The system kills the process: the state is saved, and the activity is later rebuilt from its first intent. */
    private fun ActivityController<MainActivity>.killedAndRebuiltWith(firstIntent: Intent): ActivityController<MainActivity> {
        val saved = Bundle()
        saveInstanceState(saved)
        destroy()
        return created(Intent(firstIntent), saved)
    }

    private fun passTime(duration: Duration) = ShadowSystemClock.advanceBy(duration)

    @Test
    fun a_tile_tap_opens_capture_once() {
        val tap = tileTap()
        val activity = created(tap)
        assertEquals(CaptureSurface.TILE, captures.request.value?.surface)
        captures.consume()

        activity.killedAndRebuiltWith(tap)

        assertNull(captures.request.value)
    }

    @Test
    fun the_first_of_two_tile_taps_does_not_reopen_capture_after_the_process_is_killed() {
        val first = tileTap()
        val activity = created(first)
        captures.consume()
        passTime(Duration.ofSeconds(5))
        activity.newIntent(tileTap())
        assertEquals(CaptureSurface.TILE, captures.request.value?.surface)
        captures.consume()

        // The system kept the first intent, and hands it to the rebuilt activity.
        activity.killedAndRebuiltWith(first)

        assertNull(captures.request.value)
    }

    @Test
    fun the_first_tile_tap_does_not_reopen_capture_even_seconds_after_it() {
        val first = tileTap()
        val activity = created(first)
        captures.consume()
        passTime(Duration.ofSeconds(1))
        activity.newIntent(tileTap())
        captures.consume()

        // Still inside the freshness window: only the record of what was handled refuses it.
        passTime(Duration.ofSeconds(1))
        activity.killedAndRebuiltWith(first)

        assertNull(captures.request.value)
    }

    @Test
    fun a_tile_tap_from_long_ago_never_opens_capture() {
        val tap = tileTap()
        passTime(Duration.ofMillis(MainActivity.CAPTURE_LAUNCH_FRESHNESS_MS + 1))

        created(tap)

        assertNull(captures.request.value)
    }

    @Test
    fun a_tile_tap_stamped_before_the_device_restarted_never_opens_capture() {
        val tap = tileTap().putExtra(MainActivity.EXTRA_LAUNCH_STAMP, SystemClock.elapsedRealtime() + 3_600_000)

        created(tap)

        assertNull(captures.request.value)
    }

    @Test
    fun a_tile_tap_on_a_task_whose_process_was_killed_opens_capture() {
        val first = tileTap()
        val activity = created(first)
        captures.consume()
        passTime(Duration.ofMinutes(3))

        // The system rebuilds the activity from its first intent, then delivers the new tap.
        val rebuilt = activity.killedAndRebuiltWith(first)
        assertNull(captures.request.value)
        rebuilt.newIntent(tileTap())

        assertEquals(CaptureSurface.TILE, captures.request.value?.surface)
    }

    @Test
    fun the_tell_and_voice_shortcuts_open_capture_once() {
        for ((action, surface) in listOf(
            MainActivity.ACTION_TELL_BRAIN to CaptureSurface.APP,
            MainActivity.ACTION_VOICE_INPUT to CaptureSurface.VOICE_SHORTCUT,
        )) {
            val launch = shortcut(action)
            val activity = created(launch)
            assertEquals(action, surface, captures.request.value?.surface)
            captures.consume()

            activity.killedAndRebuiltWith(launch)

            assertNull(action, captures.request.value)
        }
    }

    @Test
    fun a_shortcut_task_reopened_from_the_recent_apps_list_does_not_open_capture() {
        created(shortcut(MainActivity.ACTION_TELL_BRAIN).addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))

        assertNull(captures.request.value)
    }

    @Test
    fun a_handled_capture_request_is_taken_off_the_activity() {
        val activity = created(tileTap()).get()

        assertNull(activity.intent.action)
        assertNull(activity.intent.extras)
    }

    @Test
    fun a_widget_link_opens_its_task_once() {
        val link = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse("omnesis://tasks?view=today&date=2026-03-04"))
        val activity = created(link)
        val opened = tasks.launch.value
        assertEquals("2026-03-04", opened?.journal?.day.toString())
        tasks.consumeLaunch(opened!!)

        activity.killedAndRebuiltWith(link)

        assertNull(tasks.launch.value)
    }

    @Test
    fun a_search_launch_opens_search_once() {
        val launch = shortcut(MainActivity.ACTION_SEARCH).putExtra(MainActivity.EXTRA_SEARCH_QUERY, "boarding pass")
        val activity = created(launch)
        val request = searches.request.value
        assertEquals("boarding pass", request?.query)
        searches.consume(request!!)

        activity.killedAndRebuiltWith(launch)

        assertNull(searches.request.value)
    }

    @Test
    fun the_first_of_two_notification_taps_does_not_reopen_its_conversation_after_the_process_is_killed() {
        fun tap(conversation: String, stamp: Long) = shortcut(MainActivity.ACTION_AGENT_CONVERSATION)
            .putExtra(MainActivity.EXTRA_CONVERSATION_ID, conversation)
            .putExtra(MainActivity.EXTRA_CONVERSATION_LAUNCH_STAMP, stamp)
        val first = tap("conversation-first", stamp = 1_000)
        val activity = created(first)
        assertEquals("conversation-first", notifications.agentConversation.value?.conversationId)
        activity.newIntent(tap("conversation-second", stamp = 2_000))
        assertEquals("conversation-second", notifications.agentConversation.value?.conversationId)
        notifications.consumeAgentConversation()

        activity.killedAndRebuiltWith(first)

        assertNull(notifications.agentConversation.value)
    }
}
