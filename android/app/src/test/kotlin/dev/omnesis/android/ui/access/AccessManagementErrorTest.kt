// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.GatewayException
import org.junit.Assert.*
import org.junit.Test

class AccessManagementErrorTest {
    @Test fun transportUnwrappedTokensKeepTheirExactActionableRemedies() {
        val dependency = GatewayException.ServerError(409, "level-in-use")
        assertEquals("level-in-use", accessManagementErrorCode(dependency))
        assertTrue(accessManagementError(dependency).contains("Move them to another access level"))
        val name = GatewayException.ServerError(409, "level-name-taken")
        assertEquals("level-name-taken", accessManagementErrorCode(name))
        assertTrue(accessManagementError(name).contains("Choose another"))
        assertNull(accessManagementErrorCode(GatewayException.ServerError(409, "not-level-in-use")))
        assertNull(accessManagementErrorCode(GatewayException.ServerError(409, "level-name-taken-again")))
    }
    @Test fun dependencyNameConflictAndTransientFailuresHaveDifferentRemedies() {
        val dependency = GatewayException.ServerError(409, "{\"error\":\"level-in-use\"}")
        assertEquals("level-in-use", accessManagementErrorCode(dependency))
        assertTrue(accessManagementError(dependency).contains("Move them to another access level"))
        assertFalse(accessManagementError(dependency).contains("Try again"))
        assertTrue(accessManagementError(GatewayException.ServerError(409, null, "level-name-taken")).contains("Choose another"))
        assertTrue(accessManagementError(GatewayException.ServerError(503, "unavailable")).contains("Try again"))
        assertNull(accessManagementErrorCode(GatewayException.ServerError(409, "not-level-in-use")))
    }
    @Test fun aLevelDeletedElsewhereIsAConflictThatNamesTheDeletionInsteadOfARetry() {
        val overview = dev.omnesis.android.transport.dto.AccessOverview(emptyList(), emptyList())
        val level = dev.omnesis.android.transport.dto.AccessLevelSummary("level-example", "Research assistant", 3, listOf(dev.omnesis.android.transport.dto.AccessGrantRule.notes()), 0)
        val editing = AccessManagementState(overview, AccessLevelDraft.opening(level, overview), loading = true)
        val gone = editing.afterSaveFailure(GatewayException.NotFound())
        assertTrue(gone.conflict)
        assertFalse(gone.loading)
        assertEquals(ACCESS_LEVEL_GONE_MESSAGE, gone.error)
        assertNull(gone.errorCode)
        assertEquals(editing.draft, gone.draft)
        val creating = AccessManagementState(overview, AccessLevelDraft.opening(null, overview), loading = true).afterSaveFailure(GatewayException.NotFound())
        assertFalse(creating.conflict)
        assertTrue(creating.error!!.contains("Try again"))
        val stale = editing.afterSaveFailure(GatewayException.ServerError(409, "stale-revision"))
        assertTrue(stale.conflict)
        val refused = editing.afterSaveFailure(GatewayException.ServerError(409, "invalid-selection"))
        assertFalse(refused.conflict)
    }
    @Test fun aSaveRefusedForItsSelectionSaysWhatMustStayTogether() {
        val refused = accessManagementError(GatewayException.ServerError(409, "{\"error\":\"invalid-selection\"}"))
        assertEquals("These permissions cannot be saved as chosen. A saved source filter must stay with a source this access level allows.", refused)
        assertEquals(refused, accessManagementError(GatewayException.ServerError(409, "invalid-selection")))
        assertEquals(refused, accessManagementError(GatewayException.ServerError(409, null, "invalid-selection")))
        assertFalse(accessManagementError(GatewayException.ServerError(409, "invalid-selection"), reading = true).contains("saved"))
    }
    @Test fun aSaveTheGatewayRefusesWithASentenceShowsThatSentence() {
        val sentence = "Label filters need Gmail to be resynced. Search keeps working meanwhile."
        val refusal = GatewayException.ServerError(409, "invalid-selection", userMessage = sentence)
        assertEquals(sentence, accessManagementError(refusal))
        val overview = dev.omnesis.android.transport.dto.AccessOverview(emptyList(), emptyList())
        val level = dev.omnesis.android.transport.dto.AccessLevelSummary("level-example", "Research assistant", 3, listOf(dev.omnesis.android.transport.dto.AccessGrantRule.notes()), 0)
        for (opened in listOf(level, null)) {
            val saving = AccessManagementState(overview, AccessLevelDraft.opening(opened, overview), loading = true)
            assertEquals(sentence, saving.afterSaveFailure(refusal).error)
        }
        assertFalse(accessManagementError(refusal, reading = true).contains("Label"))
    }
    @Test fun aRefusedDeletionKeepsTheDraftAndNamesWhatUsesTheLevel() {
        val overview = dev.omnesis.android.transport.dto.AccessOverview(emptyList(), emptyList())
        val level = dev.omnesis.android.transport.dto.AccessLevelSummary("level-example", "Research assistant", 3, listOf(dev.omnesis.android.transport.dto.AccessGrantRule.notes()), 1)
        val deleting = AccessManagementState(overview, AccessLevelDraft.opening(level, overview), loading = true, deleting = true)
        val inUse = deleting.afterDeleteFailure(GatewayException.ServerError(409, "{\"error\":\"level-in-use\"}"))
        assertFalse(inUse.loading)
        assertFalse(inUse.deleting)
        assertEquals(deleting.draft, inUse.draft)
        assertNull(inUse.error)
        assertNull(inUse.errorCode)
        assertTrue(inUse.deleteError!!.contains("Move its connections and integrations off it first."))
        assertTrue(accessLevelDeleteError(GatewayException.ServerError(503, "unavailable")).contains("could not delete"))
        assertFalse(accessLevelDeleteError(GatewayException.ServerError(503, "unavailable")).contains("save"))
        assertEquals("This device cannot manage access levels.", accessLevelDeleteError(GatewayException.Forbidden()))
    }
    @Test fun failedReadsAreNotWordedAsFailedSaves() {
        val read = accessManagementError(GatewayException.ServerError(503, "unavailable"), reading = true)
        assertFalse(read.contains("save"))
        assertTrue(read.contains("could not load"))
        assertFalse(accessManagementError(GatewayException.NotFound(), reading = true).contains("save"))
        assertTrue(accessManagementError(GatewayException.ServerError(503, "unavailable")).contains("could not save"))
    }
}
