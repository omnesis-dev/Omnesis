// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.R
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.SetupStatusKind
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.flow.PhoneSetupEntry
import dev.omnesis.android.setup.flow.PhoneSetupScreen
import dev.omnesis.android.setup.flow.PhoneSetupState
import dev.omnesis.android.setup.flow.SetupAvailability
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.setup.flow.SetupRow
import dev.omnesis.android.setup.ui.SetupChoosePage
import dev.omnesis.android.setup.ui.SetupChooseRowState
import dev.omnesis.android.setup.ui.SetupChooseRowUi
import dev.omnesis.android.setup.ui.SetupConnectedPage
import dev.omnesis.android.setup.ui.SetupFinishPage
import dev.omnesis.android.setup.ui.SetupFinishRowUi
import dev.omnesis.android.setup.ui.SetupProgress
import dev.omnesis.android.setup.ui.SetupStepPage
import dev.omnesis.android.setup.ui.SetupStepPageActions
import dev.omnesis.android.setup.ui.SetupStepPageUi
import dev.omnesis.android.setup.ui.setupMotionReduced

const val PHONE_SETUP_TEST_TAG = "phone-setup"

/**
 * The phone setup flow, full screen: Connected (first run only), Choose, one
 * page per chosen step, Finish — or, opened from a source's Settings card,
 * only that source's page. [onClose] runs once the flow is finished or skipped.
 */
@Composable
fun PhoneSetupScreen(onClose: () -> Unit, vm: PhoneSetupViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    val rows by vm.rows.collectAsStateWithLifecycle()
    val rowsReady by vm.rowsReady.collectAsStateWithLifecycle()
    val statusLines by vm.statusLines.collectAsStateWithLifecycle()
    val currentOnClose by rememberUpdatedState(onClose)

    // Also the flow's first read of the phone: RESUME is delivered when the screen first composes.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { vm.refresh() }
    LaunchedEffect(state.closed) { if (state.closed) currentOnClose() }

    val screen = state.screen
    val atRoot = screen == PhoneSetupScreen.Connected ||
        vm.entry == PhoneSetupEntry.SOURCE ||
        (vm.entry == PhoneSetupEntry.SETTINGS && screen == PhoneSetupScreen.Choose)
    BackHandler(enabled = !state.closed && !atRoot) { vm.back() }

    val reduced = setupMotionReduced()
    Box(Modifier.fillMaxSize().testTag(PHONE_SETUP_TEST_TAG)) {
        AnimatedContent(
            targetState = screen,
            transitionSpec = {
                if (reduced) {
                    EnterTransition.None togetherWith ExitTransition.None
                } else {
                    fadeIn(tween(durationMillis = 280, delayMillis = 60)) togetherWith fadeOut(tween(durationMillis = 160))
                }
            },
            label = "phoneSetupScreen",
        ) { target ->
            when (target) {
                PhoneSetupScreen.Connected -> SetupConnectedPage(
                    gatewayHost = vm.gatewayHost,
                    mark = painterResource(R.drawable.omnesis_logo),
                    onChooseWhatToAdd = vm::chooseWhatToAdd,
                )
                PhoneSetupScreen.Choose -> SetupChoosePage(
                    rows = chooseRows(vm.steps, rows, state.selection),
                    selectedCount = state.selectedCount(rows),
                    onToggle = vm::toggle,
                    onSetUp = vm::setUp,
                    onSkip = vm::skip,
                    setUpEnabled = rowsReady,
                )
                is PhoneSetupScreen.Step -> if (target.stepId == RELAY_CONSENT_STEP_ID) {
                    RelayConsentHost(state, vm)
                } else {
                    vm.stepById(target.stepId)?.let { step ->
                        key(step.id) { StepHost(step, state, statusLines[step.id], vm) }
                    }
                }
                PhoneSetupScreen.Finish -> SetupFinishPage(
                    contributing = state.contributing,
                    rows = finishRows(vm.steps, rows, state, statusLines),
                    hint = state.firstOnStepId?.let { vm.stepById(it)?.copy?.ask },
                    mark = painterResource(R.drawable.omnesis_logo),
                    onStartAsking = vm::startAsking,
                )
            }
        }
    }
}

@Composable
private fun RelayConsentHost(state: PhoneSetupState, vm: PhoneSetupViewModel) {
    val prompt by vm.relayPrompt.collectAsStateWithLifecycle()
    // Once the request clears, the page fades out still showing the request and position it last had.
    val shown = remember { LastRelayPage() }
    prompt?.let { shown.prompt = it }
    state.plan.indexOf(RELAY_CONSENT_STEP_ID).takeIf { it >= 0 }?.let { shown.progress = SetupProgress(total = state.plan.size, current = it) }
    val current = shown.prompt ?: return
    RelayConsentStepPage(
        appId = current.appId,
        requesting = current.requesting,
        error = current.error,
        progress = shown.progress ?: SetupProgress(total = 1, current = 0),
        onAllow = vm::allowRelay,
        onNotNow = vm::declineRelay,
    )
}

/** What the relay page last showed, kept while it fades out. */
private class LastRelayPage {
    var prompt: SessionManager.RelayConsentPrompt? = null
    var progress: SetupProgress? = null
}

@Composable
private fun StepHost(step: PhoneSetupStep, state: PhoneSetupState, statusLine: SetupStatusLine?, vm: PhoneSetupViewModel) {
    val controller = step.rememberController()
    val index = state.plan.indexOf(step.id).coerceAtLeast(0)
    SetupStepPage(
        ui = SetupStepPageUi(
            copy = step.copy,
            progress = SetupProgress(total = state.plan.size.coerceAtLeast(1), current = index),
            outcome = state.outcomes[step.id],
            busy = controller.busy,
            primaryEnabled = controller.primaryEnabled,
            // A source shows a line from the start; before its first status arrives it has not synced.
            statusLine = statusLine ?: step.sourceId?.let { SetupStatusLine.NotSyncedYet },
            nextLabel = stepNextLabel(state.entry, index, state.plan.size),
            fineNote = controller.fineNote,
        ),
        actions = SetupStepPageActions(
            onNotNow = { vm.notNow(step) },
            onAgree = controller::agree,
            onNext = vm::next,
            onOpenSettings = controller::openSettings,
            onRetry = controller::retry,
            onSecondary = controller::secondaryAction,
            onChoose = controller::choose,
        ),
        extraSection = step.extraSection,
        illustration = step.illustration,
    )
}

/** What moving on from a resolved page says: Next while another page follows, then Finish — or Done, back to Settings, for a single source. */
internal fun stepNextLabel(entry: PhoneSetupEntry, index: Int, planSize: Int): String = when {
    index < planSize - 1 -> "Next"
    entry == PhoneSetupEntry.SOURCE -> "Done"
    else -> "Finish"
}

/** Choose's rows: hidden steps left out, steps already on shown as on, the rest selectable or disabled. */
internal fun chooseRows(steps: List<PhoneSetupStep>, rows: List<SetupRow>, selection: Set<String>): List<SetupChooseRowUi> =
    steps.mapNotNull { step ->
        val row = rows.firstOrNull { it.id == step.id } ?: return@mapNotNull null
        if (!row.visible) return@mapNotNull null
        val disabled = row.availability as? SetupAvailability.Disabled
        val rowState = when {
            row.on -> SetupChooseRowState.On
            disabled != null -> SetupChooseRowState.Disabled(disabled.reason)
            else -> SetupChooseRowState.Selectable(step.id in selection)
        }
        SetupChooseRowUi(step.id, step.copy, step.group, rowState)
    }

/**
 * Finish's rows: every source this phone can host, with its live line when it
 * is on, a quiet note that another device sends it when the user kept that
 * device, "not set up" otherwise, then the other steps that were walked.
 */
internal fun finishRows(
    steps: List<PhoneSetupStep>,
    rows: List<SetupRow>,
    state: PhoneSetupState,
    statusLines: Map<String, SetupStatusLine>,
): List<SetupFinishRowUi> = steps.mapNotNull { step ->
    val row = rows.firstOrNull { it.id == step.id }
    val outcome = state.outcomes[step.id]
    when (step.group) {
        SetupGroup.SOURCE -> {
            if (row == null || !row.visible || (row.availability is SetupAvailability.Disabled && !row.on)) return@mapNotNull null
            val on = row.on || outcome?.kind?.contributing == true
            when {
                on -> SetupFinishRowUi(step.id, step.copy, statusLines[step.id] ?: SetupStatusLine.NotSyncedYet)
                outcome == SetupOutcome.KeptOther -> SetupFinishRowUi(step.id, step.copy, null, note = "Sent by another device")
                else -> SetupFinishRowUi(step.id, step.copy, null)
            }
        }
        SetupGroup.ALSO -> {
            if (step.id !in state.plan) return@mapNotNull null
            SetupFinishRowUi(step.id, step.copy, if (outcome == SetupOutcome.On) SetupStatusLine("On", SetupStatusKind.UP_TO_DATE) else null)
        }
    }
}
