// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.unit.Velocity
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class KeyboardDismissNestedScrollConnectionTest {
    @Test
    fun downwardUserDragDismissesAfterTouchSlopWithoutConsumingScroll() {
        var dismissals = 0
        val connection = KeyboardDismissNestedScrollConnection(touchSlop = 10f) { dismissals++ }

        assertEquals(
            Offset.Zero,
            connection.onPreScroll(Offset(0f, 4f), NestedScrollSource.UserInput),
        )
        assertEquals(0, dismissals)
        assertEquals(
            Offset.Zero,
            connection.onPreScroll(Offset(0f, 6f), NestedScrollSource.UserInput),
        )
        assertEquals(1, dismissals)

        connection.onPreScroll(Offset(0f, 20f), NestedScrollSource.UserInput)
        assertEquals(1, dismissals)
    }

    @Test
    fun upwardAndNonUserScrollsDoNotDismiss() {
        var dismissals = 0
        val connection = KeyboardDismissNestedScrollConnection(touchSlop = 10f) { dismissals++ }

        connection.onPreScroll(Offset(0f, -20f), NestedScrollSource.UserInput)
        connection.onPreScroll(Offset(0f, 20f), NestedScrollSource.SideEffect)

        assertEquals(0, dismissals)
    }

    @Test
    fun reversingDirectionResetsTheAccumulatedDrag() {
        var dismissals = 0
        val connection = KeyboardDismissNestedScrollConnection(touchSlop = 10f) { dismissals++ }

        connection.onPreScroll(Offset(0f, 6f), NestedScrollSource.UserInput)
        connection.onPreScroll(Offset(0f, -1f), NestedScrollSource.UserInput)
        connection.onPreScroll(Offset(0f, 6f), NestedScrollSource.UserInput)

        assertEquals(0, dismissals)
    }

    @Test
    fun endingADragResetsThresholdAndDismissalState() = runBlocking {
        var dismissals = 0
        val connection = KeyboardDismissNestedScrollConnection(touchSlop = 10f) { dismissals++ }

        connection.onPreScroll(Offset(0f, 10f), NestedScrollSource.UserInput)
        assertEquals(Velocity.Zero, connection.onPreFling(Velocity.Zero))
        connection.onPreScroll(Offset(0f, 6f), NestedScrollSource.UserInput)
        assertEquals(1, dismissals)
        connection.onPreScroll(Offset(0f, 4f), NestedScrollSource.UserInput)

        assertEquals(2, dismissals)
    }
}
