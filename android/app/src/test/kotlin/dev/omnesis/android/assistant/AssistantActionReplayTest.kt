// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.assistant

import android.content.Intent
import android.os.Bundle
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ApplicationProvider
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

/**
 * What the Assistant screen does with the intent the system hands it when it rebuilds the
 * screen after killing the process: the shortcut or App Action that first opened it must
 * not open the microphone, or ask its question, a second time.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34])
class AssistantActionReplayTest {
    @get:Rule
    val hilt = HiltAndroidRule(this)

    private val context get() = ApplicationProvider.getApplicationContext<HiltTestApplication>()

    private fun launch(action: String): Intent = Intent(context, AssistantActionActivity::class.java).setAction(action)

    private fun created(intent: Intent, saved: Bundle? = null): ActivityController<AssistantActionActivity> =
        Robolectric.buildActivity(AssistantActionActivity::class.java, intent).create(saved)

    private fun ActivityController<AssistantActionActivity>.state(): AssistantActionUiState =
        ViewModelProvider(get())[AssistantActionViewModel::class.java].state.value

    private fun ActivityController<AssistantActionActivity>.killedAndRebuiltWith(
        firstIntent: Intent,
    ): ActivityController<AssistantActionActivity> {
        val saved = Bundle()
        saveInstanceState(saved)
        destroy()
        return created(Intent(firstIntent), saved)
    }

    private val alreadyHandled = AssistantActionUiState.Finished(
        "Omnesis",
        "This action was already handled. Start it again to run a new request.",
        successful = false,
    )

    @Test
    fun the_ask_shortcut_offers_the_microphone_once() {
        val shortcut = launch(AssistantActionActivity.ACTION_ASK)
        val screen = created(shortcut)
        assertEquals(AssistantActionUiState.ReadyToListen(AssistantActionKind.ASK), screen.state())

        val rebuilt = screen.killedAndRebuiltWith(shortcut)

        assertEquals(alreadyHandled, rebuilt.state())
    }

    @Test
    fun the_first_of_two_requests_is_not_run_again_after_the_process_is_killed() {
        val first = launch(AssistantActionActivity.ACTION_ASK)
            .putExtra(AssistantActionActivity.EXTRA_QUESTION, "When does the pool open?")
        val screen = created(first)
        screen.newIntent(
            launch(AssistantActionActivity.ACTION_CAPTURE).putExtra(AssistantActionActivity.EXTRA_NOTE, "Buy oat milk"),
        )
        assertTrue(screen.state() is AssistantActionUiState.Confirming)

        // The system kept the first intent, and hands it to the rebuilt screen.
        val rebuilt = screen.killedAndRebuiltWith(first)

        assertEquals(alreadyHandled, rebuilt.state())
    }
}
