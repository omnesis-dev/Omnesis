// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import org.junit.Assert.*
import org.junit.Test

class FilterSelectorIdentityTest {
    private fun folder(id: String, device: String? = null) = FilterRef.item(FilterRef.TREE, "extra.projectDir", id, device)
    @Test fun renamingAHintNeverChangesAStableEntry() {
        val option = FilterOption(folder("~/work"), "~/work", "work", 1)
        assertEquals(filterRefKey(option.ref), filterRefKey(option.copy(label = "Renamed", shortLabel = "renamed").ref))
        assertNotEquals(filterRefKey(option.ref), filterRefKey(option.ref.copy(field = "extra.folderId")))
    }
    @Test fun theSamePathOnTwoDevicesIsTwoEntriesAndAWholeDeviceIsItsOwn() {
        assertNotEquals(filterRefKey(folder("~/work", "dev_studio")), filterRefKey(folder("~/work", "dev_travel")))
        assertNotEquals(filterRefKey(folder("", "dev_studio")), filterRefKey(folder("~/work", "dev_studio")))
        assertTrue(folder("", "dev_studio").isDevice)
        assertFalse(folder("~/work", "dev_studio").isDevice)
    }
    @Test fun capturedIdentifiersAreAnExactSetAndNeverFollowAPersonOrSuperset() {
        val first = FilterIdentifier("email", "reader@example.org")
        val second = FilterIdentifier("phone", "+15550100123")
        val ref = FilterRef.person("Reader", listOf(first, second))
        assertEquals(filterRefKey(ref), filterRefKey(ref.copy(label = "Renamed", identifiers = listOf(second, first, first))))
        assertNotEquals(filterRefKey(ref), filterRefKey(ref.copy(identifiers = listOf(first, second, FilterIdentifier("email", "other@example.org")))))
    }
    @Test fun opaqueIdContentsCannotCollideWithKeySeparators() {
        assertNotEquals(filterRefKey(FilterRef.item(FilterRef.MEMBERSHIP, "a", "1:b")), filterRefKey(FilterRef.item(FilterRef.MEMBERSHIP, "a:1", "b")))
    }
    @Test fun pageDedupKeepsLatestHintsAndDistinctIdsWithEqualNames() {
        val original = FilterOption(folder("first"), "Before", count = 1)
        val renamed = original.copy(label = "Workspace", count = 2)
        val different = renamed.copy(ref = renamed.ref.copy(id = "second"))
        assertEquals(listOf(renamed, different), mergeFilterOptions(listOf(original), listOf(renamed, different)))
    }
}
