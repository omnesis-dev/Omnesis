// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.DocumentDetail
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.document.DocumentDetailViewModel.DocumentBundle
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DocumentInspectorPagingEmptyStateUiTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun graph_claims_empty_only_after_every_graph_source_reaches_a_known_end() {
        val bundle = mutableStateOf(
            emptyBundle().copy(
                outboundRefsPaging = CursorPagingState(nextCursor = "outbound-next"),
            ),
        )
        compose.setContent {
            OmnesisTheme(darkTheme = false) {
                InspectorContent(
                    bundle = bundle.value,
                    onDone = {},
                    initialTab = InspectorTab.Graph,
                )
            }
        }

        assertNoDefinitiveEmpty()

        compose.runOnIdle {
            bundle.value = emptyBundle().copy(
                inboundRefsPaging = CursorPagingState(
                    nextCursor = "inbound-next",
                    paginationError = IllegalStateException("fictional page failure"),
                ),
            )
        }
        assertNoDefinitiveEmpty()

        compose.runOnIdle {
            bundle.value = emptyBundle().copy(
                nearDupesPaging = CursorPagingState(stoppedBeforeEnd = true),
            )
        }
        assertNoDefinitiveEmpty()

        compose.runOnIdle {
            bundle.value = emptyBundle().copy(graphLoading = true)
        }
        assertNoDefinitiveEmpty()

        compose.runOnIdle {
            bundle.value = emptyBundle().copy(
                graphError = IllegalStateException("fictional graph failure"),
            )
        }
        assertNoDefinitiveEmpty()

        compose.runOnIdle {
            bundle.value = emptyBundle()
        }
        compose.onNodeWithText(EMPTY_GRAPH_COPY).assertIsDisplayed()
    }

    private fun assertNoDefinitiveEmpty() {
        compose.onNodeWithText(EMPTY_GRAPH_COPY).assertDoesNotExist()
    }

    private fun emptyBundle() = DocumentBundle(
        doc = DocumentDetail(
            id = "document-example",
            providerId = "fictional:example",
            sourceId = "fictional:example",
            externalId = "external-example",
            title = "Invented project note",
            sourceCreatedAt = "2026-01-01T00:00:00Z",
        ),
    )

    private companion object {
        const val EMPTY_GRAPH_COPY =
            "No graph neighbors yet. People, attachments, and references will appear here as they're indexed."
    }
}
