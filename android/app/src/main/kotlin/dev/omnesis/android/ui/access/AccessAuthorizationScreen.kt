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
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import dev.omnesis.android.transport.dto.AccessCapability
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
    val filterSession = vm.filterSession
    val filterNavigation = remember(filterSession) { SourceFilterNavigation() }
    val filterEdit = state.filterEdit
    val filterForm = state.form
    val filterOverview = state.overview
    if (filterEdit != null && filterSession != null && filterForm != null && filterOverview != null) {
        AccessLevelFilterEditor(filterForm.level, filterOverview, filterEdit.source.id, filterEdit.capability, filterSession, filterNavigation,
            vm::sourceIcon, vm::sourceName, onClose = vm::closeFilter, changed = vm::applyFilter)
    }
    LaunchedEffect(initialCode, initialRequestId, launchNonce, expectedPairing) {
        when {
            expectedPairing == null -> Unit
            initialRequestId != null -> vm.lookupInitialById(initialRequestId, launchNonce, expectedPairing)
            initialCode != null -> vm.lookupInitial(initialCode, launchNonce, expectedPairing)
        }
    }
    val navigateBack = {
        val form = state.form
        val request = state.request
        val overview = state.overview
        val previous = if (state.completion == null && form != null && request != null && overview != null) {
            val positions = authorizationPositions(form)
            positions.getOrNull(authorizationPositionIndex(positions, state.step, state.dataPage) - 1)
        } else {
            null
        }
        if (previous == null) onClose() else vm.goTo(previous.step, previous.dataPage)
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
        nameFor = vm::sourceName,
        onEditFilter = vm::editFilter,
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
    onStepChange: (AccessAuthorizationStep, AccessLevelPage?) -> Unit = { _, _ -> },
    onShowPolicy: (String) -> Unit = {},
    onEditFilter: (dev.omnesis.android.transport.dto.AccessSourceInstance, AccessCapability) -> Unit = { _, _ -> },
    onDismissPolicy: () -> Unit = {},
    iconFor: (String) -> SourceIconModel = { SourceIconModel(fallbackInitial = it.take(1).uppercase()) },
    /** The catalog's name for the source of an account id, where it has one. */
    nameFor: (String) -> String? = { null },
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
            AccessTopBar(
                title = when {
                    state.completion != null -> "Authorization"
                    state.request == null -> "Connect an agent"
                    else -> REVIEW_ACCESS_TITLE
                },
                leading = "Close",
                onLeading = onClose,
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
                dataPage = state.dataPage,
                form = requireNotNull(state.form),
                deciding = state.deciding,
                actionError = state.actionError,
                levelNameTaken = state.levelNameTaken,
                onDecide = onDecide,
                onFormChange = onFormChange,
                onStepChange = onStepChange,
                onShowPolicy = onShowPolicy,
                onEditFilter = onEditFilter,
                iconFor = iconFor,
                nameFor = nameFor,
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
 * The chosen policy's text, over the screen that asked for it rather than in place of it. The
 * approval and the level editor both hold a part-made decision, which a nav destination would
 * unwind.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AccessPolicySheet(preview: AccessPolicyPreview, onDismiss: () -> Unit) {
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
    dataPage: AccessLevelPage?,
    form: AccessAuthorizationForm,
    deciding: Boolean,
    actionError: String?,
    levelNameTaken: Boolean,
    onDecide: (Boolean, dev.omnesis.android.transport.dto.AccessAuthorizationSelection?) -> Unit,
    onFormChange: (AccessAuthorizationForm) -> Unit,
    onStepChange: (AccessAuthorizationStep, AccessLevelPage?) -> Unit,
    onShowPolicy: (String) -> Unit,
    onEditFilter: (dev.omnesis.android.transport.dto.AccessSourceInstance, AccessCapability) -> Unit,
    iconFor: (String) -> SourceIconModel,
    nameFor: (String) -> String?,
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
    val draft = form.level
    val steps = authorizationSteps(form)
    val positions = remember(form) { authorizationPositions(form) }
    val index = authorizationPositionIndex(positions, step, dataPage)
    val position = positions[index]
    Scaffold(
        modifier = modifier,
        containerColor = OmTheme.colors.bgPrimary,
        bottomBar = {
            WizardActions(
                first = index == 0,
                last = index == positions.lastIndex,
                canContinue = !expired && when (position.step) {
                    AccessAuthorizationStep.CONNECTION -> form.connection?.canContinue(request, overview, draft) == true
                    AccessAuthorizationStep.PERMISSIONS -> draft.pageError(AccessLevelPage.PERMISSIONS, overview) == null
                    // Each decision must hold before the next is asked; the last also needs the whole selection to.
                    AccessAuthorizationStep.DATA -> position.dataPage?.let { draft.pageError(it, overview) } == null &&
                        (positions.getOrNull(index + 1)?.step == AccessAuthorizationStep.DATA || selection != null)
                    AccessAuthorizationStep.REVIEW -> selection != null
                },
                deciding = deciding,
                note = position.dataPage?.let { draft.accountsNote(it, overview) },
                onBack = { positions[index - 1].let { onStepChange(it.step, it.dataPage) } },
                onContinue = { positions[index + 1].let { onStepChange(it.step, it.dataPage) } },
                onDeny = { onDecide(false, null) },
                onAllow = { onDecide(true, selection) },
            )
        },
    ) { padding ->
        val change: (AccessLevelDraft) -> Unit = { onFormChange(form.copy(level = it)) }
        LazyColumn(
            Modifier.fillMaxSize().padding(padding).padding(horizontal = AccessUi.Inset),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
        ) {
            item {
                AuthorizationRequestHeader(
                    clientName = request.clientName,
                    deadline = authorizationDeadlineText(request.expiresAt, nowMillis),
                    expired = expired,
                    steps = steps,
                    step = step,
                    onStepChange = { onStepChange(it, null) },
                )
            }
            actionError?.let { item { AccessNotice(it, error = true) } }
            if (form.filtersUnavailable(overview) && (step == AccessAuthorizationStep.DATA || step == AccessAuthorizationStep.REVIEW)) {
                item { AccessNotice(FILTERS_UNAVAILABLE_MESSAGE, error = true) }
            }
            when (position.step) {
                AccessAuthorizationStep.CONNECTION -> item {
                    ConnectionStep(request, overview, form, nowMillis, levelNameTaken, onFormChange)
                }
                AccessAuthorizationStep.PERMISSIONS -> item {
                    LevelStep(AccessLevelPage.PERMISSIONS) { AccessPermissionsQuestion(draft, overview, requiredAnswer = request.requiresAnswer, update = change) }
                }
                AccessAuthorizationStep.DATA -> item {
                    val page = position.dataPage ?: AccessLevelPage.ANSWER_DATA
                    LevelStep(page) {
                        when (page) {
                            AccessLevelPage.DIRECT_CHOICE -> AccessDirectQuestion(draft, overview, iconFor, nameFor, change, onEditFilter)
                            AccessLevelPage.FUTURE -> AccessFutureQuestion(draft, overview, change)
                            AccessLevelPage.RELEASE -> AccessReleaseQuestion(draft, overview, readPolicy = onShowPolicy, update = change)
                            else -> AccessDataQuestion(draft, overview, page.capability() ?: AccessCapability.ANSWER, iconFor, nameFor, change, onEditFilter)
                        }
                    }
                }
                AccessAuthorizationStep.REVIEW -> item {
                    ReviewStep(
                        request = request,
                        overview = overview,
                        form = form,
                        legacyConnectionName = reconnect?.principal?.name,
                        positions = positions,
                        change = { onStepChange(it.step, it.dataPage) },
                    )
                }
            }
            item { Spacer(Modifier.height(OmSpacing.xl)) }
            if (index == 0) {
                item {
                    AccessDetailText("Going back leaves this request pending until it expires. You can enter the code again.")
                }
            }
        }
    }
}

/**
 * One decision of a new access level inside the approval: the question the level editor asks on that
 * step, then the same content it shows there.
 */
@Composable
private fun LevelStep(page: AccessLevelPage, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = OmSpacing.sm)) {
        AccessQuestionHeader(page.question(creating = true), subtitle = page.subtitle)
        AccessGap(AccessUi.ContentGap)
        content()
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
