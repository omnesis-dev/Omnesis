// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.common

import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.Annotation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class AnnotationsAccessibilityTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun dependent_loading_button_has_spoken_progress_text() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                AnnotationRow(
                    annotation = Annotation(
                        id = "annotation-example",
                        claimType = "preference",
                        claimText = "Prefers fictional written updates.",
                        dependentCount = 2,
                    ),
                    dependents = AnnotationDependentsUi(loading = true),
                    onToggleDependents = {},
                )
            }
        }

        compose.onNodeWithText("Loading uses…").assertIsDisplayed()
    }

    @Test
    fun initial_dependent_failure_exposes_a_working_retry() {
        val refresh = CursorPagingState().beginRefresh()
        val dependents = AnnotationDependentsUi(
            expanded = true,
            paging = refresh.state.failRefresh(
                refresh.request,
                IllegalStateException("offline"),
            ),
        )
        var retries = 0

        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                val listState = rememberLazyListState()
                LazyColumn(state = listState) {
                    annotationsSectionItems(
                        listState = listState,
                        keyPrefix = "test",
                        title = "Enriched by Omnesis",
                        annotations = listOf(
                            Annotation(
                                id = "annotation-example",
                                claimType = "preference",
                                claimText = "Prefers fictional written updates.",
                                dependentCount = 2,
                            ),
                        ),
                        dependents = mapOf("annotation-example" to dependents),
                        onLoadMoreDependents = { retries += 1 },
                    )
                }
            }
        }

        assertTrue(dependents.shouldRetryFirstPage)
        compose.onNodeWithText("Couldn't load uses.").assertIsDisplayed()
        compose.onNodeWithText("Retry loading uses").assertIsDisplayed().performClick()
        assertEquals(1, retries)
    }
}
