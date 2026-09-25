// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import kotlin.math.abs

/**
 * Geometry, thresholds and the gesture decisions for the slide-out menu — the menu that
 * sits under the app, which the app slides aside to reveal.
 *
 * Deliberately free of Compose so it compiles, and is tested, in the plain-JVM logic lane.
 * `MenuRevealContainer` renders what these functions decide. Port of the iOS `MenuReveal`
 * (`ios/Sources/Omnesis/UI/MenuReveal.swift`); keep the two in step — the values below are
 * the same numbers, so the two apps move the same way.
 */
object MenuReveal {
    // --- Geometry -----------------------------------------------------------------

    /**
     * How far the app travels, as a fraction of the container width. The remainder is the
     * strip of app left standing on the trailing edge: enough to keep the user anchored in
     * what they were doing, and a target they can tap to come back to it.
     */
    const val OPEN_FRACTION = 0.78f

    /**
     * Ceiling on that travel, in dp, and so on the menu's width. A fraction alone suits a
     * phone but not a tablet, where it would give a menu wide enough to strand a row's
     * label at one end and the Settings button at the other. Past this width the menu
     * stops growing and the app simply keeps more of the screen.
     */
    const val MAXIMUM_MENU_WIDTH_DP = 400f

    /**
     * The leading fraction of the width in which a rightward drag reveals the menu. The
     * trailing remainder is held clear so that edge stays unambiguously the Timeline's:
     * the Agent surface opens its Timeline from there, and a reveal that reached the whole
     * way would leave no part of the screen that belongs to one gesture only.
     */
    const val GESTURE_FRACTION = 0.8f

    /**
     * Corner radius the app's leading corners reach at full travel. Android exposes no
     * display corner radius before API 31 and rounds vary by device, so this is a
     * constant — and the corners are only ever on screen mid-screen, where there is
     * nothing beside them to be out by a pixel against.
     */
    const val SCREEN_CORNER_RADIUS_DP = 28f

    /**
     * Opacity of the wash over the app at full travel. Deliberately slight: it only has to
     * say "not this one just now", since the menu is already the rest of the screen.
     * Pushed further, the app goes muddy grey in light mode and in dark mode crosses
     * *under* the menu's own surface, which reads as the app sinking behind the menu
     * rather than lifting off it. A hairline on the cut edge draws the separation instead.
     */
    const val SCRIM_OPACITY = 0.18f

    // --- Thresholds ---------------------------------------------------------------

    /**
     * How far through the travel a released drag must have come to settle open rather than
     * back where it started. Applied to the distance moved during *this* drag, so it reads
     * the same opening and closing.
     */
    const val COMMIT_FRACTION = 1f / 3f

    /** Speed (dp/s) above which the direction of the flick decides the outcome outright. */
    const val FLICK_VELOCITY_DP_PER_SEC = 500f

    /**
     * Movement/velocity in density-independent units and axis dominance at which a touch is
     * classified. A velocity threshold lets a short, quick thumb flick claim the menu before
     * it has accumulated much distance. Once vertical movement wins, the touch is yielded for
     * its lifetime instead of being reconsidered if it curves later.
     */
    const val DISTANCE_THRESHOLD_DP = 12f
    const val AXIS_VELOCITY_DP_PER_SEC = 150f
    const val AXIS_DOMINANCE = 1.5f

    enum class DragMode { Undetermined, Horizontal, Yielded }

    // --- Derived geometry ---------------------------------------------------------

    /**
     * The width the menu lays out in, for a container of [widthPx]. Identical to the
     * distance the app travels, because the menu is exactly what the app uncovers.
     */
    fun menuWidthPx(widthPx: Float, density: Float): Float =
        minOf(widthPx * OPEN_FRACTION, MAXIMUM_MENU_WIDTH_DP * density)

    /**
     * 0 closed, 1 fully open. The single number every visual property is derived from, so
     * offset, scrim and corner radius cannot disagree.
     */
    fun progress(offsetPx: Float, travelPx: Float): Float =
        if (travelPx <= 0f) 0f else (offsetPx / travelPx).coerceIn(0f, 1f)

    /** Holds the app to the travel available, so a drag never overshoots either end. */
    fun clampOffset(offsetPx: Float, travelPx: Float): Float = offsetPx.coerceIn(0f, travelPx)

    // --- Gesture decisions --------------------------------------------------------

    /**
     * Whether a touch is a reveal.
     *
     * A drag only ever moves the menu *towards* its other state, and — while the menu is
     * closed — only if it began clear of the reserved trailing edge. [consumedByChild] is
     * the Compose equivalent of losing an arbitration: something nearer the finger (a
     * horizontally scrolling rail, a row moving its swipe actions) already claimed this
     * drag, and claiming it again would move both at once.
     */
    fun classifyDrag(
        current: DragMode,
        startX: Float,
        totalDx: Float,
        totalDy: Float,
        velocityX: Float,
        velocityY: Float,
        width: Float,
        isOpen: Boolean,
        consumedByChild: Boolean,
    ): DragMode {
        if (current != DragMode.Undetermined) return current
        if (consumedByChild) return DragMode.Yielded

        val distanceReady = maxOf(abs(totalDx), abs(totalDy)) >= DISTANCE_THRESHOLD_DP
        val velocityReady = maxOf(abs(velocityX), abs(velocityY)) >= AXIS_VELOCITY_DP_PER_SEC
        if (!distanceReady && !velocityReady) return DragMode.Undetermined

        val distanceWon = distanceReady && abs(totalDx) >= abs(totalDy) * AXIS_DOMINANCE
        val velocityWon = velocityReady && abs(velocityX) >= abs(velocityY) * AXIS_DOMINANCE
        val verticalWon = (distanceReady && abs(totalDy) >= abs(totalDx) * AXIS_DOMINANCE) ||
            (velocityReady && abs(velocityY) >= abs(velocityX) * AXIS_DOMINANCE)
        val horizontal = distanceWon || velocityWon
        if (!horizontal) return if (verticalWon) DragMode.Yielded else DragMode.Undetermined

        val direction = if (velocityWon) velocityX else totalDx
        val goingRight = direction > 0f
        val allowed = if (isOpen) {
            !goingRight
        } else {
            goingRight && startX <= width * GESTURE_FRACTION
        }
        return if (allowed) DragMode.Horizontal else DragMode.Undetermined
    }

    /**
     * Where a released drag settles: a decisive flick decides on direction alone,
     * otherwise the distance moved during this drag has to have crossed
     * [COMMIT_FRACTION] of the travel.
     */
    fun shouldOpen(
        velocityDpPerSec: Float,
        dragDistancePx: Float,
        travelPx: Float,
        isOpen: Boolean,
    ): Boolean {
        if (abs(velocityDpPerSec) > FLICK_VELOCITY_DP_PER_SEC) return velocityDpPerSec > 0f
        val threshold = travelPx * COMMIT_FRACTION
        return if (isOpen) dragDistancePx > -threshold else dragDistancePx > threshold
    }

    /** Whether a released drag committed to the opposite resting state. */
    fun committedStateChanged(fromOpen: Boolean, toOpen: Boolean): Boolean = fromOpen != toOpen
}
