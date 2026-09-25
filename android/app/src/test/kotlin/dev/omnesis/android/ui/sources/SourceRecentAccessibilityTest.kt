// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.sources

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.RecentItemsResponse
import dev.omnesis.android.ui.common.Loadable
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SourceRecentAccessibilityTest {

    @get:Rule val compose = createComposeRule()

    @Test
    fun analytics_cells_expose_their_column_and_value() {
        compose.setContent {
            OmnesisTheme {
                SourceRecentContent(
                    title = "Activities",
                    state = Loadable.Content(
                        RecentItemsResponse.Analytics(
                            table = "activities",
                            displayName = "Activities",
                            columns = listOf("distance_km"),
                            rows = listOf(listOf(JsonPrimitive(8.4))),
                        ),
                    ),
                    onBack = {},
                    onRetry = {},
                    onOpenDocument = {},
                )
            }
        }

        compose.onNodeWithContentDescription("distance_km: 8.4").fetchSemanticsNode()
    }
}
