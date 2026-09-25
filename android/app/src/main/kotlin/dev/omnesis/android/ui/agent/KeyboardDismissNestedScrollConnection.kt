// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.unit.Velocity

internal class KeyboardDismissNestedScrollConnection(
    private val touchSlop: Float,
    private val dismiss: () -> Unit,
) : NestedScrollConnection {
    private var downwardDrag = 0f
    private var dismissed = false

    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
        if (source != NestedScrollSource.UserInput || available.y <= 0f) {
            reset()
            return Offset.Zero
        }

        downwardDrag += available.y
        if (!dismissed && downwardDrag >= touchSlop) {
            dismissed = true
            dismiss()
        }
        return Offset.Zero
    }

    override suspend fun onPreFling(available: Velocity): Velocity {
        reset()
        return Velocity.Zero
    }

    private fun reset() {
        downwardDrag = 0f
        dismissed = false
    }
}
