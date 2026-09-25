// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.RecentItemsResponse
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.Loadable
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class SourceRecentPagingUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun empty_loaded_page_requests_its_next_page_without_showing_a_button() {
        var pageRequests = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                SourceRecentContent(
                    title = "Notes",
                    state = Loadable.Content(RecentItemsResponse.Documents()),
                    onBack = {},
                    onRetry = {},
                    onOpenDocument = {},
                    paging = CursorPagingState(nextCursor = "next-page"),
                    onLoadMore = { pageRequests += 1 },
                )
            }
        }

        compose.waitUntil { pageRequests == 1 }
        compose.onNodeWithText("Load more documents").assertDoesNotExist()
        compose.onNodeWithText("No recent items yet").assertDoesNotExist()
    }
}
