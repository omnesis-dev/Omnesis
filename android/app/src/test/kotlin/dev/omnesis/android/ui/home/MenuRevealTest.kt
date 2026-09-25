// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reveal's decisions, exercised without an emulator or a Compose render. `MenuReveal`
 * is deliberately free of Compose so this lane can reach it; the rendering it drives is
 * covered by the Roborazzi goldens instead.
 *
 * Mirrors `ios/Tests/OmnesisTests/MenuRevealTests.swift` — the two apps are meant to move
 * the same way, so the cases are the same cases.
 */
class MenuRevealTest {
    private val width = 1080f
    private val density = 2.75f
    private val widthDp = width / density
    private val travel = MenuReveal.menuWidthPx(width, density)

    // --- Geometry ---------------------------------------------------------------

    /** A density high enough that the dp cap cannot bind, isolating the fraction. */
    private val uncappedDensity = 10f

    @Test
    fun `menu width is the travel`() {
        assertEquals(
            width * MenuReveal.OPEN_FRACTION,
            MenuReveal.menuWidthPx(width, uncappedDensity),
            0.01f,
        )
        assertEquals(0f, MenuReveal.menuWidthPx(0f, uncappedDensity), 0.01f)
    }

    /**
     * On a tablet the fraction alone would give a menu wide enough to strand a row's label
     * at one end and the Settings button at the other.
     */
    @Test
    fun `menu width is capped on a wide screen`() {
        val tablet = 2560f
        assertEquals(
            MenuReveal.MAXIMUM_MENU_WIDTH_DP * density,
            MenuReveal.menuWidthPx(tablet, density),
            0.01f,
        )
        assertTrue(MenuReveal.menuWidthPx(width, density) <= MenuReveal.MAXIMUM_MENU_WIDTH_DP * density)
    }

    /** Before first layout there is no width, and the reveal resolves to closed. */
    @Test
    fun `progress is zero without width`() {
        assertEquals(0f, MenuReveal.progress(offsetPx = 120f, travelPx = 0f), 0.001f)
    }

    @Test
    fun `progress clamps both ends`() {
        assertEquals(0f, MenuReveal.progress(-50f, travel), 0.001f)
        assertEquals(1f, MenuReveal.progress(travel * 2, travel), 0.001f)
        assertEquals(0.5f, MenuReveal.progress(travel / 2, travel), 0.001f)
    }

    @Test
    fun `offset clamps to the travel available`() {
        assertEquals(0f, MenuReveal.clampOffset(-200f, travel), 0.01f)
        assertEquals(travel, MenuReveal.clampOffset(travel + 500f, travel), 0.01f)
    }

    // --- Claiming a touch -------------------------------------------------------

    private fun classify(
        current: MenuReveal.DragMode = MenuReveal.DragMode.Undetermined,
        startX: Float = 100f,
        dx: Float = 0f,
        dy: Float = 0f,
        velocityX: Float = 0f,
        velocityY: Float = 0f,
        isOpen: Boolean = false,
        consumedByChild: Boolean = false,
    ) = MenuReveal.classifyDrag(
        current,
        startX,
        dx,
        dy,
        velocityX,
        velocityY,
        widthDp,
        isOpen,
        consumedByChild,
    )

    private fun claims(
        startX: Float = 100f,
        dx: Float = 0f,
        dy: Float = 0f,
        velocityX: Float = 0f,
        velocityY: Float = 0f,
        isOpen: Boolean = false,
        consumedByChild: Boolean = false,
    ) = classify(
        startX = startX,
        dx = dx,
        dy = dy,
        velocityX = velocityX,
        velocityY = velocityY,
        isOpen = isOpen,
        consumedByChild = consumedByChild,
    ) == MenuReveal.DragMode.Horizontal

    @Test
    fun `rightward drag while closed reveals the menu`() {
        assertTrue(claims(dx = 80f, dy = 10f))
    }

    @Test
    fun `leftward drag while open hides the menu`() {
        assertTrue(claims(dx = -80f, dy = 10f, isOpen = true))
    }

    /** A drag only ever moves the menu towards its *other* state. */
    @Test
    fun `drag away from the other state is not claimed`() {
        assertFalse(claims(dx = -80f, dy = 10f))
        assertFalse(claims(dx = 80f, dy = 10f, isOpen = true))
        assertEquals(MenuReveal.DragMode.Undetermined, classify(dx = -80f, dy = 10f))
    }

    @Test
    fun `wrong-way wobble can reverse into the valid direction`() {
        val wobble = classify(dx = -20f, velocityX = -250f)
        assertEquals(MenuReveal.DragMode.Undetermined, wobble)
        assertEquals(
            MenuReveal.DragMode.Horizontal,
            classify(current = wobble, dx = 30f, velocityX = 300f),
        )
    }

    @Test
    fun `too short is not claimed`() {
        assertFalse(claims(dx = MenuReveal.DISTANCE_THRESHOLD_DP - 1f))
    }

    @Test
    fun `short fast flick is claimed from velocity`() {
        assertTrue(claims(dx = 2f, velocityX = MenuReveal.AXIS_VELOCITY_DP_PER_SEC + 1f))
        assertTrue(
            claims(
                dx = -2f,
                velocityX = -MenuReveal.AXIS_VELOCITY_DP_PER_SEC - 1f,
                isOpen = true,
            ),
        )
    }

    @Test
    fun `vertical classification is terminal`() {
        val yielded = classify(dy = 30f, velocityY = 300f)
        assertEquals(MenuReveal.DragMode.Yielded, yielded)
        assertEquals(
            MenuReveal.DragMode.Yielded,
            classify(current = yielded, dx = 100f, velocityX = 1_000f),
        )
    }

    @Test
    fun `ambiguous diagonal remains undetermined`() {
        assertEquals(
            MenuReveal.DragMode.Undetermined,
            classify(dx = 20f, dy = 18f),
        )
    }

    @Test
    fun `distance direction wins over non-dominant velocity wobble`() {
        assertEquals(
            MenuReveal.DragMode.Horizontal,
            classify(dx = 30f, dy = 2f, velocityX = -200f, velocityY = 180f),
        )
    }

    @Test
    fun `diagonal drag fails axis dominance`() {
        assertFalse(claims(dx = 60f, dy = 55f))
    }

    /**
     * The trailing band is held clear so it belongs unambiguously to the Timeline's own
     * edge gesture.
     */
    @Test
    fun `drag from the trailing band is left alone`() {
        assertFalse(claims(startX = widthDp * 0.85f, dx = 80f))
        assertTrue(claims(startX = widthDp * 0.75f, dx = 80f))
        assertEquals(
            MenuReveal.DragMode.Undetermined,
            classify(startX = widthDp * 0.85f, dx = 80f),
        )
    }

    /**
     * The whole point of the pass-and-consumption check: something nearer the finger — a
     * horizontally scrolling rail, a row moving its swipe actions — already claimed this
     * drag, and claiming it again would move both at once.
     */
    @Test
    fun `a drag a child already consumed is left alone`() {
        assertTrue(claims(dx = 80f))
        assertFalse(claims(dx = 80f, consumedByChild = true))
    }

    /** Closing is not gated on where the touch began. */
    @Test
    fun `closing ignores the start location gate`() {
        assertTrue(claims(startX = widthDp * 0.95f, dx = -80f, isOpen = true))
    }

    // --- Where a released drag settles ------------------------------------------

    @Test
    fun `flick decides on direction alone`() {
        assertTrue(MenuReveal.shouldOpen(MenuReveal.FLICK_VELOCITY_DP_PER_SEC + 1f, 1f, travel, isOpen = false))
        assertFalse(MenuReveal.shouldOpen(-MenuReveal.FLICK_VELOCITY_DP_PER_SEC - 1f, -1f, travel, isOpen = true))
    }

    @Test
    fun `slow release commits only past a third of the travel`() {
        val third = travel * MenuReveal.COMMIT_FRACTION
        assertFalse(MenuReveal.shouldOpen(0f, third, travel, isOpen = false))
        assertTrue(MenuReveal.shouldOpen(0f, third + 1f, travel, isOpen = false))
        // Closing reads the same way.
        assertTrue(MenuReveal.shouldOpen(0f, -third + 1f, travel, isOpen = true))
        assertFalse(MenuReveal.shouldOpen(0f, -third, travel, isOpen = true))
    }

    @Test
    fun `small nudge snaps back`() {
        assertFalse(MenuReveal.shouldOpen(30f, 20f, travel, isOpen = false))
        assertTrue(MenuReveal.shouldOpen(-30f, -20f, travel, isOpen = true))
    }

    @Test
    fun `only a committed swipe gets physical feedback`() {
        assertTrue(MenuReveal.committedStateChanged(fromOpen = false, toOpen = true))
        assertTrue(MenuReveal.committedStateChanged(fromOpen = true, toOpen = false))
        assertFalse(MenuReveal.committedStateChanged(fromOpen = false, toOpen = false))
        assertFalse(MenuReveal.committedStateChanged(fromOpen = true, toOpen = true))
    }
}
