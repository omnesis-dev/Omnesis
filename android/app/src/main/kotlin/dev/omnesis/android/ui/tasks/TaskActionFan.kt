// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.tasks

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.PI
import kotlin.math.hypot
import kotlin.math.sin

/**
 * What a target in a task's action fan does. A suggestion's fan reuses the move targets
 * (Tomorrow, Next month, a month) to accept it planned for that time.
 */
sealed interface TaskFanAction {
    /** Completes the task; on a suggestion, marks it done without accepting it first. */
    data object Done : TaskFanAction

    /** Opens the note composer; saving completes the task with the note. */
    data object DoneWithNote : TaskFanAction
    data object Tomorrow : TaskFanAction
    data object NextMonth : TaskFanAction

    /** Opens the month fan. */
    data object OtherMonth : TaskFanAction

    /** Strikes the task: it leaves the lists but keeps its history. */
    data object CancelTask : TaskFanAction

    /** Moves the task to a month, `YYYY-MM`. */
    data class Month(val month: String) : TaskFanAction

    /** From the month fan back to the main fan. */
    data object Back : TaskFanAction

    /** The next page of months. */
    data object LaterMonths : TaskFanAction

    /** The previous page of months. */
    data object EarlierMonths : TaskFanAction

    /** Accepts a suggestion as it stands. */
    data object Accept : TaskFanAction

    /** Opens the note composer; saving accepts the suggestion with the note. */
    data object AcceptWithNote : TaskFanAction

    /** Opens the "when" fan, whose targets accept the suggestion planned for that time. */
    data object AcceptFor : TaskFanAction

    /** Accepts a suggestion planned for today. */
    data object Today : TaskFanAction

    /** Accepts a suggestion planned for next Monday. */
    data object NextWeek : TaskFanAction

    /** Accepts a suggestion planned for someday. */
    data object Someday : TaskFanAction

    /** Takes a suggestion out of Tasks; Omnesis keeps tracking it. */
    data object Ignore : TaskFanAction

    /** Whether the target changes what the fan shows rather than the task. */
    val isNavigation: Boolean
        get() = this == OtherMonth || this == Back || this == LaterMonths || this == EarlierMonths ||
            this == AcceptFor
}

/** One labelled target, placed in the overlay's pixel coordinates. */
data class TaskFanTarget(val action: TaskFanAction, val label: String, val frame: Rect) {
    val center: Offset get() = frame.center
}

/**
 * The action fan a long press on a task's row opens: where its targets go, which one the
 * finger is over, and what lifting the finger does. Pure, so the gesture's rules are covered by
 * the logic lane and Compose only draws and forwards touches. A port of the iOS
 * `TaskFanSession`; keep the two in step.
 *
 * The fan is anchored where the finger pressed and laid out for a right thumb: a column of
 * labelled targets up and to the left of the touch, so the thumb, which reaches in from the
 * lower right, never covers a label. The column leans further left as it rises, following the
 * thumb's arc. Its order is fixed and counted outwards from the thumb — Done is always nearest.
 * Near the top of the list the column flips downwards (mirrored, so the order by distance never
 * changes); near the left edge it slides right to stay on screen.
 *
 * The fan lives only while the finger is down: slide onto a target and lift to act; lift
 * anywhere else and nothing changes. Resting on Other month… opens the month fan in place; its
 * targets wait for a deliberate movement before they can be selected, so the one that appears
 * under the finger is never chosen by accident. TalkBack, which cannot hold and slide, opens
 * the fan without a finger ([tracking] false) and taps its targets.
 *
 * Every length is in pixels: [Metrics.scaled] turns the dp design values into them.
 */
class TaskFanSession(
    /** Where the finger pressed. */
    val anchor: Offset,
    /** Where targets may go: the visible list. */
    val bounds: Rect,
    /** The device's local day. */
    val today: LocalDate,
    val metrics: Metrics = Metrics(),
    mode: Mode = Mode.Main,
    tracking: Boolean = true,
    private val locale: Locale = Locale.getDefault(),
    /** The fan is a Brain suggestion's rather than one of the user's own tasks'. */
    val suggestion: Boolean = false,
) {
    sealed interface Mode {
        data object Main : Mode

        /** A suggestion's "Accept for…": when to plan it. */
        data object When : Mode
        data class Months(val page: Int) : Mode
    }

    sealed interface Event {
        /** The finger entered a different target — a haptic tick. */
        data class SelectionChanged(val action: TaskFanAction) : Event
        data class ModeChanged(val mode: Mode) : Event
    }

    sealed interface Outcome {
        data class Perform(val action: TaskFanAction) : Outcome

        /** The fan stays on screen: a tap followed a navigation target. */
        data object StayOpen : Outcome

        /** The fan closes and the task is unchanged. */
        data object Dismiss : Outcome
    }

    data class Metrics(
        val targetWidth: Float = 176f,
        val targetHeight: Float = 44f,
        val spacing: Float = 6f,
        /** From the touch point to the near (trailing) edge of the column. */
        val lead: Float = 26f,
        /** How far the middle of the column bows out from the touch. */
        val curve: Float = 10f,
        /** How much further left the far end of the column sits than the near end. */
        val sweep: Float = 24f,
        /** Inside this radius of the touch point the finger selects nothing. */
        val originRadius: Float = 26f,
        val hitSlop: Float = 3f,
        val edgeMargin: Float = 8f,
        /** How long the finger rests on a navigation target to follow it. */
        val dwellMillis: Long = 450,
        /** How far the finger must move after a fan changes under it before anything can be selected. */
        val armDistance: Float = 22f,
        val monthsPerPage: Int = 6,
    ) {
        /** The same metrics with every length multiplied by [density] — dp to pixels. */
        fun scaled(density: Float): Metrics = copy(
            targetWidth = targetWidth * density,
            targetHeight = targetHeight * density,
            spacing = spacing * density,
            lead = lead * density,
            curve = curve * density,
            sweep = sweep * density,
            originRadius = originRadius * density,
            hitSlop = hitSlop * density,
            edgeMargin = edgeMargin * density,
            armDistance = armDistance * density,
        )
    }

    var mode: Mode = mode
        private set
    var targets: List<TaskFanTarget> = emptyList()
        private set
    var highlighted: TaskFanAction? = null
        private set

    /** A finger is down and driving the fan. */
    var tracking: Boolean = tracking
        private set

    /** A finger opened the fan (rather than TalkBack): lifting it always closes the fan. */
    val touchDriven: Boolean = tracking

    private var lastPoint: Offset = anchor
    private var hoverSinceMillis: Long? = null

    /** Set when a fan changed under the finger: nothing is selectable until it moved [Metrics.armDistance]. */
    private var armPoint: Offset? = null

    init {
        show(mode)
    }

    // Touches

    /** The finger moved. Returns what the view should react to. */
    fun move(point: Offset, nowMillis: Long): List<Event> {
        if (!tracking) return emptyList()
        lastPoint = point
        armPoint?.let { arm ->
            if (distance(point, arm) < metrics.armDistance) {
                highlighted = null
                hoverSinceMillis = null
                return emptyList()
            }
            armPoint = null
        }
        val events = mutableListOf<Event>()
        val hit = targetAt(point)?.action
        if (hit != highlighted) {
            highlighted = hit
            hoverSinceMillis = if (hit == null) null else nowMillis
            if (hit != null) events += Event.SelectionChanged(hit)
        }
        return events + tick(nowMillis)
    }

    /** When a resting finger will have dwelt long enough to follow the navigation target under it. */
    val dwellDeadlineMillis: Long?
        get() {
            val action = highlighted ?: return null
            val since = hoverSinceMillis ?: return null
            return if (tracking && action.isNavigation) since + metrics.dwellMillis else null
        }

    /** Time passed without movement: follow a navigation target the finger has rested on long enough. */
    fun tick(nowMillis: Long): List<Event> {
        val deadline = dwellDeadlineMillis ?: return emptyList()
        val action = highlighted ?: return emptyList()
        if (nowMillis < deadline) return emptyList()
        navigate(action)
        armPoint = lastPoint
        return listOf(Event.ModeChanged(mode))
    }

    /**
     * The finger lifted at [point]: an action under it runs; anywhere else — the touch point, a
     * gap, a navigation target, outside the fan — closes the fan with nothing changed.
     */
    fun release(point: Offset, nowMillis: Long): Outcome {
        if (!tracking) return Outcome.Dismiss
        move(point, nowMillis)
        tracking = false
        val action = highlighted
        return if (action == null || action.isNavigation) Outcome.Dismiss else Outcome.Perform(action)
    }

    /** A tap on a target of a fan TalkBack opened (or a tap after the finger lifted). */
    fun tap(action: TaskFanAction): Outcome {
        tracking = false
        if (action.isNavigation) {
            navigate(action)
            return Outcome.StayOpen
        }
        return Outcome.Perform(action)
    }

    // Geometry

    /** The target under [point], if any. The touch point itself selects nothing. */
    fun targetAt(point: Offset): TaskFanTarget? {
        if (distance(point, anchor) <= metrics.originRadius) return null
        return targets.firstOrNull { it.frame.inflate(metrics.hitSlop).contains(point) }
    }

    /** Whether the column rises from the touch or, near the top, hangs below it. */
    val upwards: Boolean get() = upwards(targets.size, anchor, bounds, metrics)

    /** Shows the fan for [mode] directly — TalkBack's "Move to month…". */
    fun show(mode: Mode) {
        this.mode = mode
        highlighted = null
        hoverSinceMillis = null
        val labelled = when (mode) {
            Mode.Main -> if (suggestion) SUGGESTION_ACTIONS else MAIN_ACTIONS
            Mode.When -> WHEN_ACTIONS
            is Mode.Months -> monthActions(mode.page, today, metrics.monthsPerPage, locale)
        }
        targets = layout(labelled, anchor, bounds, metrics)
    }

    private fun navigate(action: TaskFanAction) {
        val current = mode
        when {
            action == TaskFanAction.OtherMonth -> show(Mode.Months(0))
            action == TaskFanAction.AcceptFor -> show(Mode.When)
            // A suggestion's months were reached through "when", so Back returns there.
            action == TaskFanAction.Back -> show(if (suggestion && current is Mode.Months) Mode.When else Mode.Main)
            action == TaskFanAction.LaterMonths && current is Mode.Months -> show(Mode.Months(current.page + 1))
            action == TaskFanAction.EarlierMonths && current is Mode.Months ->
                show(Mode.Months((current.page - 1).coerceAtLeast(0)))
        }
    }

    companion object {
        /** The main fan, nearest the finger first. The order never changes. */
        val MAIN_ACTIONS: List<Pair<TaskFanAction, String>> = listOf(
            TaskFanAction.Done to "Done",
            TaskFanAction.DoneWithNote to "Done + note",
            TaskFanAction.Tomorrow to "Tomorrow",
            TaskFanAction.NextMonth to "Next month",
            TaskFanAction.OtherMonth to "Other month…",
            TaskFanAction.CancelTask to "Cancel task",
        )

        /** A suggestion's main fan, nearest the finger first. */
        val SUGGESTION_ACTIONS: List<Pair<TaskFanAction, String>> = listOf(
            TaskFanAction.Accept to "Accept",
            TaskFanAction.AcceptWithNote to "Accept with note",
            TaskFanAction.AcceptFor to "Accept for…",
            TaskFanAction.Done to "Mark as done",
            TaskFanAction.Ignore to "Ignore",
        )

        /** "Accept for…": Back nearest the finger, then the times to plan the suggestion for. */
        val WHEN_ACTIONS: List<Pair<TaskFanAction, String>> = listOf(
            TaskFanAction.Back to "Back",
            TaskFanAction.Today to "Today",
            TaskFanAction.Tomorrow to "Tomorrow",
            TaskFanAction.NextWeek to "Next week",
            TaskFanAction.NextMonth to "Next month",
            TaskFanAction.OtherMonth to "Other month…",
            TaskFanAction.Someday to "Someday",
        )

        internal fun upwards(count: Int, anchor: Offset, bounds: Rect, metrics: Metrics): Boolean {
            val extent = count * (metrics.targetHeight + metrics.spacing) + metrics.edgeMargin
            val roomAbove = anchor.y - bounds.top
            val roomBelow = bounds.bottom - anchor.y
            return roomAbove >= extent || (roomBelow < extent && roomAbove >= roomBelow)
        }

        /** Lays out [labelled] as the column: the first nearest the thumb. */
        fun layout(
            labelled: List<Pair<TaskFanAction, String>>,
            anchor: Offset,
            bounds: Rect,
            metrics: Metrics,
        ): List<TaskFanTarget> {
            val count = labelled.size
            if (count == 0) return emptyList()
            val rising = upwards(count, anchor, bounds, metrics)
            val step = metrics.targetHeight + metrics.spacing
            val halfW = metrics.targetWidth / 2
            val halfH = metrics.targetHeight / 2
            var centers = (0 until count).map { index ->
                val along = index + 0.5f
                val progress = if (count > 1) index.toFloat() / (count - 1) else 0f
                val bow = metrics.curve * sin(PI * progress).toFloat()
                val lean = metrics.sweep * progress
                Offset(
                    x = anchor.x - metrics.lead - halfW - bow - lean,
                    y = if (rising) anchor.y - along * step else anchor.y + along * step,
                )
            }
            // Keep the whole column inside the bounds by sliding it, never by reordering it.
            val inner = bounds.deflate(metrics.edgeMargin)
            val minY = centers.minOf { it.y } - halfH
            val maxY = centers.maxOf { it.y } + halfH
            val dy = when {
                minY < inner.top -> inner.top - minY
                maxY > inner.bottom -> inner.bottom - maxY
                else -> 0f
            }
            val minX = centers.minOf { it.x } - halfW
            val maxX = centers.maxOf { it.x } + halfW
            val dx = when {
                minX < inner.left -> inner.left - minX
                maxX > inner.right -> inner.right - maxX
                else -> 0f
            }
            centers = centers.map { Offset(it.x + dx, it.y + dy) }
            return labelled.zip(centers) { (action, label), center ->
                TaskFanTarget(
                    action = action,
                    label = label,
                    frame = Rect(
                        left = center.x - halfW,
                        top = center.y - halfH,
                        right = center.x + halfW,
                        bottom = center.y + halfH,
                    ),
                )
            }
        }

        /** The month fan for [page]: Back nearest the finger, Earlier when there is an earlier page, the months, then Later. */
        fun monthActions(
            page: Int,
            today: LocalDate,
            perPage: Int,
            locale: Locale = Locale.getDefault(),
        ): List<Pair<TaskFanAction, String>> = buildList {
            add(TaskFanAction.Back to "Back")
            if (page > 0) add(TaskFanAction.EarlierMonths to "Earlier")
            months(page, today, perPage, locale).forEach { (value, label) -> add(TaskFanAction.Month(value) to label) }
            add(TaskFanAction.LaterMonths to "Later")
        }

        /**
         * A page of months to move a task to, each `YYYY-MM` with a label that always carries its
         * year ("Jan 2027"). Page 0 starts the month after next — next month has its own target —
         * and the pages run on with no end, across years.
         */
        fun months(
            page: Int,
            today: LocalDate,
            perPage: Int,
            locale: Locale = Locale.getDefault(),
        ): List<Pair<String, String>> {
            val format = DateTimeFormatter.ofPattern("MMM yyyy", locale)
            val start = YearMonth.from(today)
            return (0 until perPage).map { index ->
                val month = start.plusMonths(2L + page.coerceAtLeast(0) * perPage + index)
                month.toString() to format.format(month)
            }
        }

        private fun distance(a: Offset, b: Offset): Float = hypot(a.x - b.x, a.y - b.y)
    }
}
