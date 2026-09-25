// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Surface
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshState
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * Material-3 pull-to-refresh wrapper — the Android analogue of SwiftUI's `.refreshable`.
 *
 * [refreshing] is the hosting screen's own in-flight flag, and the indicator is shown for
 * exactly as long as it is true. It is deliberately not inferred from the data changing: a
 * refresh that returns what the screen already had produces a value equal to the last one,
 * `StateFlow` conflates equal values so nothing is even emitted, and an indicator waiting for
 * the data to *change* would spin forever on the most ordinary outcome there is — pulling a
 * list that is already up to date.
 *
 * [enabled] gates the gesture while a first load is still running.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PullToRefresh(
    refreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val pullState = rememberPullToRefreshState()
    val showing = refreshing && enabled

    PullToRefreshBox(
        isRefreshing = showing,
        onRefresh = { if (enabled) onRefresh() },
        state = pullState,
        modifier = modifier.fillMaxSize(),
        indicator = { PullToRefreshSpinner(state = pullState, refreshing = showing) },
    ) {
        content()
    }
}

/**
 * The disk that rides down under the finger, carrying [OmSpinner] rather than Material's own
 * indicator.
 *
 * Material's draws its arc from an `InfiniteTransition`, which honours the system animator
 * duration scale: with animations switched off the sweep collapses to a zero-length stroke and
 * the disk shows a single dot. [OmSpinner] runs off the frame clock and keeps turning.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BoxScope.PullToRefreshSpinner(state: PullToRefreshState, refreshing: Boolean) {
    val thresholdPx = with(LocalDensity.current) { PullToRefreshDefaults.PositionalThreshold.toPx() }
    // Held at the threshold while the refresh runs; tracking the finger before that.
    val progress = if (refreshing) 1f else state.distanceFraction.coerceIn(0f, 1f)
    if (progress <= 0f) return
    Surface(
        modifier = Modifier
            .align(Alignment.TopCenter)
            .size(IndicatorSize)
            .graphicsLayer { translationY = progress * thresholdPx - size.height }
            .alpha(progress),
        shape = CircleShape,
        color = OmTheme.colors.bgSecondary,
        shadowElevation = 4.dp,
    ) {
        Box(contentAlignment = Alignment.Center) {
            OmSpinner(
                modifier = Modifier.size(20.dp),
                color = OmTheme.colors.accent,
                strokeWidth = 2.dp,
            )
        }
    }
}

private val IndicatorSize = 40.dp
