// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Text
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PrependPagingAnchorTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun transcript_prepend_preserves_the_visible_turn() {
        assertPatternPreservesAnchor(leadingItemCount = 1)
    }

    @Test
    fun privacy_exchange_prepend_preserves_the_visible_exchange() {
        assertPatternPreservesAnchor(leadingItemCount = 2)
    }

    @Test
    fun privacy_audit_prepend_preserves_the_visible_event() {
        assertPatternPreservesAnchor(leadingItemCount = 2)
    }

    @Test
    fun delayed_response_from_a_stale_version_cannot_restore_an_anchor() = runTest {
        val anchor = PrependPagingAnchor()
        anchor.capture(
            currentVersion = 4,
            key = "invented-row-12",
            viewportOffset = -9,
        )

        assertFalse(
            anchor.restore(
                completedVersion = 6,
                listState = LazyListState(),
                orderedKeys = listOf("invented-row-12"),
                leadingItemCount = 1,
            ),
        )
    }

    private fun assertPatternPreservesAnchor(leadingItemCount: Int) {
        var rows by mutableStateOf((10..29).map { "invented-row-$it" })
        var version by mutableStateOf(0L)
        lateinit var listState: LazyListState
        lateinit var anchor: PrependPagingAnchor

        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                listState = rememberLazyListState()
                anchor = rememberPrependPagingAnchor()
                LaunchedEffect(version) {
                    anchor.restore(
                        completedVersion = version,
                        listState = listState,
                        orderedKeys = rows,
                        leadingItemCount = leadingItemCount,
                    )
                }
                LazyColumn(
                    state = listState,
                    modifier = Modifier.height(180.dp).testTag("prepend-list"),
                ) {
                    items(leadingItemCount, key = { "leading-$it" }) {
                        Text("Leading item $it")
                    }
                    items(rows, key = { it }) { Text(it) }
                }
            }
        }

        compose.onNodeWithTag("prepend-list").performScrollToIndex(leadingItemCount + 6)
        compose.waitForIdle()

        lateinit var visibleKey: String
        var visibleOffset = 0
        compose.runOnIdle {
            val eligible = rows.toSet()
            val visible = checkNotNull(
                listState.layoutInfo.visibleItemsInfo.firstOrNull {
                    (it.key as? String) in eligible
                },
            )
            visibleKey = visible.key as String
            visibleOffset = visible.offset
            anchor.capture(
                currentVersion = version,
                listState = listState,
                eligibleKeys = eligible,
            )
            rows = (0..9).map { "invented-row-$it" } + rows
            version += 1
        }

        compose.waitUntil {
            val visible = listState.layoutInfo.visibleItemsInfo.firstOrNull {
                it.key == visibleKey
            }
            visible?.offset == visibleOffset
        }
        compose.runOnIdle {
            val visible = checkNotNull(
                listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == visibleKey },
            )
            assertEquals(visibleOffset, visible.offset)
        }
    }
}
