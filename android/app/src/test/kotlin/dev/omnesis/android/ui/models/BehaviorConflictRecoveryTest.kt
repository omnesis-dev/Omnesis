// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.ModelsOverview
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BehaviorConflictRecoveryTest {
    @Test fun failed_conflict_refresh_stays_blocked_until_reopening_fetches_and_applies_current_values() = runTest {
        val fresh = ModelsOverview(modelSettings = mapOf("agent" to ModelBehaviorSettings(
            "openrouter/reasoner-v1", ModelBehaviorValues(reasoningEffort = "high"),
        )))
        var attempts = 0
        var applied: ModelsOverview? = null
        val conflicts = BehaviorConflictRecovery(
            fetch = {
                attempts++
                if (attempts == 1) throw IllegalStateException("offline")
                fresh
            },
            applyFresh = { _, overview -> applied = overview },
        )
        conflicts.mark("agent")
        assertTrue(conflicts.refresh("agent")!!.isFailure)
        assertTrue(conflicts.isBlocked("agent"))
        assertEquals(null, applied)

        assertTrue(conflicts.refresh("agent")!!.isSuccess)
        assertFalse(conflicts.isBlocked("agent"))
        assertEquals(fresh, applied)
        assertEquals(2, attempts)
    }

    @Test fun conflict_retry_refetches_if_another_role_is_acknowledged_while_its_get_is_in_flight() = runTest {
        val stale = CompletableDeferred<ModelsOverview>()
        val latest = ModelsOverview(modelSettings = mapOf(
            "agent" to ModelBehaviorSettings("openrouter/reasoner-v1",
                ModelBehaviorValues(reasoningEffort = "external")),
            "brief-judge" to ModelBehaviorSettings("openrouter/judge-v1",
                ModelBehaviorValues(reasoningEffort = "high")),
        ))
        val baseline = BehaviorSaveBaseline().apply {
            replace(mapOf("brief-judge" to ModelBehaviorSettings("openrouter/judge-v1",
                ModelBehaviorValues(reasoningEffort = "low"))))
        }
        var generation = 0L
        var fetches = 0
        val reader = BehaviorOverviewReader(
            generation = { generation },
            fetch = {
                fetches++
                if (fetches == 1) stale.await() else latest
            },
        )
        val conflicts = BehaviorConflictRecovery(
            fetch = reader::read,
            applyFresh = { _, overview -> baseline.replace(overview.modelSettings) },
        )
        conflicts.mark("agent")
        val retry = async { conflicts.refresh("agent") }
        runCurrent()
        baseline.acknowledge(BehaviorSaveRequest("brief-judge", "openrouter/judge-v1",
            ModelBehaviorValues(reasoningEffort = "high")))
        generation++
        stale.complete(ModelsOverview(modelSettings = mapOf("brief-judge" to
            ModelBehaviorSettings("openrouter/judge-v1", ModelBehaviorValues(reasoningEffort = "low")))))
        runCurrent()

        assertTrue(retry.await()!!.isSuccess)
        assertFalse(conflicts.isBlocked("agent"))
        assertEquals(2, fetches)
        assertEquals(ModelBehaviorValues(reasoningEffort = "high"), baseline.expected(
            BehaviorSaveRequest("brief-judge", "openrouter/judge-v1", ModelBehaviorValues()),
        ))
    }
}
