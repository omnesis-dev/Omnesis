// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.CalendarToday
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Flag
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisDarkColors
import dev.omnesis.android.transport.dto.TaskCountsDto
import dev.omnesis.android.transport.dto.TaskDocumentDto
import dev.omnesis.android.transport.dto.TaskDto
import dev.omnesis.android.ui.capture.CaptureScreen
import dev.omnesis.android.ui.capture.CaptureViewModel
import dev.omnesis.android.ui.capture.TaskCompletionCapture
import dev.omnesis.android.ui.capture.TaskNoteKind
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.PullToRefresh
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.delay

/** How long a receipt stays up before it goes on its own. */
private const val RECEIPT_MILLIS = 5_000L

/**
 * Tasks — the user's bullet journal, kept by the gateway. A tap on a task's circle completes it
 * (or reopens a resolved one) with Undo; a tap on its text opens its details; a long press
 * anywhere on the row opens its action fan, which the same touch slides over and lifts on. There
 * are no swipe actions: a sideways drag belongs to the menu reveal. A task lists the documents it
 * refers to under its title, each opening the document.
 *
 * [experimental] is the gateway's experimental mode. The Brain's suggestions and proposed
 * changes exist only there, so without it the screen offers no Suggested segment and no
 * Confirm / Keep, and a selected Suggested segment falls back to Today.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(
    onOpenMenu: () -> Unit,
    onOpenSettings: () -> Unit = {},
    onOpenDocument: (String) -> Unit = {},
    onTellOmnesis: () -> Unit = {},
    experimental: Boolean = false,
    vm: TasksViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(experimental, state.segment) {
        if (state.segment !in TaskSegment.visible(experimental)) vm.select(TaskSegment.TODAY)
    }
    TasksFrame(onOpenMenu = onOpenMenu) {
        TasksContent(
            state = state,
            experimental = experimental,
            today = remember(state.day) { LocalDate.parse(state.day) },
            actions = taskRowActions(vm, onOpenDocument),
            iconFor = vm::iconFor,
            onSelect = vm::select,
            onRefresh = { vm.load(quietly = true) },
            onRetry = { vm.load() },
            onOpenSettings = onOpenSettings,
            onTellOmnesis = onTellOmnesis,
            onUndo = vm::undo,
            onReceiptExpired = vm::dismissReceipt,
        )
    }

    state.editing?.let { task ->
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = vm::closeEditor,
            sheetState = sheet,
            containerColor = OmTheme.colors.bgPrimary,
        ) {
            TaskEditorContent(
                initial = remember(task) { TaskEditorDraft.from(task, vm.localDay) },
                onCancel = vm::closeEditor,
                onSave = { draft ->
                    val edit = draft.toEdit(task)
                    if (edit == null) vm.closeEditor() else vm.saveEdit(task, edit)
                },
                onHistory = { vm.openHistory(task) },
                documents = task.documents,
                iconFor = vm::iconFor,
                onOpenDocument = { document ->
                    vm.closeEditor()
                    onOpenDocument(document.id)
                },
            )
        }
    }

    state.history?.let { history ->
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = vm::closeHistory,
            sheetState = sheet,
            containerColor = OmTheme.colors.bgPrimary,
        ) {
            TaskHistoryContent(history, onUndo = { vm.undoFromHistory(history) })
        }
    }

    state.noting?.let { task ->
        TaskNoteCapture(task = task, onClose = vm::closeNote, onSave = { note -> vm.saveNote(task, note) })
    }

    state.actionError?.let { message ->
        AlertDialog(
            onDismissRequest = vm::clearActionError,
            title = { Text("Couldn't update the task") },
            text = { Text(message) },
            confirmButton = { TextButton(onClick = vm::clearActionError) { Text("OK") } },
        )
    }
}

/**
 * "Done + note" and a suggestion's "Accept with note": the Tell Omnesis capture, listening as
 * soon as it opens and ready for typing, completing [task] with what was said — or, for a
 * suggestion, accepting it with the note for Omnesis to apply — instead of saving a note on its
 * own. The capture stays open with its words when the gateway refuses, so nothing said is lost.
 */
@Composable
private fun TaskNoteCapture(task: TaskDto, onClose: () -> Unit, onSave: suspend (String) -> String?) {
    val capture: CaptureViewModel = hiltViewModel(key = TASK_NOTE_CAPTURE_KEY)
    Dialog(
        onDismissRequest = onClose,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)) {
            CaptureScreen(
                onClose = onClose,
                vm = capture,
                completion = remember(task.id) {
                    TaskCompletionCapture(
                        subject = task.title,
                        kind = if (task.isSuggestion) TaskNoteKind.ACCEPT else TaskNoteKind.COMPLETE,
                        save = onSave,
                    )
                },
            )
        }
    }
}

/** One capture view model serves every task note; each opening starts it afresh. */
private const val TASK_NOTE_CAPTURE_KEY = "tasks.done-with-note"

/** The screen's chrome: the title bar with the menu button, over the journal. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksFrame(onOpenMenu: () -> Unit, content: @Composable () -> Unit) {
    Scaffold(
        containerColor = OmTheme.colors.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Tasks", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Outlined.Menu, contentDescription = "Menu", tint = OmTheme.colors.accent)
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding)) { content() }
    }
}

/** Every row action, sent to [vm]. */
internal fun taskRowActions(vm: TasksViewModel, onOpenDocument: (String) -> Unit) = TaskRowActions(
    onTapBullet = vm::tapBullet,
    onOpen = vm::openDetails,
    onFanAction = vm::perform,
    onConfirm = vm::confirmProposal,
    onKeep = vm::keepAsIs,
    onOpenDocument = { onOpenDocument(it.id) },
)

/** What a task row can ask for. One bundle so the stateless content stays readable. */
data class TaskRowActions(
    val onTapBullet: (TaskDto) -> Unit = {},
    /** Opens the task's details. */
    val onOpen: (TaskDto) -> Unit = {},
    val onFanAction: (TaskDto, TaskFanAction) -> Unit = { _, _ -> },
    val onConfirm: (TaskDto) -> Unit = {},
    val onKeep: (TaskDto) -> Unit = {},
    val onOpenDocument: (TaskDocumentDto) -> Unit = {},
)

/** A fan to open as soon as the rows are laid out — screenshots. */
data class TaskFanPreview(
    val taskId: String,
    /** Where across the row the finger pressed, as a fraction of its width. */
    val pressedAt: Float = 0.7f,
    val mode: TaskFanSession.Mode = TaskFanSession.Mode.Main,
    /** The target the finger has slid onto; null leaves it on the press point. */
    val highlight: TaskFanAction? = null,
)

/**
 * Renders the journal without fetching anything, so screenshots and interaction tests drive
 * every state directly. [experimental] reveals the Brain's surfaces: the Suggested segment,
 * Today's banner pointing to it, and the Confirm / Keep line of a proposed change. Tasks are
 * added by telling Omnesis, so the views a person fills end with the way there
 * ([onTellOmnesis]) rather than a field of their own.
 */
@Composable
fun TasksContent(
    state: TasksUiState,
    today: LocalDate,
    experimental: Boolean = false,
    actions: TaskRowActions = TaskRowActions(),
    iconFor: (String) -> SourceIconModel = { SourceIconModel() },
    onSelect: (TaskSegment) -> Unit = {},
    onRefresh: () -> Unit = {},
    onRetry: () -> Unit = {},
    onOpenSettings: () -> Unit = {},
    onTellOmnesis: () -> Unit = {},
    onUndo: (TaskReceipt) -> Unit = {},
    onReceiptExpired: (TaskReceipt) -> Unit = {},
    initialFan: TaskFanPreview? = null,
) {
    val fan = rememberTaskFanController()
    fan.perform = actions.onFanAction
    // A fan belongs to the list it opened over.
    LaunchedEffect(state.segment) { fan.dismiss() }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            SegmentStrip(
                segments = TaskSegment.visible(experimental),
                selected = state.segment,
                counts = state.counts,
                onSelect = onSelect,
            )
            HorizontalDivider(thickness = Dp.Hairline, color = OmTheme.colors.borderLight)
            FanSpace(fan, Modifier.fillMaxWidth().weight(1f)) {
                when {
                    state.loading && state.tasks.isEmpty() -> LoadingView()
                    state.loadError != null && state.tasks.isEmpty() -> GatewayErrorView(
                        context = "load tasks",
                        error = state.loadError,
                        onRetry = onRetry,
                        onOpenSettings = onOpenSettings,
                    )
                    else -> PullToRefresh(refreshing = state.refreshing, onRefresh = onRefresh, enabled = !fan.isOpen) {
                        TaskList(
                            state = state,
                            today = today,
                            experimental = experimental,
                            actions = actions,
                            fan = fan,
                            iconFor = iconFor,
                            onTellOmnesis = onTellOmnesis,
                            onOpenSuggested = { onSelect(TaskSegment.SUGGESTED) },
                        )
                    }
                }
            }
        }
        state.receipt?.let { receipt ->
            ReceiptBar(
                receipt = receipt,
                onUndo = { onUndo(receipt) },
                onExpired = { onReceiptExpired(receipt) },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(OmSpacing.lg),
            )
        }
    }
    if (initialFan != null) {
        LaunchedEffect(initialFan) {
            // After the rows have been laid out and measured against the overlay.
            withFrameNanos { }
            withFrameNanos { }
            val task = state.tasks.firstOrNull { it.id == initialFan.taskId } ?: return@LaunchedEffect
            val row = fan.frameOf(task.id) ?: return@LaunchedEffect
            val press = Offset(row.left + row.width * initialFan.pressedAt, row.top + fan.metrics.targetHeight * 0.55f)
            fan.open(task, press, today, initialFan.mode)
            val target = initialFan.highlight?.let { action -> fan.session?.targets?.firstOrNull { it.action == action } }
            if (target != null) fan.move(target.center, nowMillis = 0)
        }
    }
}

/**
 * The box the list and its fan share: it measures where targets may go and sizes the fan to
 * the screen, and the fan draws over the list inside it.
 */
@Composable
private fun FanSpace(fan: TaskFanController, modifier: Modifier, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    Box(
        modifier.onGloballyPositioned { coordinates ->
            fan.overlay = coordinates
            val size = coordinates.size
            fan.bounds = Rect(0f, 0f, size.width.toFloat(), size.height.toFloat())
            val base = TaskFanSession.Metrics().scaled(density.density)
            val inset = with(density) { TASK_TEXT_INSET.toPx() }
            val narrowest = with(density) { 140.dp.toPx() }
            fan.metrics = base.copy(
                targetWidth = base.targetWidth.coerceAtMost((size.width - base.lead - 2 * inset).coerceAtLeast(narrowest)),
            )
        },
    ) {
        content()
        TaskFanOverlay(fan)
    }
}

/** Where a title starts: the bullet's column. */
private val TASK_TEXT_INSET = 56.dp

@Composable
private fun TaskList(
    state: TasksUiState,
    today: LocalDate,
    experimental: Boolean,
    actions: TaskRowActions,
    fan: TaskFanController,
    iconFor: (String) -> SourceIconModel,
    onTellOmnesis: () -> Unit,
    onOpenSuggested: () -> Unit,
) {
    val listState = rememberLazyListState()
    val entries = state.entries
    // Room under the last row for the receipt bar, so it never covers a bullet.
    LazyColumn(
        Modifier.fillMaxSize().testTag("tasks.list"),
        state = listState,
        contentPadding = PaddingValues(bottom = RECEIPT_ROOM),
        userScrollEnabled = !fan.isOpen,
    ) {
        // The way to the Brain's suggestions comes first, so a long day never hides it.
        if (state.segment == TaskSegment.TODAY) {
            suggestionsBannerText(state.counts.suggested, experimental)?.let { text ->
                item(key = "suggestions") { SuggestionsBanner(text, onOpenSuggested) }
            }
        }
        TaskPageHeading.of(state.segment, today, state.tasks)?.let { heading ->
            item(key = "page-heading") { PageHeading(heading) }
        }
        if (state.segment == TaskSegment.SUGGESTED && entries.isNotEmpty()) {
            item(key = "suggested-hint") { SuggestedHint() }
        }
        if (entries.isEmpty()) {
            item(key = "empty") { EmptySegment(state.segment) }
        }
        items(entries, key = { it.key }, contentType = { it::class }) { entry ->
            when (entry) {
                is TaskJournalEntry.Heading -> SectionHeader(entry.title, entry.count)
                is TaskJournalEntry.Task -> Column {
                    TaskRow(
                        task = entry.task,
                        segment = state.segment,
                        today = today,
                        pending = entry.task.id in state.pending,
                        experimental = experimental,
                        fanOpen = fan.task?.id == entry.task.id,
                        fan = fan,
                        actions = actions,
                        iconFor = iconFor,
                    )
                    HorizontalDivider(
                        thickness = Dp.Hairline,
                        color = OmTheme.colors.borderLight,
                        modifier = Modifier.padding(start = TASK_TEXT_INSET),
                    )
                }
            }
        }
        if (showsCaptureHint(state.segment)) {
            item(key = "tell-omnesis") { TellOmnesisFooter(onTellOmnesis) }
        }
    }
}

/** The list's bottom padding: the receipt bar's height and its margin. */
private val RECEIPT_ROOM = 88.dp

/** The page's own heading, the way a journal page is headed by its date. */
data class TaskPageHeading(val title: String, val subtitle: String?) {
    companion object {
        private val LONG_DAY = DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.ENGLISH)
        private val LONG_MONTH = DateTimeFormatter.ofPattern("MMMM yyyy", Locale.ENGLISH)

        /** Today's long date with what is left and done; the month on Month; nothing elsewhere. */
        fun of(segment: TaskSegment, today: LocalDate, tasks: List<TaskDto>): TaskPageHeading? = when (segment) {
            TaskSegment.TODAY -> {
                val open = tasks.count { !it.isResolved }
                val done = tasks.count { it.isDone }
                val parts = listOfNotNull(
                    if (open == 1) "1 to do" else "$open to do",
                    if (done > 0) "$done done" else null,
                )
                TaskPageHeading(LONG_DAY.format(today), parts.joinToString(" · "))
            }
            TaskSegment.MONTH -> TaskPageHeading(LONG_MONTH.format(YearMonth.from(today)), null)
            else -> null
        }
    }
}

@Composable
private fun PageHeading(heading: TaskPageHeading) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = OmSpacing.lg, end = OmSpacing.lg, top = OmSpacing.lg, bottom = OmSpacing.sm),
    ) {
        Text(
            heading.title,
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            color = OmTheme.colors.textPrimary,
            modifier = Modifier.semantics { heading() },
        )
        heading.subtitle?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = OmTheme.colors.textSecondary)
        }
    }
}

@Composable
private fun SegmentStrip(
    segments: List<TaskSegment>,
    selected: TaskSegment,
    counts: TaskCountsDto,
    onSelect: (TaskSegment) -> Unit,
) {
    // The segments do not fit a phone's width, so the strip scrolls and keeps the selected
    // one in view — a segment chosen from elsewhere (the suggestions banner) must not be off-screen.
    val selectedIndex = segments.indexOf(selected).coerceAtLeast(0)
    val listState = rememberLazyListState(initialFirstVisibleItemIndex = selectedIndex)
    val inspecting = LocalInspectionMode.current
    LaunchedEffect(selectedIndex) {
        if (inspecting) listState.scrollToItem(selectedIndex) else listState.animateScrollToItem(selectedIndex)
    }
    LazyRow(
        state = listState,
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = OmSpacing.lg, vertical = OmSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        items(segments, key = { it.name }) { segment ->
            SegmentChip(
                label = segment.tabLabel(counts),
                spoken = segment.spokenLabel(counts),
                selected = segment == selected,
                badge = if (segment == TaskSegment.SUGGESTED) counts.suggested else 0,
                onClick = { onSelect(segment) },
            )
        }
    }
}

/** "Today, 4 open" rather than the chip's "Today (4)", which TalkBack would read with its brackets. */
internal fun TaskSegment.spokenLabel(counts: TaskCountsDto): String {
    if (this == TaskSegment.SUGGESTED && counts.suggested > 0) return "$label, ${counts.suggested} waiting"
    val open = count(counts)
    return if (open > 0) "$label, $open open" else label
}

/** How a suggestion is answered, above the Suggested list: its row looks like any task's. */
@Composable
private fun SuggestedHint() {
    Text(
        "Tap the circle if it is already done. Press and hold to accept, add a note, plan it or ignore it.",
        style = MaterialTheme.typography.bodySmall,
        color = OmTheme.colors.textSecondary,
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = OmSpacing.lg, end = OmSpacing.lg, top = OmSpacing.md, bottom = OmSpacing.xs)
            .testTag("tasks.suggestedHint"),
    )
}

/**
 * Today's pointer to the Suggested segment, at the top of the page. It wears the same card as the main screen's
 * access-request banner, the app's one way of saying "something here waits for your decision".
 */
@Composable
private fun SuggestionsBanner(text: String, onOpen: () -> Unit) {
    val c = OmTheme.colors
    OmnesisCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = OmSpacing.lg, end = OmSpacing.lg, top = OmSpacing.lg)
            .clickable(onClickLabel = "Review suggestions", role = Role.Button, onClick = onOpen)
            .testTag("tasks.reviewBanner"),
        padding = OmSpacing.md,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            Icon(Icons.Outlined.AutoAwesome, contentDescription = null, tint = c.accent)
            Text(
                text,
                fontWeight = FontWeight.SemiBold,
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
            )
            Text("Review", fontWeight = FontWeight.SemiBold, color = c.accent)
        }
    }
}

/** How tasks get here: "Use Tell Omnesis to add tasks.", with Tell Omnesis opening capture. */
@Composable
private fun TellOmnesisFooter(onTellOmnesis: () -> Unit) {
    val c = OmTheme.colors
    val text = remember(c.accent, onTellOmnesis) {
        buildAnnotatedString {
            append("Use ")
            withLink(
                LinkAnnotation.Clickable(
                    tag = "tell-omnesis",
                    styles = TextLinkStyles(SpanStyle(color = c.accent, fontWeight = FontWeight.SemiBold)),
                ) { onTellOmnesis() },
            ) { append("Tell Omnesis") }
            append(" to add tasks.")
        }
    }
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = c.textSecondary,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.lg, vertical = OmSpacing.lg)
            .testTag("tasks.captureHint"),
    )
}

@Composable
private fun SegmentChip(label: String, spoken: String, selected: Boolean, badge: Int, onClick: () -> Unit) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(50)
    Row(
        Modifier
            .clip(shape)
            .background(if (selected) c.accent.copy(alpha = if (c.isDark) 0.18f else 0.12f) else Color.Transparent)
            .border(1.dp, if (selected) c.accent.copy(alpha = 0.5f) else c.border, shape)
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 7.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = spoken
                if (selected) stateDescription = "Selected"
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            color = if (selected) c.accent else c.textSecondary,
        )
        if (badge > 0) {
            Spacer(Modifier.width(6.dp))
            Text(
                if (badge > 99) "99+" else badge.toString(),
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (c.isDark) c.bgPrimary else Color.White,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(c.accent)
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
    }
}

@Composable
private fun SectionHeader(title: String, count: Int) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = OmSpacing.lg, end = OmSpacing.lg, top = OmSpacing.lg, bottom = OmSpacing.xs)
            .semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title.uppercase(),
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
            color = OmTheme.colors.textSecondary,
        )
        Spacer(Modifier.width(OmSpacing.sm))
        Text(count.toString(), fontSize = 11.sp, color = OmTheme.colors.textMuted)
    }
}

/**
 * One task as a bullet-journal line: the circle, the title with its description and a line of
 * context, then the documents it refers to and — when Omnesis has an opinion — a proposal to
 * confirm or keep, or a suggestion to accept.
 *
 * The circle completes the task (or reopens a resolved one); the text opens its details. A long
 * press anywhere on one of the user's own open tasks opens its action fan, and TalkBack reaches
 * every fan action from the row as a custom action.
 */
@Composable
private fun TaskRow(
    task: TaskDto,
    segment: TaskSegment,
    today: LocalDate,
    pending: Boolean,
    experimental: Boolean,
    fanOpen: Boolean,
    fan: TaskFanController,
    actions: TaskRowActions,
    iconFor: (String) -> SourceIconModel,
) {
    val c = OmTheme.colors
    val suggestion = task.isSuggestion
    val fanned = hasActionFan(task)
    DisposableEffect(task.id) { onDispose { fan.unregisterRow(task.id) } }
    Column(
        Modifier
            .fillMaxWidth()
            .background(if (fanOpen) c.bgSecondary else Color.Transparent)
            .onGloballyPositioned { fan.registerRow(task.id, it) }
            .then(if (fanned && !pending) Modifier.taskFanPress(task, fan, today) else Modifier)
            .semantics {
                customActions = when {
                    fanned && suggestion -> listOf(
                        CustomAccessibilityAction("Accept") { actions.onFanAction(task, TaskFanAction.Accept); true },
                        CustomAccessibilityAction("Accept with note") {
                            actions.onFanAction(task, TaskFanAction.AcceptWithNote); true
                        },
                        CustomAccessibilityAction("Accept for…") {
                            fan.openForAccessibility(task, today, TaskFanSession.Mode.When); true
                        },
                        CustomAccessibilityAction("Mark as done") { actions.onFanAction(task, TaskFanAction.Done); true },
                        CustomAccessibilityAction("Ignore") { actions.onFanAction(task, TaskFanAction.Ignore); true },
                    )
                    fanned -> listOf(
                        CustomAccessibilityAction("Done") { actions.onFanAction(task, TaskFanAction.Done); true },
                        CustomAccessibilityAction("Done with note") {
                            actions.onFanAction(task, TaskFanAction.DoneWithNote); true
                        },
                        CustomAccessibilityAction("Tomorrow") { actions.onFanAction(task, TaskFanAction.Tomorrow); true },
                        CustomAccessibilityAction("Next month") { actions.onFanAction(task, TaskFanAction.NextMonth); true },
                        CustomAccessibilityAction("Move to month…") {
                            fan.openForAccessibility(task, today, TaskFanSession.Mode.Months(0)); true
                        },
                        CustomAccessibilityAction("Cancel task") { actions.onFanAction(task, TaskFanAction.CancelTask); true },
                    )
                    task.isResolved -> listOf(CustomAccessibilityAction("Reopen") { actions.onTapBullet(task); true })
                    else -> emptyList()
                }
            }
            .testTag("tasks.row.${task.id}"),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(end = OmSpacing.lg, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.Top,
        ) {
            TaskBullet(task, enabled = !pending, onTap = { actions.onTapBullet(task) })
            Column(
                Modifier
                    .weight(1f)
                    .clickable(onClickLabel = "Open details", role = Role.Button) { actions.onOpen(task) }
                    .semantics {
                        stateDescription = when {
                            task.isDone -> "Done"
                            task.isStruck -> "Struck"
                            suggestion -> "Suggested"
                            else -> ""
                        }
                    }
                    .padding(top = 10.dp, bottom = 4.dp)
                    .testTag("tasks.text.${task.id}"),
            ) {
                Text(
                    task.title,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (task.isResolved) c.textMuted else c.textPrimary,
                    textDecoration = if (task.isResolved) TextDecoration.LineThrough else null,
                )
                task.description?.takeIf(String::isNotBlank)?.let { description ->
                    Spacer(Modifier.height(2.dp))
                    Text(
                        description,
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.textSecondary,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                val meta = taskMeta(task, segment, today)
                val carried = task.carried && !task.isResolved
                if (meta.isNotEmpty() || carried) {
                    Spacer(Modifier.height(3.dp))
                    MetaLine(carried, meta)
                }
                task.completionNote?.takeIf { task.isDone && it.isNotBlank() }?.let { note ->
                    Spacer(Modifier.height(2.dp))
                    Text(
                        note,
                        style = MaterialTheme.typography.bodySmall,
                        fontStyle = FontStyle.Italic,
                        color = c.textSecondary,
                    )
                }
            }
            if (pending) {
                OmSpinner(
                    Modifier.padding(top = 12.dp).size(16.dp),
                    color = c.textMuted,
                    strokeWidth = 2.dp,
                )
            }
        }
        Column(Modifier.padding(start = TASK_TEXT_INSET, end = OmSpacing.lg)) {
            TaskDocuments(task.documents, iconFor) { actions.onOpenDocument(it) }
        }
        task.proposedChange?.takeIf { experimental && !task.isResolved }?.let { proposal ->
            ProposalLine(
                kind = proposal.kind,
                reason = proposal.reason,
                enabled = !pending,
                onConfirm = { actions.onConfirm(task) },
                onKeep = { actions.onKeep(task) },
            )
        }
    }
}

/**
 * The circle: an open task's circle completes it, a done task shows a green check and a struck
 * one its dash, either of which reopens it. A suggestion's circle, drawn in the accent, marks it
 * done directly — it was done before the user saw it.
 */
@Composable
private fun TaskBullet(task: TaskDto, enabled: Boolean, onTap: () -> Unit) {
    val c = OmTheme.colors
    val label = when {
        task.isSuggestion -> "Mark ${task.title} as done"
        task.isResolved -> "Reopen ${task.title}"
        else -> "Complete ${task.title}"
    }
    Box(
        Modifier
            .padding(start = 6.dp)
            .size(44.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Checkbox, onClickLabel = label, onClick = onTap)
            .semantics {
                contentDescription = label
                stateDescription = when {
                    task.isDone -> "Done"
                    task.isStruck -> "Struck"
                    else -> "Open"
                }
            }
            .testTag("tasks.circle.${task.id}"),
        contentAlignment = Alignment.Center,
    ) {
        when {
            task.isSuggestion -> Box(
                Modifier.size(22.dp).border(1.5.dp, c.accent, CircleShape).testTag("tasks.open.${task.id}"),
            )
            task.isDone -> Box(
                Modifier.size(22.dp).clip(CircleShape).background(c.success).testTag("tasks.done.${task.id}"),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Outlined.Check,
                    contentDescription = null,
                    tint = if (c.isDark) c.bgPrimary else Color.White,
                    modifier = Modifier.size(15.dp),
                )
            }
            task.isStruck -> Box(
                Modifier.size(22.dp).border(1.5.dp, c.textMuted, CircleShape).testTag("tasks.struck.${task.id}"),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Outlined.Remove, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(15.dp))
            }
            else -> Box(
                Modifier
                    .size(22.dp)
                    .border(1.5.dp, if (task.carried) c.warning else c.textSecondary, CircleShape)
                    .testTag("tasks.open.${task.id}"),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MetaLine(carried: Boolean, meta: List<TaskMetaItem>) {
    val c = OmTheme.colors
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (carried) {
            Text(
                "CARRIED",
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.5.sp,
                color = c.warning,
                modifier = Modifier
                    .align(Alignment.CenterVertically)
                    .clip(RoundedCornerShape(OmRadius.pill))
                    .background(c.warning.copy(alpha = 0.14f))
                    .padding(horizontal = 6.dp, vertical = 1.dp),
            )
        }
        meta.forEach { item ->
            val tint = if (item.overdue) c.danger else c.textSecondary
            Row(Modifier.align(Alignment.CenterVertically), verticalAlignment = Alignment.CenterVertically) {
                Icon(item.icon.vector, contentDescription = null, tint = tint, modifier = Modifier.size(13.dp))
                Spacer(Modifier.width(3.dp))
                Text(item.text, style = MaterialTheme.typography.bodySmall, color = tint)
            }
        }
    }
}

/** What a meta item is about, shown as its leading icon. */
enum class TaskMetaIcon(val vector: ImageVector) {
    /** When the task is planned for. */
    PLANNED(Icons.Outlined.CalendarToday),

    /** When it is due. */
    DUE(Icons.Outlined.Flag),

    /** Who else it waits on. */
    PEOPLE(Icons.Outlined.Person),

    /** The task it comes after. */
    BLOCKED(Icons.Outlined.HourglassEmpty),
}

/** One short fact under a task's title. [overdue] marks a deadline that has passed. */
data class TaskMetaItem(val icon: TaskMetaIcon, val text: String, val overdue: Boolean = false)

/**
 * The short facts under a title: when it is planned, when it is due, and who or what it waits
 * on. A resolved task's deadline no longer matters, so it is left out.
 */
internal fun taskMeta(task: TaskDto, segment: TaskSegment, today: LocalDate): List<TaskMetaItem> = buildList {
    val planned = TaskDates.describe(task.scheduledFor, today)
    // Today's own rows need no "Today"; every other view says when.
    if (planned != null && !(segment == TaskSegment.TODAY && planned == "Today")) {
        add(TaskMetaItem(TaskMetaIcon.PLANNED, if (task.carried) "Planned ${inlinePhrase(planned)}" else planned))
    }
    if (!task.isResolved) {
        TaskDates.describe(task.dueDay, today)?.let {
            val overdue = task.dueDay?.let { day -> day.length == 10 && day < today.toString() } == true
            add(TaskMetaItem(TaskMetaIcon.DUE, "Due ${inlinePhrase(it)}", overdue))
        }
    }
    val others = task.actors.filterNot { it.isSelf }.mapNotNull { it.name?.takeIf(String::isNotBlank) }
    if (others.isNotEmpty() && task.actors.none { it.isSelf }) {
        add(TaskMetaItem(TaskMetaIcon.PEOPLE, "Waiting on ${others.joinToString(", ")}"))
    }
    task.blockedBy.firstOrNull()?.let { add(TaskMetaItem(TaskMetaIcon.BLOCKED, "After “${it.title}”")) }
}

private val RELATIVE_PHRASES = setOf("Today", "Tomorrow", "Yesterday", "This month", "Someday")

/** A relative phrase reads lower-case mid-sentence ("Due tomorrow"); a date keeps its capitals. */
private fun inlinePhrase(phrase: String): String = if (phrase in RELATIVE_PHRASES) phrase.lowercase() else phrase

@Composable
private fun ProposalLine(
    kind: String,
    reason: String,
    enabled: Boolean,
    onConfirm: () -> Unit,
    onKeep: () -> Unit,
) {
    val c = OmTheme.colors
    val lead = when (kind) {
        "complete" -> "Omnesis thinks this is done"
        "strike" -> "Omnesis thinks this no longer applies"
        else -> "Omnesis suggests a change"
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(start = TASK_TEXT_INSET, end = OmSpacing.lg, bottom = OmSpacing.sm)
            .clip(RoundedCornerShape(OmRadius.large))
            .background(c.accent.copy(alpha = if (c.isDark) 0.10f else 0.07f))
            .border(1.dp, c.accent.copy(alpha = 0.25f), RoundedCornerShape(OmRadius.large))
            .padding(start = OmSpacing.md, end = OmSpacing.xs, top = OmSpacing.sm),
    ) {
        Row(verticalAlignment = Alignment.Top) {
            Icon(
                Icons.Outlined.AutoAwesome,
                contentDescription = null,
                tint = c.accent,
                modifier = Modifier.padding(top = 2.dp).size(14.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                if (reason.isBlank()) lead else "$lead: $reason",
                style = MaterialTheme.typography.bodySmall,
                color = c.textPrimary,
                modifier = Modifier.weight(1f).padding(end = OmSpacing.sm),
            )
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = onKeep, enabled = enabled) { Text("Keep", color = c.textSecondary) }
            TextButton(onClick = onConfirm, enabled = enabled) { Text("Confirm", fontWeight = FontWeight.SemiBold) }
        }
    }
}

@Composable
private fun EmptySegment(segment: TaskSegment) {
    val (title, body) = when (segment) {
        TaskSegment.TODAY -> "Nothing for today" to
            "Tasks planned for today, and those carried over, appear here."
        TaskSegment.MONTH -> "Nothing else this month" to
            "Tasks planned for later this month appear here."
        TaskSegment.FUTURE -> "Nothing planned further out" to
            "Tasks for later months, and someday, appear here."
        TaskSegment.ANYTIME -> "No unscheduled tasks" to
            "Tasks without a day or deadline appear here."
        TaskSegment.WAITING -> "Nothing waiting on others" to
            "Tasks that depend on someone else appear here."
        TaskSegment.SUGGESTED -> "No suggestions" to
            "When Omnesis spots something you may want to do, it appears here."
        TaskSegment.DONE -> "Nothing done yet" to
            "Completed and struck tasks appear here."
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = OmSpacing.xl, vertical = 56.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            if (segment == TaskSegment.SUGGESTED) Icons.Outlined.AutoAwesome else Icons.Outlined.CheckCircle,
            contentDescription = null,
            tint = OmTheme.colors.textMuted,
            modifier = Modifier.size(32.dp),
        )
        Spacer(Modifier.height(OmSpacing.md))
        Text(title, style = MaterialTheme.typography.titleMedium, color = OmTheme.colors.textPrimary)
        Spacer(Modifier.height(OmSpacing.xs))
        Text(
            body,
            style = MaterialTheme.typography.bodySmall,
            color = OmTheme.colors.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

/** The receipt toast: what just happened, with Undo while the gateway can still revert it. */
@Composable
private fun ReceiptBar(
    receipt: TaskReceipt,
    onUndo: () -> Unit,
    onExpired: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    // Frozen under inspection: a running timer never lets a screenshot settle.
    if (!LocalInspectionMode.current) {
        LaunchedEffect(receipt.id) {
            delay(RECEIPT_MILLIS)
            onExpired()
        }
    }
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.large))
            .background(if (c.isDark) c.bgTertiary else c.textPrimary)
            .padding(start = OmSpacing.lg, end = OmSpacing.xs, top = OmSpacing.xs, bottom = OmSpacing.xs)
            .testTag("tasks.receipt"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            receipt.text,
            style = MaterialTheme.typography.bodyMedium,
            color = if (c.isDark) c.textPrimary else c.bgPrimary,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f).padding(vertical = 10.dp),
        )
        if (receipt.undoSeq != null) {
            TextButton(onClick = onUndo) {
                Text(
                    "Undo",
                    fontWeight = FontWeight.SemiBold,
                    // The bar is dark in both themes, so Undo takes the dark palette's accent.
                    color = OmnesisDarkColors.accent,
                )
            }
        }
    }
}
