// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ScopeLevelNounTest {
    private val shelves = AccessSourceInstance("shelves:fictional", "Fictional shelves", scopes = SourceScopes(listOf(
        SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("shelf or binder", "shelves and binders"), picker = "tree",
            levels = listOf(SourceScopeNoun("shelf", "shelves"), SourceScopeNoun("binder", "binders"))),
        SourceScopeItem("label", "changes", noun = SourceScopeNoun("label", "labels"), picker = "search"),
    )))
    private val folders = AccessSourceInstance("files:fictional", "Fictional files", scopes = SourceScopes(listOf(
        SourceScopeItem("folder", "hierarchy", noun = SourceScopeNoun("folder", "folders"), picker = "tree"),
    )))

    @Test fun aTreeItemIsNamedByItsLevelAndTheLastLevelStandsForEveryDeeperOne() {
        assertEquals("Shelf", scopeKindCaption("folder", shelves, 0))
        assertEquals("Binder", scopeKindCaption("folder", shelves, 1))
        assertEquals("Binder", scopeKindCaption("folder", shelves, 6))
        assertEquals("All shelves", scopeTreeRootLabel("folder", shelves))
    }
    @Test fun anItemOfUnknownDepthAndASourceWithOneNounKeepTheKindsOwnWord() {
        assertEquals("Shelf or binder", scopeKindCaption("folder", shelves))
        assertEquals("Shelf or binder", scopeKindCaption("folder", shelves, -1))
        assertEquals("Label", scopeKindCaption("label", shelves, 1))
        assertEquals("Folder", scopeKindCaption("folder", folders, 1))
        assertEquals("All folders", scopeTreeRootLabel("folder", folders))
        assertNull(scopeLevelNoun("folder", folders, 0))
        assertEquals("Saved shelf or binder selection", savedSelectionName("folder", shelves))
    }
    @Test fun aPreviewPlacesASelectedItemAtItsDepth() {
        val shelf = ScopeRef("folder", "shelf-one")
        val binder = ScopeRef("folder", "binder-one")
        val preview = ScopePreview("shelves:fictional", 3, 3, 0, 0, listOf(
            ScopePreviewItem(shelf, "Invented shelf", 3, depth = 0),
            ScopePreviewItem(binder, "Invented binder", 1, parentId = "shelf-one"),
        ), emptyList(), emptyList())
        assertEquals(0, scopeItemDepth(preview, shelf))
        assertNull(scopeItemDepth(preview, binder))
        assertNull(scopeItemDepth(preview, ScopeRef("folder", "other")))
        assertNull(scopeItemDepth(null, shelf))
    }
    @Test fun levelsAndDepthDecodeFromTheGatewayAndAreOptionalForAnOlderOne() {
        val json = Json { ignoreUnknownKeys = true }
        val options = json.decodeFromString<ScopeOptions>("""
            {"sourceId":"shelves:fictional","sourceType":"shelves","readiness":[],
             "scopes":{"items":[{"kind":"folder","noun":{"one":"shelf or binder","many":"shelves and binders"},
               "levels":[{"one":"shelf","many":"shelves"},{"one":"binder","many":"binders"}],"picker":"tree","link":"hierarchy"}]},
             "items":[{"ref":{"kind":"folder","id":"a"},"label":"Invented shelf","count":2,"hasChildren":true,"depth":0},
                      {"ref":{"kind":"folder","id":"b"},"label":"Invented binder","count":1}]}
        """)
        assertEquals(listOf("shelf", "binder"), options.scopes.items.single().levels?.map { it.one })
        assertEquals(listOf(0, null), options.items.map { it.depth })
        val older = json.decodeFromString<SourceScopes>("""{"items":[{"kind":"folder","noun":{"one":"folder","many":"folders"},"picker":"tree","link":"hierarchy"}]}""")
        assertNull(older.items.single().levels)
    }
}
