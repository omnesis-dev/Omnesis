// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PersonDetail
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.CursorPagingState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PersonDetailPagingUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun initial_composition_does_not_request_every_document_page() {
        var pageRequests = 0
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PersonDetailContent(
                    state = Loadable.Content(
                        PersonDetailViewModel.Content(
                            person = PersonDetail(
                                id = "person-example",
                                canonicalName = "Maya Reeves",
                            ),
                            docs = (1..30).map(::doc),
                            documentsPaging = CursorPagingState(nextCursor = "30"),
                        ),
                    ),
                    onBack = {},
                    onRetry = {},
                    onOpenDocument = {},
                    onLoadMore = { pageRequests += 1 },
                )
            }
        }

        compose.runOnIdle { assertEquals(0, pageRequests) }
        compose.onNodeWithText("30+").assertExists()
    }

    @Test
    fun defensively_stalled_cursor_keeps_the_loaded_count_qualified() {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PersonDetailContent(
                    state = Loadable.Content(
                        PersonDetailViewModel.Content(
                            person = PersonDetail(
                                id = "person-example",
                                canonicalName = "Maya Reeves",
                            ),
                            docs = (1..30).map(::doc),
                            documentsPaging = CursorPagingState(stoppedBeforeEnd = true),
                        ),
                    ),
                    onBack = {},
                    onRetry = {},
                    onOpenDocument = {},
                    onLoadMore = {},
                )
            }
        }

        compose.onNodeWithText("30+").assertExists()
    }

    @Test
    fun empty_documents_with_a_next_cursor_do_not_claim_no_documents() {
        showEmptyDocuments(CursorPagingState(nextCursor = "documents-next"))

        compose.onNodeWithText("No documents linked yet.").assertDoesNotExist()
    }

    @Test
    fun empty_documents_after_an_append_error_do_not_claim_no_documents() {
        showEmptyDocuments(
            CursorPagingState(
                nextCursor = "documents-next",
                paginationError = IllegalStateException("fictional page failure"),
            ),
        )

        compose.onNodeWithText("No documents linked yet.").assertDoesNotExist()
        compose.onNodeWithText("Couldn't load more documents.").assertExists()
    }

    @Test
    fun empty_documents_after_a_defensive_stop_do_not_claim_no_documents() {
        showEmptyDocuments(CursorPagingState(stoppedBeforeEnd = true))

        compose.onNodeWithText("No documents linked yet.").assertDoesNotExist()
    }

    private fun showEmptyDocuments(paging: CursorPagingState) {
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                PersonDetailContent(
                    state = Loadable.Content(
                        PersonDetailViewModel.Content(
                            person = PersonDetail(
                                id = "person-example",
                                canonicalName = "Maya Reeves",
                            ),
                            docs = emptyList(),
                            documentsPaging = paging,
                        ),
                    ),
                    onBack = {},
                    onRetry = {},
                    onOpenDocument = {},
                    onLoadMore = {},
                )
            }
        }
    }

    private fun doc(index: Int) = PersonDetailViewModel.DocRow(
        id = "document-$index",
        title = "Invented document $index",
        sourceLabel = "Fictional source",
        icon = SourceIconModel(fallbackInitial = "F"),
        roles = emptyList(),
    )
}
