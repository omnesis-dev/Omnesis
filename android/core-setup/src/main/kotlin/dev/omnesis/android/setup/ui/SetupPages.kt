// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.setup.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Smartphone
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.setup.SetupStatusLine
import dev.omnesis.android.setup.SetupStepCopy
import dev.omnesis.android.setup.flow.SetupBusy
import dev.omnesis.android.setup.flow.SetupChoice
import dev.omnesis.android.setup.flow.SetupGroup
import dev.omnesis.android.setup.flow.SetupOutcome
import dev.omnesis.android.transport.ActivationChoice

/** "You're connected": the pairing landed, nothing has been sent, choosing comes next. */
@Composable
fun SetupConnectedPage(gatewayHost: String, mark: Painter, onChooseWhatToAdd: () -> Unit, modifier: Modifier = Modifier) {
    SetupPageScaffold(
        tint = SetupBrandTint,
        modifier = modifier,
        bottom = {
            SetupPrimaryButton("Choose what to add", onChooseWhatToAdd, Modifier.fillMaxWidth().testTag("phoneSetup.choose"))
            SetupFinePrint("Everything here is also in Settings")
        },
    ) {
        SetupConnectedMark(mark)
        SetupTitle("You're connected")
        SetupBody(
            "This phone is now paired with your gateway. Nothing has been sent yet. " +
                "Next, choose what it adds to your index.",
        )
        Spacer(Modifier.height(4.dp))
        SetupConnectionDiagram()
        SetupVerifiedCard(gatewayHost)
    }
}

/** One Choose row, resolved from its step's copy. */
data class SetupChooseRowUi(
    val id: String,
    val copy: SetupStepCopy,
    val group: SetupGroup,
    val state: SetupChooseRowState,
)

/** "What should this phone add?": nothing preselected, one page per selected row after. */
@Composable
fun SetupChoosePage(
    rows: List<SetupChooseRowUi>,
    selectedCount: Int,
    onToggle: (String) -> Unit,
    onSetUp: () -> Unit,
    onSkip: () -> Unit,
    modifier: Modifier = Modifier,
    /** False until the phone's rows have been read, so a row about to appear cannot be missed. */
    setUpEnabled: Boolean = true,
) {
    SetupPageScaffold(
        tint = SetupBrandTint,
        modifier = modifier,
        bottom = {
            SetupPrimaryButton(
                if (selectedCount > 0) "Set up $selectedCount" else "Set up",
                onSetUp,
                Modifier.fillMaxWidth(),
                enabled = selectedCount > 0 && setUpEnabled,
            )
            SetupTextAction("Skip for now", onSkip, Modifier.testTag("phoneSetup.skip"))
        },
    ) {
        Spacer(Modifier.height(6.dp))
        SetupTitle("What should this phone add?")
        SetupBody("Turn on what you want. Each one gets its own page before Android asks for access.")
        Spacer(Modifier.height(2.dp))
        rows.filter { it.group == SetupGroup.SOURCE }.forEach { row -> ChooseRow(row, onToggle) }
        val also = rows.filter { it.group == SetupGroup.ALSO }
        if (also.isNotEmpty()) {
            SetupLabel("Also", Modifier.padding(top = 6.dp, start = 2.dp))
            also.forEach { row -> ChooseRow(row, onToggle) }
        }
    }
}

@Composable
private fun ChooseRow(row: SetupChooseRowUi, onToggle: (String) -> Unit) {
    SetupChooseRow(
        name = row.copy.name,
        value = row.copy.row,
        glyph = row.copy.glyph,
        tint = row.copy.tint,
        state = row.state,
        onToggle = { onToggle(row.id) },
    )
}

/** Everything one step page shows. */
data class SetupStepPageUi(
    val copy: SetupStepCopy,
    val progress: SetupProgress,
    val outcome: SetupOutcome?,
    val busy: SetupBusy = SetupBusy.IDLE,
    val primaryEnabled: Boolean = true,
    val statusLine: SetupStatusLine? = null,
    /** The label that moves on from an outcome: "Next", "Finish" or "Done". */
    val nextLabel: String = "Next",
    /** Replaces the copy's fine print while the step has something to say about its input. */
    val fineNote: String? = null,
)

/** What a step page's controls do. */
class SetupStepPageActions(
    val onNotNow: () -> Unit,
    val onAgree: () -> Unit,
    val onNext: () -> Unit,
    val onOpenSettings: () -> Unit,
    val onRetry: () -> Unit,
    val onSecondary: () -> Unit,
    val onChoose: (SetupChoice) -> Unit,
)

/**
 * One source or capability: its value, the question it makes answerable, the
 * disclosure and ledger, and the agreement that asks Android next. Once the
 * step resolves, its outcome takes the place of the ledger and the actions.
 */
@Composable
fun SetupStepPage(
    ui: SetupStepPageUi,
    actions: SetupStepPageActions,
    modifier: Modifier = Modifier,
    extraSection: (@Composable () -> Unit)? = null,
    illustration: (@Composable () -> Unit)? = null,
) {
    val outcome = ui.outcome?.takeUnless { it.kind.passesOver }
    if (outcome == null) {
        StepIntroduction(ui, actions, modifier, extraSection, illustration)
    } else {
        StepOutcome(ui, outcome, actions, modifier)
    }
}

@Composable
private fun StepIntroduction(
    ui: SetupStepPageUi,
    actions: SetupStepPageActions,
    modifier: Modifier,
    extraSection: (@Composable () -> Unit)?,
    illustration: (@Composable () -> Unit)?,
) {
    val copy = ui.copy
    val palette = setupPalette
    SetupPageScaffold(
        tint = copy.tint,
        modifier = modifier,
        progress = ui.progress,
        bottom = {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SetupTextAction("Not now", actions.onNotNow, color = palette.textSecondary, enabled = ui.busy == SetupBusy.IDLE)
                SetupPrimaryButton(
                    copy.primaryLabel,
                    actions.onAgree,
                    Modifier.weight(1f),
                    enabled = ui.primaryEnabled,
                    busy = ui.busy,
                    workingLabel = copy.turningOnLabel(),
                )
            }
            (ui.fineNote ?: copy.fine)?.let { SetupFinePrint(it) }
        },
    ) {
        SetupGlyphTile(copy.glyph, copy.tint)
        SetupTitle(copy.name)
        SetupBody(copy.value)
        copy.disclosure?.let { SetupDisclosure(it) }
        copy.ask?.let { SetupAskCard(it) }
        illustration?.invoke()
        val ledger = copy.ledger
        if (ledger != null) {
            SetupLedgerCard(ledger, extraSection = extraSection)
        } else if (copy.highlights.isNotEmpty()) {
            SetupHighlightsCard(copy.highlights, copy.tint)
        }
    }
}

@Composable
private fun StepOutcome(
    ui: SetupStepPageUi,
    outcome: SetupOutcome,
    actions: SetupStepPageActions,
    modifier: Modifier,
) {
    val copy = ui.copy
    val palette = setupPalette
    val text = outcomeText(copy, outcome)
    SetupPageScaffold(
        tint = copy.tint,
        modifier = modifier,
        progress = ui.progress,
        centered = true,
        bottom = {
            // A choice is answered by picking one of its options, so it offers nothing else here.
            if (outcome !is SetupOutcome.ChoiceRequired) {
                if (outcome.opensSettings) {
                    copy.settingsSteps?.let { SetupFinePrint(it) }
                }
                secondaryAction(copy, outcome, actions)?.let { (label, onClick) ->
                    SetupSecondaryButton(label, onClick, Modifier.fillMaxWidth(), enabled = ui.busy == SetupBusy.IDLE)
                }
                SetupPrimaryButton(
                    ui.nextLabel,
                    actions.onNext,
                    Modifier.fillMaxWidth(),
                    busy = ui.busy,
                    workingLabel = if (outcome is SetupOutcome.Failed) "Trying again…" else copy.turningOnLabel(),
                )
            }
        },
    ) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            when {
                // Keyed to the outcome, so an outcome that changes in place — back from Settings — draws the ring again.
                outcome.kind.contributing -> SetupCheckRing(copy.tint, drawKey = outcome)
                outcome is SetupOutcome.NotAllowed -> SetupOutcomeBadge(Icons.Outlined.Lock, palette.textSecondary)
                outcome is SetupOutcome.Unavailable -> SetupOutcomeBadge(Icons.Outlined.WarningAmber, OmTheme.colors.warning)
                outcome is SetupOutcome.ChoiceRequired -> SetupOutcomeBadge(Icons.Outlined.Devices, copy.tint.asSetupForeground(palette))
                else -> SetupOutcomeBadge(Icons.Outlined.ErrorOutline, palette.danger)
            }
            Spacer(Modifier.height(2.dp))
            SetupTitle(text.first, centered = true)
            SetupBody(text.second, centered = true)
        }
        if (outcome is SetupOutcome.ChoiceRequired) {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                outcome.options.forEach { option ->
                    SetupChoiceCard(
                        title = option.title,
                        detail = option.detail,
                        glyph = choiceGlyph(option),
                        tint = copy.tint,
                        onClick = { actions.onChoose(option) },
                        enabled = ui.busy == SetupBusy.IDLE,
                    )
                }
                if (ui.busy != SetupBusy.IDLE) {
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        OmSpinner(modifier = Modifier.size(16.dp), color = palette.textSecondary, strokeWidth = 2.dp)
                        Text(
                            setupBusyLabel(ui.busy, copy.turningOnLabel()),
                            style = MaterialTheme.typography.bodyMedium,
                            color = palette.textSecondary,
                        )
                    }
                }
            }
        }
        if (outcome.kind.contributing) {
            ui.statusLine?.let { SetupSourceStatusRow(copy.name, copy.glyph, copy.tint, it) }
        }
    }
}

private fun outcomeText(copy: SetupStepCopy, outcome: SetupOutcome): Pair<String, String> = when (outcome) {
    SetupOutcome.On -> (copy.onTitle ?: "${copy.name} is on") to copy.onBody
    SetupOutcome.Limited -> (copy.onTitle ?: "${copy.name} is on") to (copy.limitedBody ?: copy.onBody)
    SetupOutcome.Partial -> "${copy.name} is on, with limits" to (copy.partialBody ?: copy.onBody)
    SetupOutcome.NotAllowed ->
        (copy.offTitle ?: "${copy.name} is off") to
            (copy.offBody ?: "You can allow ${copy.permissionLabel} for Omnesis in Settings any time.")
    is SetupOutcome.Unavailable -> outcome.title to outcome.body
    is SetupOutcome.ChoiceRequired -> "Another device already sends ${copy.name}" to "Choose how this phone should contribute."
    is SetupOutcome.Failed ->
        "Couldn't turn on ${copy.name}" to (
            outcome.message?.replace(TRAILING_RETRY, "")?.trim()?.takeIf { it.isNotBlank() }
                ?: "Something went wrong. Nothing was changed."
            )
    SetupOutcome.Skipped, SetupOutcome.KeptOther -> "" to ""
}

private fun choiceGlyph(option: SetupChoice): ImageVector = when (option.id) {
    ActivationChoice.USE_BOTH.name -> Icons.Outlined.Devices
    ActivationChoice.TAKE_OVER.name -> Icons.Outlined.SwapHoriz
    else -> Icons.Outlined.Smartphone
}

/** What the step's primary says while its enable runs without a system screen up. */
private fun SetupStepCopy.turningOnLabel(): String = workingLabel ?: "Turning on $name…"

/** Whether the outcome's action takes the user to a settings screen, where [SetupStepCopy.settingsSteps] guides them. */
private val SetupOutcome.opensSettings: Boolean
    get() = this == SetupOutcome.NotAllowed || this == SetupOutcome.Partial

/** A closing "Try again." in a failure message, which the page's own Try again button already says. */
private val TRAILING_RETRY = Regex("\\s*Try again\\.?$")

private fun secondaryAction(copy: SetupStepCopy, outcome: SetupOutcome, actions: SetupStepPageActions): Pair<String, () -> Unit>? = when (outcome) {
    SetupOutcome.Limited -> copy.limitedActionLabel?.let { it to actions.onSecondary }
    SetupOutcome.Partial -> (copy.partialActionLabel ?: "Open Settings") to actions.onOpenSettings
    SetupOutcome.NotAllowed -> "Open Settings" to actions.onOpenSettings
    is SetupOutcome.Unavailable -> outcome.actionLabel?.let { it to actions.onSecondary }
    is SetupOutcome.Failed -> "Try again" to actions.onRetry
    else -> null
}

/** One Finish row, resolved from its step's copy; [note] says why a source without a status sends nothing from here. */
data class SetupFinishRowUi(val id: String, val copy: SetupStepCopy, val status: SetupStatusLine?, val note: String? = null)

/** Proof the phone is contributing, the hand-off to the agent, and a first question to try. */
@Composable
fun SetupFinishPage(
    contributing: Boolean,
    rows: List<SetupFinishRowUi>,
    hint: String?,
    mark: Painter,
    onStartAsking: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SetupPageScaffold(
        tint = SetupBrandTint,
        modifier = modifier,
        bottom = {
            SetupPrimaryButton("Start asking", onStartAsking, Modifier.fillMaxWidth())
            hint?.let {
                Text(
                    "Try “$it”",
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp),
                    color = setupPalette.textMuted,
                    textAlign = TextAlign.Center,
                )
            }
        },
    ) {
        Spacer(Modifier.height(10.dp))
        SetupBrandMark(mark)
        SetupTitle(if (contributing) "This phone is contributing" else "You're all set")
        SetupBody(
            if (contributing) {
                "Your gateway is indexing what arrives. It keeps going in the background."
            } else {
                "Nothing is coming from this phone yet. You can add sources from Settings any time."
            },
        )
        Spacer(Modifier.height(2.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            rows.forEach { row ->
                SetupSourceStatusRow(row.copy.name, row.copy.glyph, row.copy.tint, row.status, note = row.note)
            }
        }
    }
}
