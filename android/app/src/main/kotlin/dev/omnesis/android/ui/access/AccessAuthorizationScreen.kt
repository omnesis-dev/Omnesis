// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.access

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.MarkdownText
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import dev.omnesis.android.transport.dto.AccessAuthorizationRequest
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AccessReconnectProposal
import kotlinx.coroutines.delay

/**
 * The wizard, opened either on code entry, on a code a QR or notification delivered, or on
 * a request the main screen's banner named by id — the last skips code entry altogether.
 */
@Composable
fun AccessAuthorizationScreen(
    onClose: () -> Unit,
    initialCode: String? = null,
    initialRequestId: String? = null,
    launchNonce: Long = 0L,
    expectedPairing: AccessAuthorizationPairingIdentity? = null,
    vm: AccessAuthorizationViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(initialCode, initialRequestId, launchNonce, expectedPairing) {
        when {
            expectedPairing == null -> Unit
            initialRequestId != null -> vm.lookupInitialById(initialRequestId, launchNonce, expectedPairing)
            initialCode != null -> vm.lookupInitial(initialCode, launchNonce, expectedPairing)
        }
    }
    val navigateBack = {
        val previous = if (state.completion == null) {
            state.form?.let { previousStep(state.step, it, state.request?.requiresAnswer == true) }
        } else {
            null
        }
        if (previous == null) onClose() else vm.goTo(previous)
    }
    BackHandler(onBack = navigateBack)
    AccessAuthorizationContent(
        state = state,
        onClose = navigateBack,
        onCodeChange = vm::updateCode,
        onLookup = { vm.lookup() },
        onDecide = vm::decide,
        onFormChange = vm::updateForm,
        onStepChange = vm::goTo,
        onShowPolicy = vm::showPolicy,
        onDismissPolicy = vm::dismissPolicy,
        iconFor = vm::sourceIcon,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AccessAuthorizationContent(
    state: AccessAuthorizationUiState,
    onClose: () -> Unit,
    onCodeChange: (String) -> Unit = {},
    onLookup: () -> Unit,
    onDecide: (Boolean, dev.omnesis.android.transport.dto.AccessAuthorizationSelection?) -> Unit,
    onFormChange: (AccessAuthorizationForm) -> Unit = {},
    onStepChange: (AccessAuthorizationStep) -> Unit = {},
    onShowPolicy: (String) -> Unit = {},
    onDismissPolicy: () -> Unit = {},
    iconFor: (String) -> SourceIconModel = { SourceIconModel(fallbackInitial = it.take(1).uppercase()) },
    /**
     * The current time, in epoch milliseconds, that the deadline and "Last used" times are
     * measured against. Screenshots pass a fixed instant so their text never drifts.
     */
    clock: () -> Long = System::currentTimeMillis,
) {
    val c = OmTheme.colors
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                title = {
                    Text(when {
                        state.completion != null -> "Authorization"
                        state.request == null -> "Connect an agent"
                        else -> "Review access"
                    })
                },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.bgPrimary),
            )
        },
    ) { padding ->
        if (state.completion != null) {
            AuthorizationCompletion(
                completion = state.completion,
                clientName = state.request?.clientName,
                onClose = onClose,
                modifier = Modifier.padding(padding),
            )
        } else if (state.request == null || state.overview == null) {
            AuthorizationCodeEntry(
                code = state.code,
                loading = state.loading,
                error = state.lookupError,
                onCodeChange = onCodeChange,
                onLookup = onLookup,
                modifier = Modifier.padding(padding),
            )
        } else {
            AuthorizationWizard(
                request = state.request,
                reconnect = state.reconnect,
                overview = state.overview,
                step = state.step,
                form = requireNotNull(state.form),
                deciding = state.deciding,
                actionError = state.actionError,
                levelNameTaken = state.levelNameTaken,
                onDecide = onDecide,
                onFormChange = onFormChange,
                onStepChange = onStepChange,
                onShowPolicy = onShowPolicy,
                iconFor = iconFor,
                clock = clock,
                // The keyboard takes its height from the bottom of the wizard, so the step and its
                // actions stay above it; the insets this Scaffold already padded are not counted twice.
                modifier = Modifier.padding(padding).consumeWindowInsets(padding).imePadding(),
            )
        }
    }
    state.policyPreview?.let { preview ->
        AccessPolicySheet(preview = preview, onDismiss = onDismissPolicy)
    }
}

/**
 * The chosen policy's text, over the wizard rather than in place of it. The wizard holds its
 * own actions at the foot of a nested Scaffold, so a nav destination would unwind the
 * part-made decision the operator came here to finish.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AccessPolicySheet(preview: AccessPolicyPreview, onDismiss: () -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = OmTheme.colors.bgPrimary,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        AccessPolicySheetBody(preview)
    }
}

/** The sheet's content: the family's name, then its text, a spinner, or why it could not load. */
@Composable
internal fun AccessPolicySheetBody(preview: AccessPolicyPreview, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = OmSpacing.lg)
            .padding(bottom = OmSpacing.xl),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        Text(preview.name, style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
        when {
            preview.loading -> OmSpinner(Modifier.size(24.dp))
            preview.error != null -> Text(
                preview.error,
                color = c.danger,
                style = MaterialTheme.typography.bodyMedium,
            )
            else -> {
                Text(
                    "Answers to this agent are reviewed against this policy before release.",
                    color = c.textSecondary,
                    style = MaterialTheme.typography.bodyMedium,
                )
                MarkdownText(
                    markdown = preview.document?.policy.orEmpty(),
                    modifier = Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textSecondary,
                )
            }
        }
    }
}

@Composable
private fun AuthorizationCompletion(
    completion: AccessAuthorizationCompletion,
    clientName: String?,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val approved = completion == AccessAuthorizationCompletion.APPROVED
    Column(
        modifier.fillMaxSize().padding(OmSpacing.xl),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(OmSpacing.xl))
        Icon(
            if (approved) Icons.Outlined.CheckCircle else Icons.Outlined.Cancel,
            contentDescription = null,
            tint = if (approved) OmTheme.colors.accent else OmTheme.colors.textSecondary,
            modifier = Modifier.size(48.dp),
        )
        Text(
            if (approved) "Access granted" else "Request denied",
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            if (approved) {
                "${clientName ?: "The requesting app"} can now finish connecting."
            } else {
                "No access was granted to ${clientName ?: "the requesting app"}."
            },
            color = OmTheme.colors.textSecondary,
            style = MaterialTheme.typography.bodyLarge,
        )
        Button(onClick = onClose, modifier = Modifier.fillMaxWidth().height(48.dp)) {
            Text("Done")
        }
    }
}

@Composable
private fun AuthorizationCodeEntry(
    code: String,
    loading: Boolean,
    error: String?,
    onCodeChange: (String) -> Unit,
    onLookup: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    Column(
        modifier.fillMaxSize().padding(OmSpacing.xl),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.lg),
    ) {
        Icon(Icons.Outlined.Key, contentDescription = null, tint = c.accent)
        Text("Enter the code shown by the app that wants to connect.", style = MaterialTheme.typography.headlineSmall)
        Text(
            "The notification contains no request details. Omnesis shows who is connecting only after this phone verifies the code.",
            color = c.textSecondary,
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedTextField(
            value = code,
            onValueChange = onCodeChange,
            label = { Text("Authorization code") },
            placeholder = { Text("ABCD-EFGH") },
            singleLine = true,
            textStyle = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Monospace),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
            keyboardActions = KeyboardActions(onGo = { if (code.isNotBlank() && !loading) onLookup() }),
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = c.danger, style = MaterialTheme.typography.bodyMedium) }
        Button(
            onClick = onLookup,
            enabled = code.isNotBlank() && !loading,
            modifier = Modifier.fillMaxWidth().height(48.dp),
        ) {
            if (loading) OmSpinner(Modifier.size(18.dp)) else Text("Continue")
        }
    }
}

@Composable
private fun AuthorizationWizard(
    request: AccessAuthorizationRequest,
    reconnect: AccessReconnectProposal?,
    overview: AccessOverview,
    step: AccessAuthorizationStep,
    form: AccessAuthorizationForm,
    deciding: Boolean,
    actionError: String?,
    levelNameTaken: Boolean,
    onDecide: (Boolean, dev.omnesis.android.transport.dto.AccessAuthorizationSelection?) -> Unit,
    onFormChange: (AccessAuthorizationForm) -> Unit,
    onStepChange: (AccessAuthorizationStep) -> Unit,
    onShowPolicy: (String) -> Unit,
    iconFor: (String) -> SourceIconModel,
    clock: () -> Long,
    modifier: Modifier = Modifier,
) {
    val nowMillis by produceState(clock(), request.expiresAt, clock) {
        while (value < request.expiresAt) {
            delay(1_000)
            value = clock()
        }
    }
    val expired = nowMillis >= request.expiresAt
    // The clock ticks every second; the decision depends only on these, so it is not rebuilt
    // on each tick.
    val selection = remember(form, overview, request) { form.selection(request, overview) }
    val steps = authorizationSteps(form, request.requiresAnswer)
    val stepIndex = steps.indexOf(step).coerceAtLeast(0)
    Scaffold(
        modifier = modifier,
        containerColor = OmTheme.colors.bgPrimary,
        bottomBar = {
            WizardActions(
                first = stepIndex == 0,
                last = stepIndex == steps.lastIndex,
                canContinue = !expired && when (step) {
                    AccessAuthorizationStep.CONNECTION -> form.connection?.canContinue(request, overview) == true
                    AccessAuthorizationStep.PERMISSIONS ->
                        form.answerEnabled || request.requiresAnswer || form.directEnabled || form.notesEnabled
                    AccessAuthorizationStep.DATA, AccessAuthorizationStep.REVIEW -> selection != null
                },
                deciding = deciding,
                onBack = { onStepChange(steps[stepIndex - 1]) },
                onContinue = { onStepChange(steps[stepIndex + 1]) },
                onDeny = { onDecide(false, null) },
                onAllow = { onDecide(true, selection) },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = OmSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        ) {
            item {
                AuthorizationRequestHeader(
                    clientName = request.clientName,
                    deadline = authorizationDeadlineText(request.expiresAt, nowMillis),
                    expired = expired,
                    steps = steps,
                    step = step,
                    onStepChange = onStepChange,
                )
            }
            actionError?.let { item { WarningCard(it) } }
            when (step) {
                AccessAuthorizationStep.CONNECTION -> item {
                    ConnectionStep(request, overview, form, nowMillis, levelNameTaken, onFormChange)
                }
                AccessAuthorizationStep.PERMISSIONS -> item {
                    PermissionsStep(request, form, onFormChange)
                }
                AccessAuthorizationStep.DATA -> item {
                    DataAndPrivacyStep(overview, request, form, iconFor, onShowPolicy, onFormChange)
                }
                AccessAuthorizationStep.REVIEW -> item {
                    ReviewStep(
                        request = request,
                        overview = overview,
                        form = form,
                        legacyConnectionName = reconnect?.principal?.name,
                    )
                }
            }
            item { Spacer(Modifier.height(OmSpacing.xl)) }
            if (stepIndex == 0) {
                item {
                    Text(
                        "Going back leaves this request pending until it expires. You can enter the code again.",
                        color = OmTheme.colors.textSecondary,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

/**
 * Who is asking and how long the request stands, above the wizard's steps.
 *
 * It scrolls with the step below it, so on a short screen with the keyboard open the field
 * being typed into can still be brought into view.
 */
@Composable
private fun AuthorizationRequestHeader(
    clientName: String,
    deadline: String,
    expired: Boolean,
    steps: List<AccessAuthorizationStep>,
    step: AccessAuthorizationStep,
    onStepChange: (AccessAuthorizationStep) -> Unit,
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .padding(bottom = OmSpacing.sm),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            // The name is whatever the client called itself, so it is labelled
            // as self-reported rather than presented as an identity Omnesis
            // verified.
            Text(
                "Client name, self-reported",
                color = c.textMuted,
                style = MaterialTheme.typography.labelSmall,
            )
            Text(
                clientName,
                color = c.textPrimary,
                style = MaterialTheme.typography.titleSmall,
            )
            Text(
                deadline,
                color = if (expired) c.warning else c.textMuted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        StepIndicator(steps = steps, current = step, onSelect = onStepChange)
    }
}

private fun previousStep(
    step: AccessAuthorizationStep,
    form: AccessAuthorizationForm,
    requiresAnswer: Boolean,
): AccessAuthorizationStep? {
    val steps = authorizationSteps(form, requiresAnswer)
    val index = steps.indexOf(step)
    return if (index > 0) steps[index - 1] else null
}

/**
 * How much of each step's chip there is room to draw.
 *
 * The iOS counterpart expresses this with `ViewThatFits`; Compose has no such
 * primitive, so the row is measured against the width it was given and the
 * densest legible option is chosen.
 */
private enum class StepDensity { FULL, SHORT, CURRENT_ONLY, NUMBERS }

@Composable
private fun StepIndicator(
    steps: List<AccessAuthorizationStep>,
    current: AccessAuthorizationStep,
    onSelect: (AccessAuthorizationStep) -> Unit,
) {
    val layoutDensity = LocalDensity.current
    val compact = layoutDensity.fontScale > 1.3f
    val currentIndex = steps.indexOf(current).coerceAtLeast(0)
    val measurer = rememberTextMeasurer()
    val labelStyle = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp)

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val available = maxWidth
        // The deadline above this row ticks every second; the ladder depends on
        // none of that, so it is measured once per set of inputs.
        val stepDensity = remember(steps, current, available, layoutDensity, labelStyle, compact) {
            if (compact) {
                StepDensity.NUMBERS
            } else {
                listOf(StepDensity.FULL, StepDensity.SHORT, StepDensity.CURRENT_ONLY)
                    .firstOrNull { candidate ->
                        rowWidth(steps, current, candidate, measurer, labelStyle, layoutDensity) <=
                            available
                    }
                    ?: StepDensity.NUMBERS
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(CHIP_GAP)) {
            steps.forEachIndexed { index, item ->
                StepChip(
                    index = index,
                    item = item,
                    isCurrent = item == current,
                    isComplete = index < currentIndex,
                    density = stepDensity,
                    onSelect = onSelect,
                )
            }
        }
    }
}

private val CHIP_GAP = 5.dp
private val CHIP_PADDING_LABELLED = 7.dp
private val CHIP_PADDING_BARE = 5.dp
private val CHIP_INNER_GAP = 5.dp

/** Room for a font fallback measuring wider than the one measured against. */
private val CHIP_SLACK = 8.dp

/** The digit inside the marker, and the marker's diameter as a multiple of it. */
private val MARKER_TEXT_SIZE = 9.sp
private const val MARKER_SCALE = 1.78f

/** Whether this density draws the given step's name. */
private fun StepDensity.showsTitle(isCurrent: Boolean): Boolean = when (this) {
    StepDensity.FULL, StepDensity.SHORT -> true
    StepDensity.CURRENT_ONLY -> isCurrent
    StepDensity.NUMBERS -> false
}

private fun AccessAuthorizationStep.label(density: StepDensity): String =
    if (density == StepDensity.FULL) title else shortTitle

/**
 * The width the whole row wants at this density, chips and gaps together.
 *
 * Deliberately not a composable: it is called a varying number of times while
 * searching for the densest option that fits, and a composable whose call count
 * changes between recompositions is exactly what Compose forbids. It reads no
 * state, so the measurer and the layout density are passed in instead.
 */
private fun rowWidth(
    steps: List<AccessAuthorizationStep>,
    current: AccessAuthorizationStep,
    stepDensity: StepDensity,
    measurer: TextMeasurer,
    style: TextStyle,
    layoutDensity: Density,
): Dp {
    val gaps = CHIP_GAP * (steps.size - 1).coerceAtLeast(0)
    val chips = steps.fold(0.dp) { total, step ->
        val isCurrent = step == current
        val showsTitle = stepDensity.showsTitle(isCurrent)
        val padding = if (showsTitle) CHIP_PADDING_LABELLED else CHIP_PADDING_BARE
        val text = if (showsTitle) {
            // The current chip is drawn heavier than the rest, and a weight the
            // measurement does not know about is a row that clips instead of
            // stepping down a rung.
            val drawn = style.copy(
                fontWeight = if (isCurrent) FontWeight.SemiBold else FontWeight.Normal,
            )
            with(layoutDensity) {
                measurer.measure(step.label(stepDensity), drawn).size.width.toDp()
            } + CHIP_INNER_GAP
        } else {
            0.dp
        }
        total + markerSize(layoutDensity) + text + padding * 2
    }
    return chips + gaps + CHIP_SLACK
}

/**
 * The marker grows with the reader's type size: at the densest rung it is all
 * that is left of the chip, and it is the target you tap to go back, so it must
 * not stay a 16dp dot beside 40sp text.
 */
private fun markerSize(layoutDensity: Density): Dp =
    with(layoutDensity) { (MARKER_TEXT_SIZE * MARKER_SCALE).toDp() }

@Composable
private fun StepChip(
    index: Int,
    item: AccessAuthorizationStep,
    isCurrent: Boolean,
    isComplete: Boolean,
    density: StepDensity,
    onSelect: (AccessAuthorizationStep) -> Unit,
) {
    val c = OmTheme.colors
    val showsTitle = density.showsTitle(isCurrent)
    val stateLabel = when {
        isComplete -> "Completed"
        isCurrent -> "Current step"
        else -> "Not started"
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(CHIP_INNER_GAP),
        modifier = Modifier
            // The chip is small by design; the target you press is not. Without
            // this the only way back is a 26dp dot, well under the 48dp minimum.
            .minimumInteractiveComponentSize()
            .clip(RoundedCornerShape(OmRadius.large))
            .background(if (isCurrent) c.bgSecondary else Color.Transparent)
            .clickable(enabled = isComplete) { onSelect(item) }
            .padding(
                horizontal = if (showsTitle) CHIP_PADDING_LABELLED else CHIP_PADDING_BARE,
                vertical = 5.dp,
            )
            .semantics {
                contentDescription = "${item.title}, $stateLabel"
                selected = isCurrent
            },
    ) {
        StepMarker(index = index, isCurrent = isCurrent, isComplete = isComplete)
        if (showsTitle) {
            Text(
                item.label(density),
                color = if (isCurrent) c.textPrimary else c.textSecondary,
                fontSize = 11.sp,
                fontWeight = if (isCurrent) FontWeight.SemiBold else FontWeight.Normal,
                maxLines = 1,
            )
        }
    }
}

/**
 * The numbered disk: filled on the step being worked on, a checked ring once it
 * is behind you, an outline while it is still ahead.
 */
@Composable
private fun StepMarker(index: Int, isCurrent: Boolean, isComplete: Boolean) {
    val c = OmTheme.colors
    val size = markerSize(LocalDensity.current)
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(size)
            .clip(CircleShape)
            .background(if (isCurrent) c.accent else Color.Transparent)
            .then(
                if (isCurrent) {
                    Modifier
                } else {
                    Modifier.border(1.dp, if (isComplete) c.success else c.border, CircleShape)
                },
            ),
    ) {
        if (isComplete) {
            Icon(
                Icons.Outlined.Check,
                contentDescription = null,
                tint = c.success,
                modifier = Modifier.size(size * 0.62f),
            )
        } else {
            Text(
                "${index + 1}",
                color = if (isCurrent) Color.White else c.textMuted,
                fontSize = MARKER_TEXT_SIZE,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

@Composable
private fun PermissionsStep(
    request: AccessAuthorizationRequest,
    form: AccessAuthorizationForm,
    update: (AccessAuthorizationForm) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        SectionTitle("What should this connection be allowed to do?")
        CapabilityCard(
            "Answer",
            "Ask questions using allowed sources. A privacy policy can review every answer before it is released.",
            form.answerEnabled || request.requiresAnswer,
            request.requiresAnswer,
        ) { update(form.copy(answerEnabled = it).relinkSources(it || request.requiresAnswer, form.directEnabled)) }
        if (request.requiresAnswer) {
            Text("Answer is required by this integration.", color = OmTheme.colors.textSecondary)
        }
        CapabilityCard(
            "Direct",
            "Search and read raw matching records.",
            form.directEnabled,
            false,
            warning = "Direct is not protected by a privacy policy.",
        ) {
            update(
                form.copy(directEnabled = it)
                    .relinkSources(form.answerEnabled || request.requiresAnswer, it),
            )
        }
        CapabilityCard(
            "Notes",
            "Save notes with Tell Omnesis. The agent’s name is recorded with each note. " +
                "This does not grant access to read existing notes.",
            form.notesEnabled,
            false,
        ) { update(form.copy(notesEnabled = it)) }
    }
}

@Composable
private fun DataAndPrivacyStep(
    overview: AccessOverview,
    request: AccessAuthorizationRequest,
    form: AccessAuthorizationForm,
    iconFor: (String) -> SourceIconModel,
    onShowPolicy: (String) -> Unit,
    update: (AccessAuthorizationForm) -> Unit,
) {
    val answerOn = form.answerEnabled || request.requiresAnswer
    val both = answerOn && form.directEnabled
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.lg)) {
        if (both) {
            RadioCard(
                "Allow the same sources for Answer and Direct",
                "One selection controls both capabilities.",
                form.linkedSources,
            ) { update(form.withLinkedSources(true, answerOn)) }
            RadioCard(
                "Allow different sources",
                "Direct may expose raw records, so a narrower boundary can be useful.",
                !form.linkedSources,
            ) { update(form.withLinkedSources(false, answerOn)) }
        }
        if (both && form.linkedSources) {
            SourceRuleEditor(
                "Sources available to Answer and Direct",
                AccessSourceScope.SHARED,
                overview.sources,
                form.answerSources,
                iconFor,
            ) { update(form.copy(answerSources = it)) }
        } else {
            if (answerOn) {
                SourceRuleEditor(
                    "Answer sources",
                    AccessSourceScope.ANSWER,
                    overview.sources,
                    form.answerSources,
                    iconFor,
                ) { update(form.copy(answerSources = it)) }
            }
            if (form.directEnabled) {
                HorizontalDivider(color = OmTheme.colors.border)
                SourceRuleEditor(
                    "Direct sources",
                    AccessSourceScope.DIRECT,
                    overview.sources,
                    form.directBoundary(answerOn),
                    iconFor,
                ) { update(form.copy(directSources = it)) }
            }
        }
        if (answerOn) {
            HorizontalDivider(color = OmTheme.colors.border)
            SectionTitle("Privacy for Answer")
            RadioCard(
                "Review answers with a privacy policy",
                null,
                form.answerRelease == AccessAnswerReleaseChoice.REVIEWED,
            ) { update(form.copy(answerRelease = AccessAnswerReleaseChoice.REVIEWED)) }
            if (form.answerRelease == AccessAnswerReleaseChoice.REVIEWED) {
                if (overview.policyFamilies.isEmpty()) {
                    WarningCard("No published privacy policy is available. Omnesis will fail closed.")
                } else {
                    overview.policyFamilies.forEach { policy ->
                        RadioRow(policy.name, "Revision ${policy.revision}", form.policyFamilyId == policy.id) {
                            update(form.copy(policyFamilyId = policy.id))
                        }
                    }
                    if (form.policyFamilyId.isBlank()) {
                        FieldError("Choose a privacy policy for Answer, or release answers automatically.")
                    }
                    form.policyFamilyId.takeIf { it.isNotBlank() }?.let { familyId ->
                        TextButton(
                            onClick = { onShowPolicy(familyId) },
                            contentPadding = PaddingValues(
                                horizontal = 0.dp,
                                vertical = OmSpacing.xs,
                            ),
                        ) {
                            Text("Read this policy")
                        }
                    }
                }
            }
            RadioCard(
                "Release answers automatically",
                "High risk: source boundaries and audit still apply, but no reviewer checks the answer.",
                form.answerRelease == AccessAnswerReleaseChoice.UNREVIEWED,
                warning = true,
            ) { update(form.copy(answerRelease = AccessAnswerReleaseChoice.UNREVIEWED)) }
        }
    }
}
