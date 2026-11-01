// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.AddTask
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DateRange
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.EventRepeat
import androidx.compose.material.icons.outlined.HourglassEmpty
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.KeyboardArrowUp
import androidx.compose.material.icons.outlined.Today
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material.icons.outlined.WbSunny
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.TaskDto
import java.time.LocalDate
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

/**
 * Drives one task's action fan on screen: it opens a [TaskFanSession] where a row was pressed,
 * feeds it the finger, wakes it when a resting finger has dwelt on a navigation target, and
 * hands the chosen action back. The rules — layout, hit-testing, dwell, release — live in the
 * session; this holds it as Compose state.
 *
 * Every position is in the overlay's coordinates: the box the list and the fan share.
 */
@Stable
class TaskFanController {
    var session: TaskFanSession? by mutableStateOf(null)
        private set
    var task: TaskDto? by mutableStateOf(null)
        private set

    /** Bumped on every change to the open session, which mutates in place. */
    var version by mutableIntStateOf(0)
        private set

    /** Bumped on each change of target, for the selection haptic. */
    var selectionTicks by mutableIntStateOf(0)
        private set

    /** Bumped each time a fan opens, for the opening haptic. */
    var openings by mutableIntStateOf(0)
        private set

    /** The overlay's own layout, which row positions are measured against. */
    var overlay: LayoutCoordinates? = null

    /** Where targets may go: the visible list. */
    var bounds: Rect = Rect.Zero

    var metrics: TaskFanSession.Metrics = TaskFanSession.Metrics()

    /** Runs a chosen action on its task. */
    var perform: (TaskDto, TaskFanAction) -> Unit = { _, _ -> }

    /** The gateway opens conversations about tasks: a task's fan offers Chat about this. */
    var chatAvailable: Boolean = false
    var tellAvailable: Boolean = false

    /** Every row's layout by task id: what a press lands on, and the row kept lit. */
    private val rows = mutableMapOf<String, LayoutCoordinates>()

    /** When the last pointer event happened; the dwell timer counts on from it. */
    private var lastEventMillis = 0L

    val isOpen: Boolean get() = session != null

    /** The fanned row's bounds in the overlay, kept lit while the rest of the list dims. */
    val rowFrame: Rect?
        get() {
            val id = task?.id ?: return null
            return frameOf(id)
        }

    fun registerRow(taskId: String, coordinates: LayoutCoordinates) {
        rows[taskId] = coordinates
    }

    fun unregisterRow(taskId: String) {
        rows.remove(taskId)
    }

    /** [local] in a row's own coordinates, as a point in the overlay. */
    fun toOverlay(taskId: String, local: Offset): Offset? {
        val overlay = overlay?.takeIf { it.isAttached } ?: return null
        val row = rows[taskId]?.takeIf { it.isAttached } ?: return null
        return overlay.localPositionOf(row, local)
    }

    fun frameOf(taskId: String): Rect? {
        val overlay = overlay?.takeIf { it.isAttached } ?: return null
        val row = rows[taskId]?.takeIf { it.isAttached } ?: return null
        return overlay.localBoundingBoxOf(row, clipBounds = false)
    }

    /**
     * Opens the fan for [task] at [point], where the finger pressed. [tracking] is false when no
     * finger drives it (TalkBack): it opens ready for taps.
     */
    fun open(
        task: TaskDto,
        point: Offset,
        today: LocalDate,
        mode: TaskFanSession.Mode = TaskFanSession.Mode.Main,
        tracking: Boolean = true,
        nowMillis: Long = lastEventMillis,
    ) {
        if (bounds.width <= 0f) return
        lastEventMillis = nowMillis
        session = TaskFanSession(
            anchor = point,
            bounds = bounds,
            today = today,
            metrics = metrics,
            mode = mode,
            tracking = tracking,
            suggestion = task.isSuggestion,
            chat = chatAvailable,
            tell = tellAvailable,
        )
        this.task = task
        openings++
        version++
    }

    /** Opens the fan without a finger, for TalkBack: anchored where a right thumb would press the row. */
    fun openForAccessibility(task: TaskDto, today: LocalDate, mode: TaskFanSession.Mode) {
        val row = frameOf(task.id) ?: return
        open(task, Offset(row.right - metrics.targetHeight, row.center.y), today, mode, tracking = false)
    }

    fun move(point: Offset, nowMillis: Long) {
        val current = session ?: return
        if (!current.tracking) return
        lastEventMillis = nowMillis
        val events = current.move(point, nowMillis)
        apply(events)
    }

    /** A resting finger has dwelt until [nowMillis]: follow the navigation target under it. */
    fun tick(nowMillis: Long) {
        val current = session ?: return
        apply(current.tick(nowMillis))
    }

    /** When the dwell under a resting finger completes, if one is running. */
    val dwellDeadlineMillis: Long? get() = session?.dwellDeadlineMillis

    /**
     * The finger lifted at [point], or the touch was taken away (null, which never acts). A fan
     * a finger drove always closes here, in one change: nothing sees a released-but-open fan.
     */
    fun end(point: Offset?, nowMillis: Long = lastEventMillis) {
        val current = session ?: return
        if (!current.touchDriven) return
        val outcome = point?.let { current.release(it, nowMillis) } ?: TaskFanSession.Outcome.Dismiss
        val fanned = task
        dismiss()
        if (outcome is TaskFanSession.Outcome.Perform && fanned != null) perform(fanned, outcome.action)
    }

    fun tap(action: TaskFanAction) {
        val current = session ?: return
        when (val outcome = current.tap(action)) {
            TaskFanSession.Outcome.StayOpen -> version++
            TaskFanSession.Outcome.Dismiss -> dismiss()
            is TaskFanSession.Outcome.Perform -> {
                val fanned = task
                dismiss()
                if (fanned != null) perform(fanned, outcome.action)
            }
        }
    }

    fun dismiss() {
        session = null
        task = null
        version++
    }

    private fun apply(events: List<TaskFanSession.Event>) {
        if (events.isNotEmpty()) selectionTicks++
        version++
    }
}

@Composable
fun rememberTaskFanController(): TaskFanController = remember { TaskFanController() }

/**
 * The long press on a task row that opens its fan, the slide over the targets and the lift that
 * acts. Read on [PointerEventPass.Initial], before the row's own taps, the list's scrolling and
 * the menu's reveal see the touch: until the press is held for the long-press timeout nothing
 * is consumed, so a drag still scrolls and a tap still taps; once it is, every change of that
 * touch is consumed, so the list cannot scroll under the fan, the menu cannot slide out, and
 * lifting the finger neither completes the task nor opens its details. However the touch ends —
 * lifted, cancelled, the row leaving the screen — the fan hears exactly one end.
 */
fun Modifier.taskFanPress(task: TaskDto, controller: TaskFanController, today: LocalDate): Modifier =
    pointerInput(task.id, today) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            // Null is the timeout: the finger stayed down and still for the whole long press.
            val letGo = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                var still = true
                while (still) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull { it.id == down.id }
                    still = change != null && change.pressed && !change.isConsumed &&
                        (change.position - down.position).getDistance() <= viewConfiguration.touchSlop
                }
                true
            }
            if (letGo != null) return@awaitEachGesture
            val start = controller.toOverlay(task.id, down.position) ?: return@awaitEachGesture
            controller.open(task, start, today, nowMillis = down.uptimeMillis + viewConfiguration.longPressTimeoutMillis)
            var ended = false
            try {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull { it.id == down.id }
                    if (change == null) {
                        controller.end(null)
                        ended = true
                        break
                    }
                    event.changes.forEach { it.consume() }
                    val point = controller.toOverlay(task.id, change.position)
                    if (!change.pressed) {
                        controller.end(point, change.uptimeMillis)
                        ended = true
                        break
                    }
                    if (point != null) controller.move(point, change.uptimeMillis)
                }
            } finally {
                if (!ended) controller.end(null)
            }
        }
    }

private val FAN_SHAPE = RoundedCornerShape(50)

/**
 * The fan itself, drawn over the list: the list dims except the pressed row, the targets stand
 * in a column up and to the left of the finger, and a dashed ring marks where it pressed —
 * lifting there, or anywhere off a target, closes the fan with nothing changed, which reads
 * nothing like the struck-through "Cancel task".
 */
@Composable
fun TaskFanOverlay(controller: TaskFanController, modifier: Modifier = Modifier) {
    val session = controller.session ?: return
    // Read so every in-place change of the session redraws the overlay.
    @Suppress("UNUSED_VARIABLE")
    val version = controller.version
    val c = OmTheme.colors
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(controller.openings) {
        if (controller.openings > 0) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    }
    LaunchedEffect(controller.selectionTicks) {
        if (controller.selectionTicks > 0) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
    }
    // A resting finger sends no movement, so the dwell is a timer.
    val deadline = controller.dwellDeadlineMillis
    LaunchedEffect(deadline) {
        val due = deadline ?: return@LaunchedEffect
        delay(session.metrics.dwellMillis)
        controller.tick(due)
    }
    val row = controller.rowFrame
    Box(modifier.fillMaxSize().testTag("tasks.fan")) {
        Canvas(
            Modifier
                .fillMaxSize()
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClickLabel = "Close actions",
                    onClick = controller::dismiss,
                )
                .semantics { contentDescription = "Close actions" },
        ) {
            val path = Path().apply {
                fillType = PathFillType.EvenOdd
                addRect(Rect(Offset.Zero, size))
                row?.let { addRect(it) }
            }
            drawPath(path, Color.Black.copy(alpha = 0.55f))
            val radius = session.metrics.originRadius * 0.8f
            drawCircle(
                color = c.textSecondary,
                radius = radius,
                center = session.anchor,
                style = Stroke(width = 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 3.dp.toPx()))),
            )
            if (session.tracking && session.highlighted == null) {
                val arm = radius * 0.32f
                val stroke = 1.8.dp.toPx()
                drawLine(c.textSecondary, session.anchor + Offset(-arm, -arm), session.anchor + Offset(arm, arm), stroke)
                drawLine(c.textSecondary, session.anchor + Offset(-arm, arm), session.anchor + Offset(arm, -arm), stroke)
            }
        }
        session.targets.forEach { target ->
            FanTargetButton(
                target = target,
                highlighted = session.highlighted == target.action,
                suggestion = session.suggestion,
                onTap = { controller.tap(target.action) },
            )
        }
    }
}

@Composable
private fun FanTargetButton(target: TaskFanTarget, highlighted: Boolean, suggestion: Boolean, onTap: () -> Unit) {
    val c = OmTheme.colors
    val density = LocalDensity.current
    val width = with(density) { target.frame.width.toDp() }
    val height = with(density) { target.frame.height.toDp() }
    val foreground = when {
        highlighted -> if (c.isDark) c.bgPrimary else Color.White
        target.action == TaskFanAction.CancelTask -> c.danger
        else -> c.textPrimary
    }
    Row(
        Modifier
            .offset { IntOffset(target.frame.left.roundToInt(), target.frame.top.roundToInt()) }
            .size(width, height)
            .shadow(8.dp, FAN_SHAPE)
            .clip(FAN_SHAPE)
            .background(if (highlighted) c.accent else c.bgTertiary)
            .border(1.dp, if (highlighted) Color.Transparent else c.border, FAN_SHAPE)
            .clickable(role = Role.Button, onClickLabel = fanTargetSpokenLabel(target, suggestion), onClick = onTap)
            .semantics {
                contentDescription = fanTargetSpokenLabel(target, suggestion)
                onClick(label = fanTargetSpokenLabel(target, suggestion)) { onTap(); true }
            }
            .testTag("tasks.fan.${fanTargetTag(target.action)}")
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(fanIcon(target.action), contentDescription = null, tint = foreground, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            target.label,
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = foreground,
            textDecoration = if (target.action == TaskFanAction.CancelTask) TextDecoration.LineThrough else null,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (target.action == TaskFanAction.OtherMonth || target.action == TaskFanAction.AcceptFor) {
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                tint = foreground,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/** What TalkBack says for a target. */
internal fun fanTargetSpokenLabel(target: TaskFanTarget, suggestion: Boolean = false): String = when (target.action) {
    is TaskFanAction.Month -> if (suggestion) "Accept for ${target.label}" else "Move to ${target.label}"
    TaskFanAction.OtherMonth -> "Other month"
    TaskFanAction.AcceptFor -> "Accept for"
    else -> target.label
}

/** A stable test tag for each target. */
internal fun fanTargetTag(action: TaskFanAction): String = when (action) {
    TaskFanAction.Done -> "done"
    TaskFanAction.DoneWithNote -> "doneWithNote"
    TaskFanAction.Tomorrow -> "tomorrow"
    TaskFanAction.NextMonth -> "nextMonth"
    TaskFanAction.OtherMonth -> "otherMonth"
    TaskFanAction.CancelTask -> "cancelTask"
    is TaskFanAction.Month -> "month.${action.month}"
    TaskFanAction.Back -> "back"
    TaskFanAction.LaterMonths -> "later"
    TaskFanAction.EarlierMonths -> "earlier"
    TaskFanAction.Accept -> "accept"
    TaskFanAction.AcceptWithNote -> "acceptWithNote"
    TaskFanAction.AcceptFor -> "acceptFor"
    TaskFanAction.Today -> "today"
    TaskFanAction.NextWeek -> "nextWeek"
    TaskFanAction.Someday -> "someday"
    TaskFanAction.Ignore -> "ignore"
    TaskFanAction.Tell -> "tell"
    TaskFanAction.ChatAbout -> "chatAbout"
}

private fun fanIcon(action: TaskFanAction): ImageVector = when (action) {
    TaskFanAction.Done -> Icons.Outlined.Check
    TaskFanAction.DoneWithNote -> Icons.Outlined.EditNote
    TaskFanAction.Tomorrow -> Icons.Outlined.WbSunny
    TaskFanAction.NextMonth -> Icons.Outlined.CalendarMonth
    TaskFanAction.OtherMonth -> Icons.Outlined.EventRepeat
    TaskFanAction.CancelTask -> Icons.Outlined.Close
    is TaskFanAction.Month -> Icons.Outlined.CalendarMonth
    TaskFanAction.Back -> Icons.AutoMirrored.Outlined.ArrowBack
    TaskFanAction.LaterMonths -> Icons.Outlined.KeyboardArrowDown
    TaskFanAction.EarlierMonths -> Icons.Outlined.KeyboardArrowUp
    TaskFanAction.Accept -> Icons.Outlined.AddTask
    TaskFanAction.AcceptWithNote -> Icons.Outlined.EditNote
    TaskFanAction.AcceptFor -> Icons.Outlined.Event
    TaskFanAction.Today -> Icons.Outlined.Today
    TaskFanAction.NextWeek -> Icons.Outlined.DateRange
    TaskFanAction.Someday -> Icons.Outlined.HourglassEmpty
    TaskFanAction.Ignore -> Icons.Outlined.VisibilityOff
    TaskFanAction.Tell -> Icons.Outlined.Mic
    TaskFanAction.ChatAbout -> Icons.Outlined.ChatBubbleOutline
}
