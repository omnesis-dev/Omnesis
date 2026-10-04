// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import dev.omnesis.android.transport.dto.SearchGraphDocument
import dev.omnesis.android.transport.dto.SearchProvenance
import dev.omnesis.android.transport.dto.SearchResultItem

internal data class SearchGraphPart(val text: String, val document: SearchGraphDocument? = null)
/** One fact; `depth` is its outline level, a branch sitting one under the fact ending with its colon. */
internal data class SearchGraphFact(val parts: List<SearchGraphPart>, val depth: Int = 0)

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
        facts += SearchGraphFact(listOf(SearchGraphPart("This document is ${current.deviceName?.let { "on $it" } ?: "stored"}${current.path?.let { " at $it" } ?: ""}.")))
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
        facts += SearchGraphFact(parts)
    }
    class Node(val id: String, val relation: String = "") {
        val children = linkedMapOf<Triple<String, String, String>, Node>()
        /** Same-named leaves folded into this one. */
        var more = 0
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
    // Leaves sharing a relation and a title under different documents of one
    // root's tree (an inline image repeated in every message of a thread) fold
    // into the first one, which counts the rest. Siblings under one document
    // stay listed, and the visible result is never folded away.
    val firstLeaf = mutableMapOf<Pair<String, String>, Pair<Node, Node>>()
    fun fold(node: Node) {
        val iterator = node.children.values.iterator()
        while (iterator.hasNext()) {
            val child = iterator.next()
            if (child.children.isNotEmpty()) { fold(child); continue }
            if (child.id == rootId) continue
            val name = documents[child.id]?.title?.trim()?.lowercase().orEmpty()
            if (name.isEmpty()) continue
            val kept = firstLeaf[child.relation to name]
            if (kept == null) firstLeaf[child.relation to name] = child to node
            else if (kept.second !== node && kept.first.id != child.id) {
                kept.first.more++
                iterator.remove()
            }
        }
    }
    roots.values.forEach { firstLeaf.clear(); fold(it) }
    fun ref(node: Node): List<SearchGraphPart> =
        listOf(reference(node.id)) + if (node.more > 0) listOf(SearchGraphPart(" (and ${node.more} more with this name)")) else emptyList()
    fun list(nodes: List<Node>): List<SearchGraphPart> = nodes.flatMapIndexed { index, node ->
        (if (index == 0) emptyList() else listOf(SearchGraphPart(if (index == nodes.lastIndex) " and " else ", "))) + ref(node)
    }
    // A route is said once: a single branch continues inline, siblings that share
    // a relation read as one clause, and where a document branches its fact ends
    // with a colon and each branch follows one level deeper.
    fun render(node: Node, prefix: List<SearchGraphPart>, depth: Int) {
        val groups = node.children.values.groupBy { it.relation }.toList()
        if (groups.isEmpty()) return
        if (groups.all { (_, targets) -> targets.all { it.children.isEmpty() } }) {
            val parts = prefix.toMutableList()
            groups.forEachIndexed { index, (relation, targets) ->
                parts += SearchGraphPart("${if (index == 0) "" else " and"} $relation ")
                parts += list(targets)
            }
            facts += SearchGraphFact(parts + SearchGraphPart("."), depth)
            return
        }
        if (groups.size == 1 && groups[0].second.size == 1) {
            val (relation, targets) = groups[0]
            render(targets[0], prefix + SearchGraphPart(" $relation ") + ref(targets[0]) + SearchGraphPart(", which"), depth)
            return
        }
        facts += SearchGraphFact(prefix + SearchGraphPart(":"), depth)
        val leaves = mutableListOf<SearchGraphPart>()
        groups.forEach { (relation, targets) ->
            val leafTargets = targets.filter { it.children.isEmpty() }
            if (leafTargets.isEmpty()) return@forEach
            leaves += SearchGraphPart("${if (leaves.isEmpty()) "" else " and "}$relation ")
            leaves += list(leafTargets)
        }
        if (leaves.isNotEmpty()) facts += SearchGraphFact(leaves + SearchGraphPart("."), depth + 1)
        groups.forEach { (relation, targets) ->
            targets.filter { it.children.isNotEmpty() }.forEach { branch ->
                render(branch, listOf(SearchGraphPart("$relation ")) + ref(branch) + SearchGraphPart(", which"), depth + 1)
            }
        }
    }
    roots.values.forEach { render(it, ref(it), 0) }
    val limit = when {
        "hub" in provenance.stopReasons -> "This trail stops at highly connected documents."
        provenance.stopReasons.any { it == "depth" || it == "nodes" } -> "This trail may be incomplete."
        else -> null
    }
    if (limit != null) facts += SearchGraphFact(listOf(SearchGraphPart(limit)))
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
