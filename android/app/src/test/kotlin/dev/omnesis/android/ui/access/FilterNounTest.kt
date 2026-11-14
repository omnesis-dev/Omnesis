// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import org.junit.Assert.*
import org.junit.Test

/** How entries and trees are named from the words each field declares. */
class FilterNounTest {
    private val shelves = readyField("extra.shelfId", FilterRef.TREE, "shelf or binder", "shelves and binders", picker = "tree",
        levels = listOf(FilterNoun("shelf", "shelves"), FilterNoun("binder", "binders")))
    private val folders = readyField("extra.projectDir", FilterRef.TREE, "project folder", "project folders", picker = "tree", scope = "device")
    private val labels = readyField("extra.labelIds", FilterRef.MEMBERSHIP, "label", "labels")
    private fun ref(field: FilterEditorField, id: String, device: String? = null) = FilterRef.item(field.capability, field.field, id, device)

    @Test fun aTreeEntryIsNamedByItsLevelAndTheLastLevelStandsForEveryDeeperOne() {
        assertEquals("Shelf", filterEntryCaption(ref(shelves, "a"), shelves, 0))
        assertEquals("Binder", filterEntryCaption(ref(shelves, "b"), shelves, 1))
        assertEquals("Binder", filterEntryCaption(ref(shelves, "c"), shelves, 6))
        assertEquals("Shelf or binder", filterEntryCaption(ref(shelves, "d"), shelves))
        assertEquals("Shelf or binder", filterEntryCaption(ref(shelves, "d"), shelves, -1))
        assertEquals("All shelves", shelves.rootLabel(showDeviceLevel = false))
    }
    @Test fun aPerDeviceTreeStartsAtTheDevicesOnlyWhenTheAccountHasSeveral() {
        assertEquals("All devices", folders.rootLabel(showDeviceLevel = true))
        assertEquals("All project folders", folders.rootLabel(showDeviceLevel = false))
        assertEquals("All labels", labels.rootLabel(showDeviceLevel = true))
        assertEquals("Device", filterEntryCaption(ref(folders, "", "dev_studio"), folders))
        assertEquals("Project folder", filterEntryCaption(ref(folders, "~/work", "dev_studio"), folders))
    }
    @Test fun anEntryWhoseFieldIsNotKnownYetHasNoCaptionExceptAPerson() {
        assertNull(filterEntryCaption(ref(labels, "Label_1"), null))
        assertEquals("Person", filterEntryCaption(FilterRef.person("Maya Reeves", listOf(FilterIdentifier("email", "maya@example.org"))), null))
        assertEquals("Saved label selection", savedSelectionName(labels))
        assertEquals("Saved selection", savedSelectionName(null))
        assertEquals("Labels", labels.title)
    }
    @Test fun aSearchNamesEveryNamedLevelOfATreeFromTheDeepestUpAndOtherwiseTheFieldsItems() {
        val repositories = readyField("extra.repositoryIds", FilterRef.TREE, "repository", "repositories", picker = "tree",
            levels = listOf(FilterNoun("owner", "owners"), FilterNoun("repository", "repositories")))
        assertEquals("Search repositories and owners", repositories.searchPrompt)
        assertEquals("Search binders and shelves", shelves.searchPrompt)
        assertEquals("Search project folders", folders.searchPrompt)
        assertEquals("Search labels", labels.searchPrompt)
        val oneLevel = readyField("extra.folderId", FilterRef.TREE, "folder", "folders", picker = "tree", levels = listOf(FilterNoun("folder", "folders")))
        assertEquals("Search folders", oneLevel.searchPrompt)
    }
    @Test fun anAccountRowSaysWhatItsFilterDoesAndHowManyItemsItHolds() {
        fun filter(action: String, count: Int) = SourceFilter("mail:reader@example.org", FilterAudience("level", "answer"),
            listOf(FilterRule(List(count) { ref(labels, "Label_$it") }, action)), if (action == "share") "hide" else "share")
        assertEquals("Share matching content · 3 items", scopePolicySummary(filter("share", 3)))
        assertEquals("Hide matching content · 1 item", scopePolicySummary(filter("hide", 1)))
        assertEquals(ALL_CONTENT, scopePolicySummary(null))
    }
}
