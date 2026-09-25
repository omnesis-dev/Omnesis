// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmTheme
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlinx.coroutines.launch

/**
 * Presents the main menu *beneath* the app, and slides the app aside to reveal it.
 *
 * Moving the app, rather than covering it, keeps it the object under the user's hand: it
 * steps aside, corners rounding as it lifts, and stays visible on the trailing edge as
 * somewhere to go back to. That also frees the gesture to work across the whole screen,
 * since there is no panel that has to be dragged in from an edge.
 *
 * Layering, bottom to top: [menu], then [content] offset by `progress` of the travel,
 * washed by a scrim and cut to a corner radius that both scale with the same progress.
 *
 * ## Losing the drag on purpose
 *
 * The reveal shares the rightward direction with things nearer the finger — a code block
 * that scrolls sideways, a list row moving its swipe actions. The pointer handler runs on
 * [PointerEventPass.Main], which reaches a parent only *after* its children, and refuses
 * any drag a child has already consumed. That is what keeps the two from firing at once.
 * The iOS app needed a UIKit recogniser and `shouldRequireFailureOf` to say the same
 * thing; Compose says it with a pass and a consumption check.
 */
@Composable
fun MenuRevealContainer(
    isOpen: Boolean,
    onOpenChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    /**
     * Freezes the reveal at a fixed point of its travel (0 closed, 1 open), ignoring
     * [isOpen] and any drag. Screenshot goldens use it to render a mid-gesture frame,
     * which is otherwise unreachable in a still — and to render the open state at all,
     * since the settle animation does not advance under a Robolectric render.
     */
    progressOverride: Float? = null,
    /** Test seam for the committed release; null performs the platform feedback. */
    onCommittedSwipeHaptic: (() -> Unit)? = null,
    menu: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    val colors = OmTheme.colors
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    val currentCommittedSwipeHaptic by rememberUpdatedState(onCommittedSwipeHaptic)

    // The menu slides the app aside, so whatever was being typed into is no longer reachable.
    // Done here rather than at each call site because a tap, a drag and a deep link all arrive
    // as the same `isOpen`.
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    LaunchedEffect(isOpen) {
        if (isOpen) {
            focusManager.clearFocus(force = true)
            keyboard?.hide()
        }
    }

    var widthPx by remember { mutableFloatStateOf(0f) }
    val travelPx = MenuReveal.menuWidthPx(widthPx, density.density)
    // The app's distance from rest, in pixels. An `Animatable` so a released drag carries
    // on from wherever the finger left it, rather than snapping back and re-animating.
    val offset = remember { Animatable(0f) }
    var dragging by remember { mutableStateOf(false) }
    var dragOffsetPx by remember { mutableFloatStateOf(0f) }

    // Keeps the app in step with `isOpen` when it changes from anywhere but a drag — a
    // toolbar tap, a menu row, a back press.
    LaunchedEffect(isOpen, travelPx, progressOverride) {
        if (travelPx <= 0f || progressOverride != null) return@LaunchedEffect
        val target = if (isOpen) travelPx else 0f
        if (abs(offset.value - target) > 0.5f) offset.animateTo(target, tween(220))
    }

    val liveOffsetPx = if (dragging) dragOffsetPx else offset.value
    val progress = progressOverride?.coerceIn(0f, 1f)
        ?: MenuReveal.progress(liveOffsetPx, travelPx)
    val offsetPx = if (progressOverride != null) travelPx * progress else liveOffsetPx

    Box(
        modifier
            .fillMaxSize()
            .background(colors.bgDrawer)
            .onSizeChanged { widthPx = it.width.toFloat() }
            .pointerInput(isOpen, travelPx, progressOverride) {
                if (travelPx <= 0f || progressOverride != null) return@pointerInput
                awaitEachGesture {
                    // Main, not Initial: children see the event first, so anything nearer
                    // the finger has already had its chance to claim the drag.
                    val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Main)
                    val startX = down.position.x
                    val tracker = VelocityTracker()
                    tracker.addPosition(down.uptimeMillis, down.position)
                    // Where the app rests for this touch. The drag is applied as an
                    // absolute offset from here rather than an increment, so the settles
                    // launched below cannot land out of order.
                    val restingPx = if (isOpen) travelPx else 0f
                    var mode = MenuReveal.DragMode.Undetermined
                    var settling = false

                    try {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Main)
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            tracker.addPosition(change.uptimeMillis, change.position)
                            val translation = change.position - down.position
                            val velocity = tracker.calculateVelocity()
                            mode = MenuReveal.classifyDrag(
                                current = mode,
                                startX = startX / density.density,
                                totalDx = translation.x / density.density,
                                totalDy = translation.y / density.density,
                                velocityX = velocity.x / density.density,
                                velocityY = velocity.y / density.density,
                                width = widthPx / density.density,
                                isOpen = isOpen,
                                consumedByChild = change.isConsumed,
                            )
                            if (!change.pressed) {
                                if (mode == MenuReveal.DragMode.Horizontal) {
                                    settling = true
                                    val releasedOffset = MenuReveal.clampOffset(restingPx + translation.x, travelPx)
                                    val open = MenuReveal.shouldOpen(
                                        velocityDpPerSec = velocity.x / density.density,
                                        dragDistancePx = translation.x,
                                        travelPx = travelPx,
                                        isOpen = isOpen,
                                    )
                                    if (MenuReveal.committedStateChanged(isOpen, open)) {
                                        if (currentCommittedSwipeHaptic != null) {
                                            currentCommittedSwipeHaptic?.invoke()
                                        } else {
                                            val feedback = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                                                HapticFeedbackConstants.GESTURE_END
                                            } else {
                                                HapticFeedbackConstants.CLOCK_TICK
                                            }
                                            view.performHapticFeedback(feedback)
                                        }
                                    }
                                    scope.launch {
                                        offset.snapTo(releasedOffset)
                                        dragging = false
                                        offset.animateTo(
                                            if (open) travelPx else 0f,
                                            spring(dampingRatio = 0.9f, stiffness = 400f),
                                        )
                                        onOpenChange(open)
                                    }
                                }
                                break
                            }
                            if (mode == MenuReveal.DragMode.Horizontal) {
                                dragging = true
                                dragOffsetPx = MenuReveal.clampOffset(restingPx + translation.x, travelPx)
                                change.consume()
                            }
                        }
                    } finally {
                        // Cancellation, pointer loss, or a pointerInput key restart has no release
                        // sample to settle. Drop the transient offset so it cannot pin the app.
                        if (!settling) {
                            dragging = false
                        }
                    }
                }
            },
    ) {
        // The menu is only ever as wide as the app moves — past that it is behind the app
        // and could never be seen. Laying it out to the full screen instead would run its
        // rows, and the Settings button at its trailing edge, underneath the standing
        // strip where they are permanently unreachable.
        Box(
            Modifier
                .align(Alignment.CenterStart)
                // Width BEFORE height: `fillMaxSize` would pin the width to the incoming
                // maximum and a later `width` could not shrink it — which lays the menu
                // out full-screen and puts its trailing Settings button underneath the
                // standing strip, where it can never be reached.
                .then(
                    if (travelPx > 0f) Modifier.width(with(density) { travelPx.toDp() }) else Modifier,
                )
                .fillMaxHeight()
                // Behind the app rather than off-screen, so a screen reader would
                // otherwise reach it straight through whatever is on top.
                .then(if (progress < 1f) Modifier.clearAndSetSemantics {} else Modifier),
        ) {
            menu()
        }

        AppLayer(
            progress = progress,
            offsetPx = offsetPx,
            onTapToClose = {
                scope.launch {
                    offset.animateTo(0f, tween(220))
                    onOpenChange(false)
                }
            },
            content = content,
        )
    }
}

/**
 * The app itself: offset, cut to a rounded corner that grows as it lifts, washed by a
 * scrim, and edged with a hairline.
 *
 * In dark mode the hairline, not the scrim, is what separates the app from the menu — the
 * two surfaces are only a few levels apart and `border` is lighter than both.
 */
@Composable
private fun AppLayer(
    progress: Float,
    offsetPx: Float,
    onTapToClose: () -> Unit,
    content: @Composable () -> Unit,
) {
    val colors = OmTheme.colors
    val shape = RoundedCornerShape((MenuReveal.SCREEN_CORNER_RADIUS_DP * progress).dp)
    Box(
        Modifier
            .fillMaxSize()
            .offset { IntOffset(offsetPx.roundToInt(), 0) }
            .shadow(elevation = (24f * progress).dp, shape = shape, clip = false)
            .clip(shape)
            .background(colors.bgPrimary)
            .border(1.dp, colors.border.copy(alpha = progress), shape),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .then(if (progress > 0f) Modifier.clearAndSetSemantics {} else Modifier),
        ) {
            content()
        }
        if (progress > 0f) {
            // The wash, and — once the app has fully stepped aside — the way back. It also
            // swallows touches meant for the app underneath, which is inert while it is
            // standing aside.
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = MenuReveal.SCRIM_OPACITY * progress))
                    .pointerInput(progress >= 1f) {
                        if (progress >= 1f) {
                            detectTapGestures { onTapToClose() }
                        } else {
                            // Mid-travel: absorb touches without acting on them, so a
                            // stray tap never lands on the app that is on its way out.
                            awaitEachGesture {
                                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Main)
                            }
                        }
                    },
            )
        }
    }
}
