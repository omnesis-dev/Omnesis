// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AutomaticPagingBoundaryTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun requests_each_cursor_once_only_after_the_boundary_is_visible() {
        var requests = 0
        var paging by mutableStateOf(CursorPagingState(nextCursor = "page-2"))

        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                val listState = rememberLazyListState()
                LazyColumn(
                    state = listState,
                    modifier = Modifier.height(120.dp).testTag("paging-list"),
                ) {
                    items((1..20).toList()) { index ->
                        Text(
                            "Invented row $index",
                            modifier = Modifier.testTag("row-$index"),
                        )
                    }
                    item("paging") {
                        ListPagingFooter(
                            listState = listState,
                            boundaryKey = "paging",
                            paging = paging,
                            loadAction = "more invented rows",
                            onLoadMore = {
                                requests += 1
                                paging = paging.copy(isLoadingMore = true)
                            },
                        )
                    }
                }
            }
        }

        compose.runOnIdle { assertEquals(0, requests) }
        compose.onNodeWithTag("paging-list").performScrollToIndex(20)
        compose.waitUntil { requests == 1 }

        compose.runOnIdle {
            paging = paging.copy(isLoadingMore = false)
        }
        compose.runOnIdle { assertEquals(1, requests) }

        compose.runOnIdle {
            paging = paging.copy(nextCursor = "page-3")
        }
        compose.onNodeWithTag("paging-list").performScrollToIndex(20)
        compose.waitUntil { requests == 2 }
    }

    @Test
    fun a_failed_page_never_retries_automatically_and_exposes_retry() {
        var requests = 0
        val paging = CursorPagingState(
            nextCursor = "page-2",
            paginationError = IllegalStateException("offline"),
        )

        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                val listState = rememberLazyListState()
                LazyColumn(state = listState) {
                    item("paging") {
                        ListPagingFooter(
                            listState = listState,
                            boundaryKey = "paging",
                            paging = paging,
                            loadAction = "more invented rows",
                            onLoadMore = { requests += 1 },
                        )
                    }
                }
            }
        }

        compose.runOnIdle { assertEquals(0, requests) }
        compose.onNodeWithText("Couldn't load more invented rows.").assertIsDisplayed()
        compose.onNodeWithText("Retry loading more invented rows").performClick()
        compose.runOnIdle { assertEquals(1, requests) }
    }
}
