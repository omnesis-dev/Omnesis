// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.ui

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.setup.SetupStepController
import dev.omnesis.android.setup.flow.SetupBusy
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SourceEnableActions
import dev.omnesis.android.setup.flow.SourceEnableSequence
import dev.omnesis.android.transport.ActivationChoice
import dev.omnesis.android.transport.ActivationStep
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * A page hosting a step's enable: a dialog asked for while no page showed —
 * the user left during the gateway inspection — opens when the page comes
 * back, and one a page already opened is never opened again by the page that
 * replaces it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SourceSetupControllerTest {
    @get:Rule
    val compose = createEmptyComposeRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private val inspectGate = CompletableDeferred<Unit>()
    private var on = false
    private val outcomes = mutableListOf<SetupOutcome?>()
    private var launches = 0

    private val actions = object : SourceEnableActions {
        override suspend fun inspect(choice: ActivationChoice?): ActivationStep {
            inspectGate.await()
            return ActivationStep.Ready
        }

        override suspend fun commit(choice: ActivationChoice?): ActivationStep {
            on = true
            return ActivationStep.Ready
        }
    }

    private val sequence = SourceEnableSequence(
        scope = scope,
        actions = actions,
        isOn = { on },
        isGranted = { false },
        outcomeAfterEnable = { SetupOutcome.On },
    )

    private val launcher = object : SetupLauncher {
        override fun launch() {
            launches++
        }

        override fun openSettings(): Boolean = true
    }

    private var showing by mutableStateOf(true)
    private var controller: SetupStepController? = null
    private lateinit var activity: ActivityScenario<ComponentActivity>

    @Before
    fun setUp() {
        val application = ApplicationProvider.getApplicationContext<android.app.Application>()
        shadowOf(application.packageManager).addActivityIfNotPresent(ComponentName(application, ComponentActivity::class.java))
        scope.launch { sequence.outcomes.collect { outcomes += it } }
        activity = ActivityScenario.launch(ComponentActivity::class.java)
        activity.onActivity {
            it.setContent {
                if (showing) controller = rememberSourceSetupController(sequence, launcher)
            }
        }
        compose.waitForIdle()
    }

    @After
    fun tearDown() {
        activity.close()
        scope.cancel()
    }

    @Test
    fun aDialogAskedForWhileNoPageShowedOpensWhenThePageReturnsAndTheEnableCompletes() {
        compose.runOnIdle { controller!!.agree() }
        compose.runOnIdle { showing = false }
        compose.waitForIdle()

        inspectGate.complete(Unit)
        compose.waitForIdle()
        assertEquals("no page is showing to open the dialog", 0, launches)
        assertEquals(SetupBusy.WAITING_FOR_SYSTEM, sequence.busy.value)

        compose.runOnIdle { showing = true }
        compose.waitForIdle()
        assertEquals("the returning page opens the dialog", 1, launches)

        sequence.onAccessResult(granted = true)
        compose.waitForIdle()
        assertEquals(listOf<SetupOutcome?>(SetupOutcome.On), outcomes)
        assertEquals(SetupBusy.IDLE, sequence.busy.value)
    }

    @Test
    fun aPageReplacingOneThatOpenedTheDialogDoesNotOpenItAgain() {
        inspectGate.complete(Unit)
        compose.runOnIdle { controller!!.agree() }
        compose.waitForIdle()
        assertEquals(1, launches)

        compose.runOnIdle { showing = false }
        compose.waitForIdle()
        compose.runOnIdle { showing = true }
        compose.waitForIdle()
        assertEquals(1, launches)
    }

    @Test
    fun notNowAndTryAgainStillAnswerADialogNoPageOpened() {
        compose.runOnIdle { controller!!.agree() }
        compose.runOnIdle { showing = false }
        compose.waitForIdle()
        inspectGate.complete(Unit)
        compose.waitForIdle()

        sequence.notNow()
        assertEquals(SetupBusy.IDLE, sequence.busy.value)
        assertNull(sequence.launchRequest.value)

        sequence.retry()
        assertEquals(SetupBusy.WAITING_FOR_SYSTEM, sequence.busy.value)
        compose.runOnIdle { showing = true }
        compose.waitForIdle()
        assertEquals(1, launches)
    }
}
