// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import org.junit.Assert.*
import org.junit.Test

class ScopeSelectorIdentityTest {
    @Test fun renamingAHintNeverChangesAStableSelector() {
        val option = ScopeOption(ScopeRef("folder", "workspace"), "Before", 1)
        val ref = option.ref
        assertEquals(scopeRefKey(ref), scopeRefKey(option.copy(label = "Renamed").ref))
        assertNotEquals(scopeRefKey(ref), scopeRefKey(ref.copy(kind = "label")))
    }
    @Test fun equalNamesNeverMergeDifferentStableIds() {
        assertNotEquals(scopeRefKey(ScopeRef("folder", "first")), scopeRefKey(ScopeRef("folder", "second")))
    }
    @Test fun capturedIdentifiersAreAnExactSetAndNeverFollowAPersonOrSuperset() {
        val first = ScopeIdentifier("email", "reader@example.org")
        val second = ScopeIdentifier("phone", "+15550100123")
        val ref = ScopeRef("participant", label = "Reader", identifiers = listOf(first, second))
        assertEquals(scopeRefKey(ref), scopeRefKey(ref.copy(label = "Renamed", identifiers = listOf(second, first, first))))
        assertNotEquals(scopeRefKey(ref), scopeRefKey(ref.copy(identifiers = listOf(first, second, ScopeIdentifier("email", "other@example.org")))))
    }
    @Test fun opaqueIdentifierContentsCannotCollideWithKeySeparators() {
        assertNotEquals(scopeRefKey(ScopeRef("label", "id:3:abc")), scopeRefKey(ScopeRef("conversation", "3:abc")))
    }
    @Test fun pageDedupKeepsLatestHintsAndDistinctIdsWithEqualNames() {
        val original = ScopeOption(ScopeRef("folder", "first"), "Before", 1)
        val renamed = original.copy(label = "Workspace", count = 2)
        val different = renamed.copy(ref = renamed.ref.copy(id = "second"))
        assertEquals(listOf(renamed, different), mergeScopeOptions(listOf(original), listOf(renamed, different)))
    }
}
