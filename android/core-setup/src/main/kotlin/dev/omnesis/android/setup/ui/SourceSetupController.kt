// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.setup.SetupStepController
import dev.omnesis.android.setup.flow.SetupBusy
import dev.omnesis.android.setup.flow.SetupChoice
import dev.omnesis.android.setup.flow.SourceEnableSequence

/**
 * Hosts a step's [sequence] for the page showing it: launches Android's
 * prompt when the sequence asks for one no page has launched yet — including
 * one asked for while no page was showing — tells the sequence when the app
 * resumes, and when the page goes away. The sequence itself belongs to the
 * step, so everything under way survives the page.
 */
@Composable
fun rememberSourceSetupController(
    sequence: SourceEnableSequence,
    launcher: SetupLauncher,
    primaryEnabled: Boolean = true,
    fineNote: String? = null,
    onAgree: () -> Unit = { sequence.start() },
    secondaryAction: () -> Unit = {},
): SetupStepController {
    val busy by sequence.busy.collectAsStateWithLifecycle()
    val request by sequence.launchRequest.collectAsStateWithLifecycle()
    val currentLauncher by rememberUpdatedState(launcher)
    LaunchedEffect(request) {
        val pending = request ?: return@LaunchedEffect
        if (pending.id != sequence.launchedRequestId) {
            sequence.markLaunched(pending.id)
            currentLauncher.launch()
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { sequence.onResume() }
    DisposableEffect(sequence) {
        onDispose { sequence.onPageLeft() }
    }

    val controller = remember(sequence) { StepController(sequence) }
    SideEffect {
        controller.busyNow = busy
        controller.primaryEnabled = primaryEnabled
        controller.fineNote = fineNote
        controller.agreeAction = onAgree
        controller.secondary = secondaryAction
        controller.launcher = launcher
    }
    return controller
}

private class StepController(private val sequence: SourceEnableSequence) : SetupStepController {
    var busyNow by mutableStateOf(SetupBusy.IDLE)
    override val busy: SetupBusy get() = busyNow
    override var primaryEnabled by mutableStateOf(true)
    override var fineNote by mutableStateOf<String?>(null)
    var agreeAction: () -> Unit = {}
    var secondary: () -> Unit = {}
    var launcher: SetupLauncher? = null

    override fun agree() = agreeAction()

    override fun choose(option: SetupChoice) = sequence.choose(option)

    override fun retry() = sequence.retry()

    override fun openSettings() {
        val open = launcher ?: return
        sequence.settingsOpened()
        if (!open.openSettings()) sequence.onLaunchFailed()
    }

    override fun secondaryAction() = secondary()
}
