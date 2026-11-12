// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.test.core.app.ApplicationProvider
import androidx.work.testing.WorkManagerTestInitHelper
import dev.omnesis.android.wearprotocol.WearRoute
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

/**
 * What the app's screen does with the intent the system hands it across the
 * lifecycle the system puts it through: created by a tile or complication
 * press, pressed again, killed and rebuilt with the intent that first opened it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = WearApp::class)
class LaunchReplayTest {
    private val application = ApplicationProvider.getApplicationContext<Application>() as WearApp
    private val recorderRequests get() = application.container.core.launchRequests.value

    @Before
    fun setUp() {
        // The app's start-up pass over the outbox ends by scheduling its next one.
        WorkManagerTestInitHelper.initializeTestWorkManager(application)
    }

    private fun tilePress(route: WearRoute): Intent = Intent(application, MainActivity::class.java)
        .putExtra(MainActivity.EXTRA_ROUTE, route.uri)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    private fun complicationPress(route: WearRoute): Intent =
        Intent(application, MainActivity::class.java).setData(Uri.parse(route.uri))

    private fun created(intent: Intent, saved: Bundle? = null): ActivityController<MainActivity> =
        Robolectric.buildActivity(MainActivity::class.java, intent).create(saved)

    /** The system kills the process: the state is saved, and the screen is later rebuilt from its first intent. */
    private fun ActivityController<MainActivity>.killedAndRebuiltWith(firstIntent: Intent): ActivityController<MainActivity> {
        val saved = Bundle()
        saveInstanceState(saved)
        destroy()
        return created(Intent(firstIntent), saved)
    }

    @Test
    fun a_press_asks_for_the_recorder_once() {
        for (press in listOf(tilePress(WearRoute.ASK), complicationPress(WearRoute.NOTE))) {
            val before = recorderRequests
            val screen = created(press)
            assertEquals(before + 1, recorderRequests)

            screen.killedAndRebuiltWith(press)

            assertEquals(before + 1, recorderRequests)
        }
    }

    @Test
    fun the_first_of_two_presses_does_not_ask_again_after_the_process_is_killed() {
        val first = tilePress(WearRoute.ASK)
        val before = recorderRequests
        val screen = created(first)
        screen.newIntent(tilePress(WearRoute.ASK))
        assertEquals(before + 2, recorderRequests)

        // The system kept the first intent, and hands it to the rebuilt screen.
        screen.killedAndRebuiltWith(first)

        assertEquals(before + 2, recorderRequests)
    }

    @Test
    fun a_press_on_a_screen_whose_process_was_killed_asks_for_the_recorder() {
        val first = tilePress(WearRoute.ASK)
        val before = recorderRequests
        val rebuilt = created(first).killedAndRebuiltWith(first)

        // The system rebuilds the screen from its first intent, then delivers the new press.
        rebuilt.newIntent(complicationPress(WearRoute.ASK))

        assertEquals(before + 2, recorderRequests)
    }

    @Test
    fun a_screen_reopened_from_the_recent_apps_list_asks_for_nothing() {
        val before = recorderRequests

        created(tilePress(WearRoute.ASK).addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY))

        assertEquals(before, recorderRequests)
    }

    @Test
    fun the_launcher_asks_for_nothing() {
        val before = recorderRequests

        created(Intent(application, MainActivity::class.java).setAction(Intent.ACTION_MAIN))

        assertEquals(before, recorderRequests)
    }
}
