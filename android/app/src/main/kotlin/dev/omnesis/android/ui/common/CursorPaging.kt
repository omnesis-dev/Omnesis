// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme

/**
 * Immutable request ownership for one cursor-paginated list.
 *
 * Domain items stay in their owning screen state. This value owns only the
 * cursor and request lifecycle, so the same race rules work for ordinary
 * arrays, tagged source-recent responses, complete merge clusters, and
 * transcript pages prepended at the top.
 */
data class CursorPagingState(
    val nextCursor: String? = null,
    val isRefreshing: Boolean = false,
    val isLoadingMore: Boolean = false,
    val refreshError: Throwable? = null,
    val paginationError: Throwable? = null,
    /**
     * True when paging stopped defensively before the server proved that the
     * collection was exhausted (for example, a repeated cursor or a page that
     * contained no new stable ids). Counts must remain qualified in this state.
     */
    val stoppedBeforeEnd: Boolean = false,
    private val generation: Long = 0,
) {
    class Request internal constructor(
        internal val generation: Long,
        val cursor: String?,
        internal val phase: Phase,
    )

    internal enum class Phase { REFRESH, MORE }

    data class Started(val state: CursorPagingState, val request: Request)

    val canLoadMore: Boolean get() = normalized(nextCursor) != null
    val countIsPartial: Boolean get() = canLoadMore || stoppedBeforeEnd
    /**
     * True only when the server has conclusively proved that no later page
     * exists. Empty-state copy must stay hidden while absence is still
     * unproven by a cursor, an in-flight request, an error, or a defensive
     * pagination stop.
     */
    val canShowDefinitiveEmpty: Boolean
        get() =
            !canLoadMore &&
                !isRefreshing &&
                !isLoadingMore &&
                refreshError == null &&
                paginationError == null &&
                !stoppedBeforeEnd
    internal val automaticLoadToken: AutomaticPagingToken?
        get() = normalized(nextCursor)?.let { AutomaticPagingToken(generation, it) }

    /** Invalidates every older refresh/page request and starts a first-page load. */
    fun beginRefresh(): Started {
        val nextGeneration = generation + 1
        return Started(
            copy(
                nextCursor = null,
                isRefreshing = true,
                isLoadingMore = false,
                refreshError = null,
                paginationError = null,
                stoppedBeforeEnd = false,
                generation = nextGeneration,
            ),
            Request(nextGeneration, cursor = null, phase = Phase.REFRESH),
        )
    }

    /** Starts exactly one request for the current cursor. */
    fun beginLoadMore(): Started? {
        val cursor = normalized(nextCursor) ?: return null
        if (isRefreshing || isLoadingMore) return null
        return Started(
            copy(isLoadingMore = true, paginationError = null),
            Request(generation, cursor, Phase.MORE),
        )
    }

    fun owns(request: Request): Boolean =
        request.generation == generation &&
            when (request.phase) {
                Phase.REFRESH -> isRefreshing
                Phase.MORE -> isLoadingMore && request.cursor == normalized(nextCursor)
            }

    fun finishRefresh(request: Request, nextCursor: String?): CursorPagingState =
        if (request.phase == Phase.REFRESH && owns(request)) {
            copy(
                nextCursor = normalized(nextCursor),
                isRefreshing = false,
                refreshError = null,
                paginationError = null,
                stoppedBeforeEnd = false,
            )
        } else {
            this
        }

    fun failRefresh(request: Request, error: Throwable? = null): CursorPagingState =
        if (request.phase == Phase.REFRESH && owns(request)) {
            copy(
                isRefreshing = false,
                refreshError = error,
                paginationError = null,
                stoppedBeforeEnd = false,
            )
        } else {
            this
        }

    /**
     * Completes a next-page request. A repeated cursor or a page that added no
     * stable item is exhausted deliberately: an older gateway that ignores
     * `cursor` must not offer an infinite pagination loop.
     */
    fun finishLoadMore(
        request: Request,
        nextCursor: String?,
        madeProgress: Boolean = true,
    ): CursorPagingState {
        if (request.phase != Phase.MORE || !owns(request)) return this
        val normalized = normalized(nextCursor)
        val stoppedBeforeEnd =
            normalized != null && (!madeProgress || normalized == request.cursor)
        val safeCursor = if (stoppedBeforeEnd) null else normalized
        return copy(
            nextCursor = safeCursor,
            isLoadingMore = false,
            paginationError = null,
            stoppedBeforeEnd = stoppedBeforeEnd,
        )
    }

    fun failLoadMore(request: Request, error: Throwable): CursorPagingState =
        if (request.phase == Phase.MORE && owns(request)) {
            copy(isLoadingMore = false, paginationError = error)
        } else {
            this
        }

    /** Invalidates every in-flight request and optionally seeds a cursor. */
    fun reset(nextCursor: String? = null): CursorPagingState =
        CursorPagingState(nextCursor = normalized(nextCursor), generation = generation + 1)

    private fun normalized(cursor: String?): String? = cursor?.takeIf { it.isNotBlank() }
}

internal data class AutomaticPagingToken(
    val generation: Long,
    val cursor: String,
)

/** Append a page while preserving order and rejecting already-loaded stable ids. */
fun <T, K> appendUnique(
    current: List<T>,
    incoming: List<T>,
    key: (T) -> K,
): List<T> {
    val seen = current.mapTo(mutableSetOf(), key)
    return current + incoming.filter { seen.add(key(it)) }
}

/** Prepend a page while preserving both the incoming and current order. */
fun <T, K> prependUnique(
    current: List<T>,
    incoming: List<T>,
    key: (T) -> K,
): List<T> {
    val seen = current.mapTo(mutableSetOf(), key)
    return incoming.filter { seen.add(key(it)) } + current
}

/**
 * Convert a visible item's viewport offset to LazyListState.scrollToItem's
 * scroll offset while preserving both partially clipped (negative) and
 * partially inset (positive) anchors exactly.
 */
fun prependAnchorScrollOffset(itemViewportOffset: Int): Int = -itemViewportOffset

/**
 * Owns one pending viewport anchor across an asynchronous prepend.
 *
 * The captured anchor is tied to the next accepted prepend version. A delayed
 * response rejected by request ownership never advances that version and
 * therefore cannot move the viewport later.
 */
internal class PrependPagingAnchor {
    private data class Pending(
        val expectedVersion: Long,
        val key: String,
        val viewportOffset: Int,
    )

    private var pending: Pending? = null

    fun capture(
        currentVersion: Long,
        listState: LazyListState,
        eligibleKeys: Set<String>,
    ) {
        pending = null
        val anchor = listState.layoutInfo.visibleItemsInfo
            .firstOrNull { (it.key as? String) in eligibleKeys }
        (anchor?.key as? String)?.let {
            capture(
                currentVersion = currentVersion,
                key = it,
                viewportOffset = anchor.offset,
            )
        }
    }

    internal fun capture(
        currentVersion: Long,
        key: String,
        viewportOffset: Int,
    ) {
        pending = Pending(
            expectedVersion = currentVersion + 1,
            key = key,
            viewportOffset = viewportOffset,
        )
    }

    suspend fun restore(
        completedVersion: Long,
        listState: LazyListState,
        orderedKeys: List<String>,
        leadingItemCount: Int,
    ): Boolean {
        val anchor = pending ?: return false
        if (completedVersion < anchor.expectedVersion) return false
        pending = null
        if (completedVersion != anchor.expectedVersion) return false
        val index = orderedKeys.indexOf(anchor.key)
        if (index < 0) return false
        listState.scrollToItem(
            index = index + leadingItemCount,
            scrollOffset = prependAnchorScrollOffset(anchor.viewportOffset),
        )
        return true
    }
}

@Composable
internal fun rememberPrependPagingAnchor(): PrependPagingAnchor =
    remember { PrependPagingAnchor() }

/**
 * Viewport-bound pagination sentinel for a [CursorPagingState]. The owning
 * LazyColumn supplies the sentinel item's stable [boundaryKey], so merely
 * composing a prefetched item does not start a request: its key must actually
 * be in [listState]'s visible viewport.
 *
 * Each generation/cursor pair is attempted automatically at most once. A page
 * failure keeps loaded content in place and exposes an explicit Retry rather
 * than starting an automatic retry loop.
 */
@Composable
fun ListPagingFooter(
    listState: LazyListState,
    boundaryKey: String,
    paging: CursorPagingState,
    loadAction: String,
    onLoadMore: () -> Unit,
    modifier: Modifier = Modifier,
) {
    AutomaticPagingBoundary(
        listState = listState,
        boundaryKey = boundaryKey,
        loadToken = paging.automaticLoadToken,
        isLoading = paging.isLoadingMore,
        errorMessage = paging.paginationError?.let { "Couldn't load $loadAction." },
        loadingLabel = "Loading $loadAction…",
        retryLabel = "Retry loading $loadAction",
        onLoadMore = onLoadMore,
        modifier = modifier,
    )
}

/**
 * Generic viewport sentinel used by older paging contracts that do not yet
 * expose [CursorPagingState]. [loadToken] must change whenever the next page
 * changes; a repeated token is deliberately not attempted twice.
 */
@Composable
fun AutomaticPagingBoundary(
    listState: LazyListState,
    boundaryKey: String,
    loadToken: Any?,
    isLoading: Boolean,
    errorMessage: String?,
    loadingLabel: String = "Loading more…",
    retryLabel: String = "Retry loading more",
    onLoadMore: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (loadToken == null && !isLoading && errorMessage == null) return
    val c = OmTheme.colors
    val inInspection = LocalInspectionMode.current
    val latestLoadMore by rememberUpdatedState(onLoadMore)
    val boundaryVisible by remember(listState, boundaryKey) {
        derivedStateOf {
            listState.layoutInfo.visibleItemsInfo.any { item -> item.key == boundaryKey }
        }
    }
    var attemptedToken by remember { mutableStateOf<Any?>(null) }

    LaunchedEffect(boundaryVisible, loadToken, isLoading, errorMessage, inInspection) {
        if (
            !inInspection &&
            boundaryVisible &&
            loadToken != null &&
            !isLoading &&
            errorMessage == null &&
            attemptedToken != loadToken
        ) {
            attemptedToken = loadToken
            latestLoadMore()
        }
    }

    androidx.compose.foundation.layout.Column(
        modifier.fillMaxWidth().padding(vertical = OmSpacing.sm),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(OmSpacing.xs),
    ) {
        if (errorMessage != null) {
            Text(errorMessage, color = c.warning)
        }
        when {
            errorMessage != null -> OutlinedButton(
                onClick = latestLoadMore,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(retryLabel)
            }
            isLoading -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OmSpinner(Modifier.size(16.dp))
                    Spacer(Modifier.width(OmSpacing.sm))
                    Text(loadingLabel)
                }
            }
            else -> Spacer(Modifier.size(1.dp))
        }
    }
}
