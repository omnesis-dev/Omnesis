// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import dev.omnesis.android.transport.dto.SearchGraphDocument
import dev.omnesis.android.transport.dto.SearchProvenance
import dev.omnesis.android.transport.dto.SearchResultItem

internal data class SearchGraphPart(val text: String, val document: SearchGraphDocument? = null)
internal typealias SearchGraphFact = List<SearchGraphPart>

/** Human facts preserve exact path prefixes; sibling branches never become a chain. */
internal fun searchGraphFacts(provenance: SearchProvenance?, rootId: String): List<SearchGraphFact> {
    if (provenance == null) return emptyList()
    val documents = (provenance.modelContext?.documents.orEmpty() + provenance.copies)
        .associateBy { it.documentId }
    fun reference(id: String) = if (id == rootId) SearchGraphPart("This document") else {
        val document = documents[id] ?: SearchGraphDocument(id)
        SearchGraphPart(document.title?.takeIf { it.isNotBlank() } ?: "Untitled document", document)
    }
    val facts = mutableListOf<SearchGraphFact>()
    val current = provenance.copies.find { it.documentId == rootId }
    if (current != null && (current.deviceName != null || current.path != null)) {
        facts += listOf(SearchGraphPart("This document is ${current.deviceName?.let { "on $it" } ?: "stored"}${current.path?.let { " at $it" } ?: ""}."))
    }
    val copies = provenance.copies.distinctBy { it.documentId }.filter { it.documentId != rootId }
    if (copies.isNotEmpty()) {
        val parts = mutableListOf(SearchGraphPart("The same text appears in ${if (provenance.stopReasons.any { it == "copies" || it == "nodes" }) "at least " else ""}${copies.size} other ${if (copies.size == 1) "document" else "documents"}: "))
        copies.take(5).forEachIndexed { index, copy ->
            if (index > 0) parts += SearchGraphPart(", ")
            parts += reference(copy.documentId)
            val location = listOfNotNull(copy.deviceName?.let { "on $it" }, copy.path?.let { "at $it" }).joinToString(" ")
            if (location.isNotBlank()) parts += SearchGraphPart(" ($location)")
        }
        if (copies.size > 5) parts += SearchGraphPart(", and ${copies.size - 5} more")
        parts += SearchGraphPart(".")
        facts += parts
    }
    class Node(val id: String, val relation: String = "") {
        val children = linkedMapOf<Triple<String, String, String>, Node>()
    }
    val roots = linkedMapOf<String, Node>()
    provenance.paths.forEach { path ->
        if (path.documentIds.size < 2 || path.documentIds.size != path.edges.size + 1) return@forEach
        if (path.documentIds.distinct().size != path.documentIds.size) return@forEach
        var node = roots.getOrPut(path.documentIds.first()) { Node(path.documentIds.first()) }
        path.edges.forEachIndexed { index, edge ->
            val id = path.documentIds[index + 1]
            val relation = path.relations?.getOrNull(index)?.takeIf { it.isNotBlank() } ?: searchGraphRelation(edge)
            node = node.children.getOrPut(Triple(id, edge, relation)) { Node(id, relation) }
        }
    }
    fun collect(node: Node, prefix: SearchGraphFact) {
        val children = node.children.values.toList()
        if (children.isEmpty()) return
        if (children.all { it.children.isEmpty() }) {
            val parts = prefix.toMutableList()
            children.forEachIndexed { index, child ->
                parts += SearchGraphPart(if (index == 0) " ${child.relation} " else " and ${child.relation} ")
                parts += reference(child.id)
            }
            parts += SearchGraphPart(".")
            facts += parts
        } else {
            children.forEach { child ->
                val next = prefix + SearchGraphPart(" ${child.relation} ") + reference(child.id)
                if (child.children.isEmpty()) facts += next + SearchGraphPart(".")
                else collect(child, next + SearchGraphPart(", which"))
            }
        }
    }
    roots.values.forEach { collect(it, listOf(reference(it.id))) }
    val limit = when {
        "hub" in provenance.stopReasons -> "This trail stops at highly connected documents."
        provenance.stopReasons.any { it == "depth" || it == "nodes" } -> "This trail may be incomplete."
        else -> null
    }
    if (limit != null) facts += listOf(SearchGraphPart(limit))
    return facts
}

internal fun searchGraphRelation(edge: String): String {
    val kind = edge.substringAfter(':', edge)
    val inbound = edge.startsWith("inbound:")
    val outbound = edge.startsWith("outbound:")
    return when (kind) {
        "url" -> if (inbound) "is linked from" else if (outbound) "links to" else "has a link with"
        "references" -> if (inbound) "is referenced by" else if (outbound) "references" else "has a reference connection with"
        "replies-to" -> if (inbound) "has a reply from" else if (outbound) "replies to" else "has a reply connection with"
        "part-of-thread" -> "shares a thread with"
        "calendar-event" -> "has an event connection with"
        "contains" -> "has related content in"
        "revision-of" -> "is another version of"
        else -> "is connected to"
    }
}

/** A bounded copy inventory may differ by representative; shared IDs still identify one family. */
internal fun searchGraphPanelIds(items: List<SearchResultItem>): Set<String> {
    val seen = mutableSetOf<String>()
    val panels = mutableSetOf<String>()
    items.forEach { item ->
        val provenance = item.provenance ?: return@forEach
        if (searchGraphFacts(provenance, item.documentId).isEmpty()) return@forEach
        val family = provenance.copies.map { it.documentId }.toSet() + item.documentId
        val repeated = family.any { it in seen }
        seen.addAll(family)
        if (!repeated) panels += item.documentId
    }
    return panels
}
