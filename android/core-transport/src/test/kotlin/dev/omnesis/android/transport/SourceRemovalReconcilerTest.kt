// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class SourceRemovalReconcilerTest {
    private class OptIn(override val sourceId: String) : HostedSourceOptIn {
        override fun forget() {}
        var withdrawals = 0
        override fun withdraw() { withdrawals++ }
    }

    @Test fun session_start_waits_for_durable_pending_authority_before_first_read() = runTest {
        val source = OptIn("notes:local")
        val reconciler = SourceRemovalReconciler(waitForPendingAuthority = true) { listOf(source) }
        var reads = 0
        val startup = async { reconciler.reconcile { reads++; listOf(source.sourceId) } }
        runCurrent()
        assertEquals(0, reads)
        reconciler.pendingResumesFrom { setOf(source.sourceId) }
        startup.await()
        assertEquals(1, reads)
        assertEquals(0, source.withdrawals)
    }

    @Test fun reconnect_applies_completed_tombstones_but_not_merely_missing_rows() = runTest {
        val removed = OptIn("notes:local")
        val neverAdded = OptIn("files:local")
        val reconciler = SourceRemovalReconciler { listOf(removed, neverAdded) }
        reconciler.reconcile { listOf(removed.sourceId) }
        assertEquals(1, removed.withdrawals)
        assertEquals(0, neverAdded.withdrawals)
    }

    @Test fun stale_removal_read_cannot_withdraw_an_explicit_reactivation() = runTest {
        val source = OptIn("notes:local")
        val reconciler = SourceRemovalReconciler { listOf(source) }
        val response = CompletableDeferred<List<String>>()
        val read = async { reconciler.reconcile { response.await() } }
        runCurrent()
        reconciler.activating(source.sourceId) { Unit }
        response.complete(listOf(source.sourceId))
        read.await()
        assertEquals(0, source.withdrawals)
        reconciler.reconcile { listOf(source.sourceId) }
        assertEquals(1, source.withdrawals)
    }

    @Test fun read_during_activation_is_fenced_until_activation_finishes() = runTest {
        val source = OptIn("notes:local")
        val reconciler = SourceRemovalReconciler { listOf(source) }
        reconciler.activating(source.sourceId) {
            reconciler.reconcile { listOf(source.sourceId) }
            assertEquals(0, source.withdrawals)
        }
    }

    @Test fun old_gateway_response_cannot_apply_after_repair() = runTest {
        val source = OptIn("notes:local")
        val reconciler = SourceRemovalReconciler { listOf(source) }
        val response = CompletableDeferred<List<String>>()
        val read = async { reconciler.reconcile { response.await() } }
        runCurrent()
        reconciler.invalidateSession()
        response.complete(listOf(source.sourceId))
        read.await()
        assertEquals(0, source.withdrawals)
    }

    @Test fun pending_resume_survives_offline_reconnect_and_registration_gap() = runTest {
        val source = OptIn("notes:local")
        val reconciler = SourceRemovalReconciler { listOf(source) }
        reconciler.updatePendingResumes(setOf(source.sourceId))
        reconciler.reconcile { listOf(source.sourceId) }
        assertEquals(0, source.withdrawals)
        val response = CompletableDeferred<List<String>>()
        val read = async { reconciler.reconcile { response.await() } }
        runCurrent()
        reconciler.updatePendingResumes(emptySet())
        response.complete(listOf(source.sourceId))
        read.await()
        assertEquals(0, source.withdrawals)
    }

    @Test fun offline_failure_does_not_withdraw_a_source() = runTest {
        val source = OptIn("notes:local")
        val reconciler = SourceRemovalReconciler { listOf(source) }
        runCatching { reconciler.reconcile { error("offline") } }
        assertEquals(0, source.withdrawals)
    }
}
