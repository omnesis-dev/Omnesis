// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import dev.omnesis.android.transport.dto.SearchGraphDocument
import dev.omnesis.android.transport.dto.SearchGraphModelContext
import dev.omnesis.android.transport.dto.SearchGraphPath
import dev.omnesis.android.transport.dto.SearchProvenance
import dev.omnesis.android.transport.dto.SearchResultItem
import org.junit.Assert.*
import org.junit.Test

class SearchGraphFactsTest {
    private fun doc(id: String) = SearchGraphDocument(id, "files:example", "Title $id")
    private fun text(facts: List<SearchGraphFact>) = facts.map { fact -> fact.joinToString("") { it.text } }

    @Test fun legacy_and_self_only_have_no_facts() {
        assertTrue(searchGraphFacts(null, "root").isEmpty())
        assertTrue(searchGraphFacts(SearchProvenance(copies = listOf(doc("root"))), "root").isEmpty())
    }

    @Test fun copies_use_five_links_exclude_root_and_keep_bounded_count() {
        val facts = searchGraphFacts(SearchProvenance(copies = listOf(doc("root")) + (1..7).map { doc("copy-$it") }, stopReasons = listOf("copies")), "root")
        assertEquals(5, facts.single().count { it.document != null })
        assertTrue(text(facts).single().startsWith("The same text appears in at least 7 other documents:"))
        assertTrue(text(facts).single().endsWith(", and 2 more."))
        assertFalse(text(facts).single().contains("Title root"))
    }

    @Test fun shared_prefix_merges_leaves_without_chaining_siblings_and_links_exact_ids() {
        val p = SearchProvenance(
            paths = listOf(
                SearchGraphPath(listOf("root", "email", "a"), listOf("contains", "contains"), listOf("is attached to", "includes the attachment")),
                SearchGraphPath(listOf("root", "email", "b"), listOf("contains", "contains"), listOf("is attached to", "includes the attachment")),
            ),
            modelContext = SearchGraphModelContext(listOf(doc("email"), doc("a"), doc("b"))),
        )
        val facts = searchGraphFacts(p, "root")
        assertEquals(listOf("This document is attached to Title email, which includes the attachment Title a and includes the attachment Title b."), text(facts))
        assertEquals(listOf("email", "a", "b"), facts.single().mapNotNull { it.document?.documentId })
    }

    @Test fun separate_copy_roots_stay_separate_and_unknown_edges_are_human() {
        val p = SearchProvenance(paths = listOf(SearchGraphPath(listOf("other", "leaf"), listOf("outbound:future"))))
        assertEquals(listOf("Untitled document is connected to Untitled document."), text(searchGraphFacts(p, "root")))
    }

    @Test fun physical_location_is_useful_even_without_other_copies() {
        val p = SearchProvenance(copies = listOf(doc("root").copy(deviceName = "Example laptop", path = "~/Documents/sample.pdf")))
        assertEquals(listOf("This document is on Example laptop at ~/Documents/sample.pdf."), text(searchGraphFacts(p, "root")))
    }

    @Test fun partial_overlapping_copy_inventories_get_one_panel() {
        fun item(id: String, copies: List<String>) = SearchResultItem(id, "files:example", "file", "Schedule.pdf", sourceCreatedAt = "2026-01-02T00:00:00Z", chunkText = "", score = 1.0, provenance = SearchProvenance(copies = copies.map(::doc)))
        val items = listOf(item("a", listOf("a", "b", "c")), item("b", listOf("b", "c", "d")), item("x", listOf("x", "y")))
        assertEquals(setOf("a", "x"), searchGraphPanelIds(items))
    }

    @Test fun hub_only_evidence_still_explains_the_stopping_point() {
        assertEquals(listOf("This trail stops at highly connected documents."), text(searchGraphFacts(SearchProvenance(copies = listOf(doc("root")), stopReasons = listOf("hub")), "root")))
    }

    @Test fun malformed_and_cyclic_paths_are_not_displayed() {
        val p = SearchProvenance(paths = listOf(SearchGraphPath(listOf("root", "a")), SearchGraphPath(listOf("root", "root"), listOf("url"))))
        assertTrue(searchGraphFacts(p, "root").isEmpty())
    }
}
