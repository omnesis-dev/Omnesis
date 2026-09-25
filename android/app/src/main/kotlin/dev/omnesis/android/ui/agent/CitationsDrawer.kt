// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentTrailEvent
import dev.omnesis.android.transport.dto.AgentTrailRecord
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Right-anchored reference drawer for the agent surface — the chronological **Timeline** of
 * every document the agent referenced this conversation. Slides in from the trailing edge
 * over a dim scrim so the conversation underneath stays partly visible; a *reference*
 * surface, not a navigation replacement. Pixel-parity port of the iOS `CitationsDrawer`.
 *
 * Every Timeline event has a corresponding **sticky tab** that lives in its own layer to the
 * LEFT of the panel's leading edge. The tabs are scroll-linked: each tab's Y tracks its
 * event row's source-icon dot as the user scrolls inside the panel. Events whose anchor
 * would sit below the tab zone (in the bottom strip reserved for the pill, or scrolled out
 * of the viewport) are aggregated into a sleek **"+N" pill** that peeks from the panel's
 * bottom-leading edge. Both the tabs and the pill stay visible whether the drawer is open or
 * closed — when open they tuck behind the panel edge leaving only a sliver peeking out.
 *
 * Opened by tapping the citation affordance, tapping any visible sticky tab / the overflow
 * pill, or by swiping LEFT from the bare right screen edge; closed by dragging the panel
 * right past a third of its width, tapping the scrim, the × button, or system Back.
 */
@Composable
fun CitationsDrawer(
    open: Boolean,
    citations: List<AgentCitation>,
    catalog: SourceCatalog,
    onClose: () -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpen: () -> Unit = {},
    modifier: Modifier = Modifier,
    progressOverride: Float? = null,
    records: List<AgentTrailRecord> = emptyList(),
) {
    val scope = rememberCoroutineScope()
    val anim = remember { Animatable(if (open) 1f else 0f) }
    // When the caller pins `progressOverride` (screenshot freezing) the slide animation is
    // skipped entirely — a pending Animatable would keep Compose non-idle and stall a
    // single-frame capture. Live usage leaves it null and animates open/close.
    if (progressOverride == null) {
        LaunchedEffect(open) {
            anim.animateTo(if (open) 1f else 0f, openCloseTween)
        }
    }

    BackHandler(enabled = open) { onClose() }

    // The unified Timeline event list — one row per document the agent explicitly cited
    // (annotate) plus each directly-cited record. Single source of truth for both the
    // Timeline content and the sticky-tab strip.
    val events = remember(citations, records) {
        AgentTimelineBuilder.buildUnifiedTimeline(citations, records)
    }
    val annotations = remember(citations) { AgentTrailAnnotations.from(citations) }

    Box(modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val density = LocalDensity.current
            val panelW = maxWidth * WIDTH_FRACTION
            val panelWpx = with(density) { panelW.toPx() }
            val panelHpx = with(density) { maxHeight.toPx() }

            // Live drag offset (px), driven directly while a horizontal-close drag is in
            // flight; folded back into the open/close progress on release.
            var dragOffset by remember { mutableFloatStateOf(0f) }
            val restingOffsetPx = (1f - (progressOverride ?: anim.value)) * panelWpx
            val offsetPx = (restingOffsetPx + dragOffset).coerceIn(0f, panelWpx)
            val progress = if (panelWpx > 0f) (panelWpx - offsetPx) / panelWpx else 0f

            // Per-event anchor frame, reported by each Timeline row in the drawer-root
            // coordinate space. Merged across recompositions so a brief un-render/re-render
            // (offscreen scroll) doesn't make tabs blink. The panel content is laid out at
            // ALL times (offset off-screen when closed) so these frames exist from the first
            // frame, which is what lets the closed-state tabs anchor to their rows.
            val eventFrames = remember { mutableStateMapOf<Int, EventFrame>() }
            var rootCoords by remember { mutableStateOf<LayoutCoordinates?>(null) }
            // The scrolling viewport's own coordinates + height. Each row reports its top/bottom
            // Y relative to this viewport so a row scrolled out the top (negative Y) or past the
            // bottom (Y > height) drops its tab and rolls into the "+N" pill — exactly as iOS
            // gates on `scrollMinY < scrollHeight && scrollMaxY > 0`. The coordinates live in a
            // non-reactive holder (only read inside the per-row layout callback, never during
            // composition) so reassigning them every layout pass can't spin the recompose loop;
            // only the height — read in composition to drive tab visibility — is snapshot state.
            val scrollCoordsHolder = remember { arrayOfNulls<LayoutCoordinates>(1) }
            var scrollHeightPx by remember { mutableFloatStateOf(0f) }

            val tabAnchorOffsetPx = with(density) { TRAIL_TAB_ANCHOR_OFFSET.toPx() }
            val tabZoneBottomReservePx = with(density) {
                (OverflowPillBottomInset + OverflowPillHeight + StickyTabHeight / 2 + 8.dp).toPx()
            }
            val tabZoneBottomY = panelHpx - tabZoneBottomReservePx

            val shownIndices = remember(eventFrames.toMap(), tabZoneBottomY, scrollHeightPx) {
                eventFrames.filter { (_, f) -> isTabShown(f, scrollHeightPx, tabZoneBottomY) }.keys
            }
            val overflowCount = overflowBelowCount(eventFrames, events.size, scrollHeightPx, tabZoneBottomY)

            Box(
                Modifier
                    .fillMaxSize()
                    .onGloballyPositioned { rootCoords = it },
            ) {
                // 1. Scrim — dims/closes the conversation behind. Only hit-testable when shown.
                if (progress > 0.001f) {
                    Box(
                        Modifier
                            .fillMaxSize()
                            .background(Color.Black.copy(alpha = 0.45f * progress))
                            .pointerInput(Unit) { detectTapGestures { onClose() } },
                    )
                }

                // 2. Bare-edge swipe strip — a leftward swipe anywhere on the right edge
                //    opens the drawer. It is composed below the tabs and overflow pill so their
                //    overlapping tap targets win hit testing. The exclusion lets this narrow
                //    target win over gesture-navigation Back. Only mounted while closed.
                if (!open) {
                    Box(
                        Modifier
                            .align(Alignment.CenterEnd)
                            .fillMaxHeight()
                            .width(20.dp)
                            .systemGestureExclusion()
                            .timelineOpenSwipe(onOpen),
                    )
                }

                // 3. Sticky-tab layer — a sibling LEFT of the panel (not an overlay inside it)
                //    so tabs can extend past the panel's leading edge into the scrim. Sits
                //    BELOW the panel in z-order: a tab at its tucked X is physically covered
                //    by the panel surface, and sliding it left "emerges" it from behind the
                //    border. Translated right by `offsetPx` so it rides the panel slide.
                StickyTabLayer(
                    events = events,
                    frames = eventFrames,
                    shownIndices = shownIndices,
                    catalog = catalog,
                    progress = progress,
                    panelWpx = panelWpx,
                    offsetPx = offsetPx,
                    onTap = { if (open) onClose() else onOpen() },
                    onSwipeOpen = if (open) null else onOpen,
                )

                // 4. Panel — pinned to the trailing edge, translated right by `offsetPx`.
                //    ALWAYS laid out (even fully closed) so its rows report anchor frames.
                Box(
                    Modifier
                        .width(panelW)
                        .fillMaxHeight()
                        .align(Alignment.CenterEnd)
                        .offset { IntOffset(offsetPx.roundToInt(), 0) }
                        .background(OmTheme.colors.bgPrimary)
                        .let { base ->
                            if (progress > 0.01f) {
                                base.pointerInput(panelWpx) {
                                    // Drag-to-close: accumulate rightward travel, snap closed
                                    // past a third of the panel width.
                                    var totalX = 0f
                                    detectHorizontalDragGestures(
                                        onDragStart = { totalX = 0f; dragOffset = 0f },
                                        onHorizontalDrag = { _, dx ->
                                            totalX += dx
                                            dragOffset = totalX.coerceAtLeast(0f)
                                        },
                                        onDragEnd = {
                                            if (totalX > panelWpx / 3f) {
                                                dragOffset = 0f
                                                onClose()
                                            } else {
                                                scope.launch {
                                                    anim.snapTo(progress)
                                                    dragOffset = 0f
                                                    anim.animateTo(1f, openCloseTween)
                                                }
                                            }
                                            totalX = 0f
                                        },
                                        onDragCancel = { dragOffset = 0f; totalX = 0f },
                                    )
                                }
                            } else {
                                base
                            }
                        },
                ) {
                    // 1dp leading-edge highlight — a light catch on the panel edge.
                    Box(
                        Modifier
                            .fillMaxHeight()
                            .width(1.dp)
                            .align(Alignment.CenterStart)
                            .background(OmTheme.colors.borderLight),
                    )
                    Column(Modifier.fillMaxSize()) {
                        TimelineHeader(
                            subtitle = timelineSubtitle(events),
                            onClose = onClose,
                        )
                        if (events.isEmpty()) {
                            DrawerEmptyState()
                        } else {
                            Column(
                                Modifier
                                    .fillMaxSize()
                                    .verticalScroll(rememberScrollState())
                                    .onGloballyPositioned {
                                        scrollCoordsHolder[0] = it
                                        if (scrollHeightPx != it.size.height.toFloat()) {
                                            scrollHeightPx = it.size.height.toFloat()
                                        }
                                    },
                            ) {
                                TrailTimeline(
                                    events = events,
                                    annotations = annotations,
                                    catalog = catalog,
                                    onOpenDocument = onOpenDocument,
                                    modifier = Modifier.padding(
                                        start = OmTheme.spacing.sm,
                                        end = OmTheme.spacing.sm,
                                        top = OmTheme.spacing.sm,
                                    ),
                                    onEventFrame = { idx, coords ->
                                        val root = rootCoords ?: return@TrailTimeline
                                        val scroll = scrollCoordsHolder[0] ?: return@TrailTimeline
                                        if (!coords.isAttached || !root.isAttached || !scroll.isAttached) {
                                            return@TrailTimeline
                                        }
                                        // Y of the row's top edge in the drawer-root space.
                                        // The sticky-tab layer applies the same horizontal
                                        // slide as the panel, so only Y matters for anchoring.
                                        val topInRoot = root.localPositionOf(coords, Offset.Zero).y
                                        val anchorY = topInRoot + tabAnchorOffsetPx
                                        // Row top/bottom relative to the scroll viewport's top
                                        // edge — the in-viewport gate. A row scrolled above the
                                        // viewport reads negative; one scrolled below reads
                                        // greater than the viewport height.
                                        val scrollMinY = scroll.localPositionOf(coords, Offset.Zero).y
                                        val scrollMaxY = scrollMinY + coords.size.height.toFloat()
                                        // Write only on a real change. `onGloballyPositioned`
                                        // fires every layout pass; a SnapshotStateMap put always
                                        // invalidates, so an unconditional write would loop
                                        // recompose -> relayout -> re-report and never idle
                                        // (which hangs Roborazzi's frame pump under inspection).
                                        val prev = eventFrames[idx]
                                        if (prev == null ||
                                            abs(prev.anchorY - anchorY) > 0.5f ||
                                            abs(prev.scrollMinY - scrollMinY) > 0.5f ||
                                            abs(prev.scrollMaxY - scrollMaxY) > 0.5f
                                        ) {
                                            eventFrames[idx] = EventFrame(
                                                anchorY = anchorY,
                                                scrollMinY = scrollMinY,
                                                scrollMaxY = scrollMaxY,
                                            )
                                        }
                                    },
                                )
                                Spacer(Modifier.height(OmTheme.spacing.lg + 34.dp))
                            }
                        }
                    }
                }

                // 5. "+N" overflow pill — topmost sibling so it stays hit-testable even when
                //    the panel's hit testing is disabled (closed state). Anchored to the
                //    panel's bottom-leading edge, fading out as the panel opens.
                if (overflowCount > 0) {
                    OverflowPill(
                        count = overflowCount,
                        onTap = { if (open) onClose() else onOpen() },
                        onSwipeOpen = if (open) null else onOpen,
                        modifier = Modifier
                            .align(Alignment.BottomEnd)
                            .padding(bottom = OverflowPillBottomInset)
                            .offset {
                                IntOffset(
                                    x = (-panelWpx + offsetPx + with(density) { TabIntoPanelOverlap.toPx() }).roundToInt(),
                                    y = 0,
                                )
                            },
                    )
                }

            }
        }
    }
}

private val openCloseTween = tween<Float>(
    durationMillis = 400,
    easing = CubicBezierEasing(0.16f, 1f, 0.3f, 1f),
)

private const val WIDTH_FRACTION = 0.916f

/** Header: "Timeline" title + "N events · K sources" subtitle + × close button. */
@Composable
private fun TimelineHeader(subtitle: String, onClose: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(OmTheme.colors.bgPrimary)
            .padding(
                start = OmTheme.spacing.md,
                end = OmTheme.spacing.md,
                top = OmTheme.spacing.sm,
                bottom = OmTheme.spacing.md,
            ),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "Timeline",
                style = MaterialTheme.typography.titleLarge,
                color = OmTheme.colors.textPrimary,
            )
            if (subtitle.isNotEmpty()) {
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall.copy(
                        fontWeight = FontWeight.Normal,
                        fontSize = 11.sp,
                    ),
                    color = OmTheme.colors.textMuted.copy(alpha = 0.85f),
                )
            }
        }
        Box(
            Modifier
                .size(28.dp)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClickLabel = "Close timeline",
                    onClick = onClose,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Outlined.Close,
                contentDescription = null,
                tint = OmTheme.colors.textSecondary,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}

/** Empty state — connected-graph glyph + copy, shown before the agent references anything. */
@Composable
private fun DrawerEmptyState() {
    Column(
        Modifier.fillMaxSize().padding(top = 72.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Top,
    ) {
        // Reuse the timeline's own connected-triangle glyph so the empty state matches iOS.
        ConnectedTriangleGlyph(tint = OmTheme.colors.textMuted, size = 36.dp)
        Spacer(Modifier.height(8.dp))
        Text(
            "The agent has not referenced any document yet.",
            style = MaterialTheme.typography.bodySmall,
            color = OmTheme.colors.textSecondary,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 24.dp),
        )
    }
}

/** "N events · K sources" sub-line, pluralised; empty when there are no events. */
private fun timelineSubtitle(events: List<AgentTrailEvent>): String {
    if (events.isEmpty()) return ""
    val n = events.size
    val sources = events
        .flatMap { e -> listOfNotNull(e.eventSourceId) + e.attachments.mapNotNull { it.doc?.sourceId } }
        .map { it.substringBefore(':') }
        .toSet()
        .size
    val eventWord = if (n == 1) "event" else "events"
    val sourceWord = if (sources == 1) "source" else "sources"
    return "$n $eventWord · $sources $sourceWord"
}

// ── Sticky-tab / overflow-pill geometry — mirrors the iOS constants ──────────────────────
private val StickyTabWidth = 28.dp
private val StickyTabHeight = 38.dp
private val StickyTabIcon = 16.dp
/** How far each tab tucks INTO the panel surface past the panel's leading edge. */
private val TabIntoPanelOverlap = 2.dp
/** Extra rightward shift applied when the panel is open so tabs mostly hide, leaving a
 *  ~few-dp sliver peeking out. Mirrors iOS `tabOpenTuck`. */
private val TabOpenTuck = 22.dp
private val OverflowPillWidth = 36.dp
private val OverflowPillHeight = 28.dp
private val OverflowPillBottomInset = 28.dp
private val TimelineOpenDistance = 50.dp
private val TimelineOpenVerticalTolerance = 60.dp

/**
 * The same left-swipe recognizer is installed on the bare edge and on every affordance that
 * overlaps it. Without that, a visible tab wins hit testing but only understands taps, making
 * the most natural place to begin the swipe a dead zone.
 */
private fun Modifier.timelineOpenSwipe(onOpen: () -> Unit): Modifier = composed {
    val density = LocalDensity.current
    val distancePx = with(density) { TimelineOpenDistance.toPx() }
    val verticalTolerancePx = with(density) { TimelineOpenVerticalTolerance.toPx() }
    pointerInput(onOpen, distancePx, verticalTolerancePx) {
        var totalX = 0f
        var totalY = 0f
        detectHorizontalDragGestures(
            onDragStart = { totalX = 0f; totalY = 0f },
            onHorizontalDrag = { change, dx ->
                totalX += dx
                totalY += change.positionChange().y
                change.consume()
            },
            onDragEnd = {
                if (totalX < -distancePx && abs(totalY) < verticalTolerancePx) onOpen()
                totalX = 0f; totalY = 0f
            },
            onDragCancel = { totalX = 0f; totalY = 0f },
        )
    }
}

/**
 * One frame snapshot for an event row. [anchorY] is the Y (in the drawer-root coordinate
 * space, i.e. the panel's own space since the layer applies the same horizontal slide) where
 * the sticky tab should sit — the centre of the event's source-icon dot. [scrollMinY] /
 * [scrollMaxY] are the row's top / bottom Y relative to the scroll viewport's top edge,
 * driving the in-viewport visibility gate. Mirrors iOS `CardFrame`.
 */
private data class EventFrame(
    val anchorY: Float,
    val scrollMinY: Float,
    val scrollMaxY: Float,
)

/**
 * Whether a given event row's tab should currently render. Two conditions, both required —
 * the row's frame intersects the scroll viewport (otherwise the card itself isn't visible),
 * and the tab's vertical anchor sits above the reserved overflow-pill zone at the bottom of
 * the panel (otherwise it would overlap the pill). Mirrors iOS `isShown`.
 */
private fun isTabShown(frame: EventFrame, scrollHeight: Float, tabZoneBottomY: Float): Boolean {
    if (scrollHeight <= 0f) return false
    val inViewport = frame.scrollMinY < scrollHeight && frame.scrollMaxY > 0f
    val inTabZone = frame.anchorY < tabZoneBottomY
    return inViewport && inTabZone
}

/**
 * Number of event rows whose card sits below the last shown tab — either scrolled past the
 * bottom of the viewport or inside the bottom strip reserved for the pill. Walking from the
 * highest in-viewport shown index forward captures both cases: every later row either hasn't
 * laid out a tab (so by construction it's below the rendered window) or its anchor falls in
 * the pill zone. Mirrors iOS `overflowBelowCount`.
 */
private fun overflowBelowCount(
    frames: Map<Int, EventFrame>,
    totalRows: Int,
    scrollHeight: Float,
    tabZoneBottomY: Float,
): Int {
    if (totalRows <= 0) return 0
    if (scrollHeight <= 0f) return totalRows
    val shown = frames.filter { (_, f) -> isTabShown(f, scrollHeight, tabZoneBottomY) }.keys
    val lastShown = shown.maxOrNull() ?: -1
    return (totalRows - 1 - lastShown).coerceAtLeast(0)
}

/**
 * The sticky-tab layer. Each visible tab is positioned at its event row's anchor Y (clamped
 * into the tab zone) and translated right by `offsetPx + progress*tuck` so it rides the panel
 * slide and tucks behind the panel edge when open, leaving only a sliver peeking. Sits to the
 * LEFT of the panel: a tab's leading edge lands at the panel's leading edge minus its visible
 * width, so it reads as a bookmark peeking past the border.
 */
@Composable
private fun StickyTabLayer(
    events: List<AgentTrailEvent>,
    frames: SnapshotStateMap<Int, EventFrame>,
    shownIndices: Set<Int>,
    catalog: SourceCatalog,
    progress: Float,
    panelWpx: Float,
    offsetPx: Float,
    onTap: () -> Unit,
    onSwipeOpen: (() -> Unit)?,
) {
    val density = LocalDensity.current
    val tabWidthPx = with(density) { StickyTabWidth.toPx() }
    val tabHeightPx = with(density) { StickyTabHeight.toPx() }
    val intoOverlapPx = with(density) { TabIntoPanelOverlap.toPx() }
    val openTuckPx = with(density) { TabOpenTuck.toPx() }

    Box(Modifier.fillMaxSize()) {
        events.forEachIndexed { idx, event ->
            if (idx !in shownIndices) return@forEachIndexed
            val frame = frames[idx] ?: return@forEachIndexed
            // Children align to TopEnd, so a child's RIGHT edge sits at the root's right edge
            // and a negative `offset.x` shifts it left. The panel's leading (left) edge in
            // root space sits `panelWpx` from the right edge, minus its current slide
            // `offsetPx`. A tab's trailing (right) edge tucks `TabIntoPanelOverlap` past that
            // leading edge; when the panel opens it slides a further `TabOpenTuck` rightward
            // so it ends up mostly hidden behind the panel. So the displacement of the tab's
            // right edge from the root's right edge is:
            val xOffset = (-(panelWpx - offsetPx) + intoOverlapPx + progress * openTuckPx).roundToInt()
            val yOffset = (frame.anchorY - tabHeightPx / 2f).roundToInt()
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .offset { IntOffset(x = xOffset, y = yOffset) },
            ) {
                StickyTab(
                    event = event,
                    catalog = catalog,
                    onTap = onTap,
                    onSwipeOpen = onSwipeOpen,
                )
            }
        }
    }
}

/**
 * A single sticky tab — a 28×38 left-rounded sliver carrying the source icon. The fill is
 * the source brand colour in DARK mode (telegraphing the source) but pure `bgPrimary` (white)
 * in LIGHT mode, where the source brand chips would read as dark blocks; there it lifts off
 * the page through a soft drop shadow instead, and the colour cue comes from the source logo.
 */
@Composable
private fun StickyTab(
    event: AgentTrailEvent,
    catalog: SourceCatalog,
    onTap: () -> Unit,
    onSwipeOpen: (() -> Unit)?,
) {
    val shape = RoundedCornerShape(topStart = 10.dp, bottomStart = 10.dp)
    val isDark = OmTheme.colors.isDark
    val fill = if (!isDark) {
        OmTheme.colors.bgPrimary
    } else {
        event.eventSourceId?.let { catalog.bgColor(it) } ?: OmTheme.colors.bgTertiary
    }
    val shadowElevation = if (isDark) 2.dp else 3.dp
    Box(
        Modifier
            .size(width = StickyTabWidth, height = StickyTabHeight)
            // The tab sits in the right-edge gesture-nav zone; without this the OS treats a
            // press here as a Back swipe and the tap never reaches `clickable`. Excluding the
            // tab's own bounds (well under the 200dp/edge cap) hands the OS-owned strip to us.
            .systemGestureExclusion()
            .shadow(shadowElevation, shape)
            .clip(shape)
            .background(fill)
            .testTag("timelineStickyTab")
            .then(if (onSwipeOpen != null) Modifier.timelineOpenSwipe(onSwipeOpen) else Modifier)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = "Open timeline",
                onClick = onTap,
            ),
        contentAlignment = Alignment.CenterStart,
    ) {
        SourceIcon(
            model = catalog.iconModel(event.eventSourceId.orEmpty()),
            size = StickyTabIcon,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

/** "+N" counter pill peeking from the panel's bottom-leading edge when tabs overflow. */
@Composable
private fun OverflowPill(
    count: Int,
    onTap: () -> Unit,
    onSwipeOpen: (() -> Unit)?,
    modifier: Modifier,
) {
    val shape = RoundedCornerShape(topStart = 8.dp, bottomStart = 8.dp)
    Box(
        modifier
            .size(width = OverflowPillWidth, height = OverflowPillHeight)
            // Same right-edge gesture-nav exclusion as the sticky tabs: keep the OS Back swipe
            // from eating taps on the pill.
            .systemGestureExclusion()
            .shadow(3.dp, shape)
            .clip(shape)
            .background(OmTheme.colors.bgTertiary)
            .testTag("timelineOverflowPill")
            .then(if (onSwipeOpen != null) Modifier.timelineOpenSwipe(onSwipeOpen) else Modifier)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = "Open timeline",
                onClick = onTap,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "+$count",
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
            color = OmTheme.colors.textSecondary,
        )
    }
}
