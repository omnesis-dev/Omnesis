// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.transport.dto.Annotation
import dev.omnesis.android.transport.dto.AnnotationDependent
import dev.omnesis.android.transport.dto.PersonDetail
import dev.omnesis.android.ui.common.AnnotationDependentsUi
import dev.omnesis.android.ui.common.CursorPagingState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class PersonDetailPagingRaceTest {
    @Test
    fun document_page_preserves_annotation_page_that_completed_while_fetching() {
        val latest = content().copy(
            annotations = listOf(Annotation(id = "annotation-latest")),
        )

        val merged = mergePersonDocumentPage(
            latest,
            listOf(doc("second")),
            paging = CursorPagingState(),
        )

        assertEquals(listOf("annotation-latest"), merged.annotations.map { it.id })
        assertEquals(listOf("second"), merged.docs.map { it.id })
        assertFalse(merged.documentsPaging.isLoadingMore)
    }

    @Test
    fun document_page_preserves_dependents_that_completed_while_fetching() {
        val latest = content().copy(
            annotationDependents = mapOf(
                "annotation" to AnnotationDependentsUi(
                    expanded = true,
                    items = listOf(AnnotationDependent("brief", "dependent-latest")),
                ),
            ),
        )

        val merged = mergePersonDocumentPage(
            latest,
            listOf(doc("second")),
            paging = CursorPagingState(nextCursor = "60"),
        )

        assertEquals(
            "dependent-latest",
            merged.annotationDependents.getValue("annotation").items.single().id,
        )
        assertEquals(listOf("second"), merged.docs.map { it.id })
    }

    @Test
    fun reordered_initial_refresh_replaces_with_only_the_winning_local_page() {
        val loaded = mutableListOf(doc("previous"))
        val staleResponse = listOf(doc("stale-one"), doc("stale-two"))
        val winningResponse = listOf(doc("fresh"))

        val staleCommitted = replaceInitialPersonDocumentPage(
            requestGeneration = 1,
            currentGeneration = 2,
            loaded = loaded,
            documents = staleResponse,
        )
        val winningCommitted = replaceInitialPersonDocumentPage(
            requestGeneration = 2,
            currentGeneration = 2,
            loaded = loaded,
            documents = winningResponse,
        )

        assertFalse(staleCommitted)
        org.junit.Assert.assertTrue(winningCommitted)
        assertEquals(listOf("fresh"), loaded.map { it.id })
        assertEquals(1, loaded.size)
    }

    private fun content() = PersonDetailViewModel.Content(
        person = PersonDetail(id = "person-example", canonicalName = "Maya Reeves"),
        docs = listOf(doc("first")),
        documentsPaging = CursorPagingState(nextCursor = "30").beginLoadMore()!!.state,
    )

    private fun doc(id: String) = PersonDetailViewModel.DocRow(
        id = id,
        title = "Invented document $id",
        sourceLabel = "Fictional source",
        icon = SourceIconModel(fallbackInitial = "F"),
        roles = emptyList(),
    )
}
