// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.ModelBehaviorSettings
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class BehaviorSaveQueueTest {
    @Test fun rapid_choices_are_serialized_and_the_latest_unsent_choice_wins() = runTest {
        val firstWrite = CompletableDeferred<Unit>()
        val writes = mutableListOf<BehaviorSaveRequest>()
        var inFlight = 0
        var maxInFlight = 0
        val queue = BehaviorSaveQueue(
            scope = this,
            write = { request ->
                inFlight++
                maxInFlight = maxOf(maxInFlight, inFlight)
                writes += request
                if (writes.size == 1) firstWrite.await()
                inFlight--
            },
            onResult = { _, error -> if (error != null) throw error },
        )
        fun choice(effort: String) = BehaviorSaveRequest(
            "agent", "openrouter/reasoner-v1", ModelBehaviorValues(reasoningEffort = effort),
        )
        queue.submit(choice("low"))
        runCurrent()
        queue.submit(choice("medium"))
        queue.submit(choice("high"))
        firstWrite.complete(Unit)
        runCurrent()

        assertEquals(listOf(choice("low"), choice("high")), writes)
        assertEquals(1, maxInFlight)
        assertEquals(false, queue.hasUnsent)
    }

    @Test fun a_second_role_is_not_discarded_when_the_first_role_changes_again() = runTest {
        val firstWrite = CompletableDeferred<Unit>()
        val writes = mutableListOf<BehaviorSaveRequest>()
        val queue = BehaviorSaveQueue(
            scope = this,
            write = { request ->
                writes += request
                if (writes.size == 1) firstWrite.await()
            },
            onResult = { _, error -> if (error != null) throw error },
        )
        val first = BehaviorSaveRequest("agent", "openrouter/reasoner-v1", ModelBehaviorValues(reasoningEffort = "low"))
        val later = first.copy(values = ModelBehaviorValues(reasoningEffort = "high"))
        val judge = BehaviorSaveRequest("brief-judge", "openrouter/judge-v1", ModelBehaviorValues(reasoningEnabled = false))
        queue.submit(first)
        runCurrent()
        queue.submit(judge)
        queue.submit(later)
        firstWrite.complete(Unit)
        runCurrent()

        assertEquals(listOf(first, judge, later), writes)
    }

    @Test fun budget_typing_waits_four_hundred_milliseconds_and_invalid_input_cancels_it() = runTest {
        val writes = mutableListOf<BehaviorSaveRequest>()
        val queue = BehaviorSaveQueue(scope = this, write = { writes += it },
            onResult = { _, error -> if (error != null) throw error })
        val first = BehaviorSaveRequest("agent", "openrouter/reasoner-v1",
            ModelBehaviorValues(reasoningBudgetTokens = 256))
        val last = first.copy(values = ModelBehaviorValues(reasoningBudgetTokens = 1024))
        queue.submitBudget("agent", first)
        advanceTimeBy(200)
        queue.submitBudget("agent", last)
        advanceTimeBy(399)
        runCurrent()
        assertEquals(emptyList<BehaviorSaveRequest>(), writes)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(listOf(last), writes)

        queue.submitBudget("agent", first)
        advanceTimeBy(200)
        queue.submitBudget("agent", null)
        advanceTimeBy(500)
        runCurrent()
        assertEquals(listOf(last), writes)

        queue.submitBudget("agent", first)
        advanceTimeBy(200)
        val effort = first.copy(values = ModelBehaviorValues(reasoningEffort = "high"))
        queue.submit(effort)
        advanceTimeBy(500)
        runCurrent()
        assertEquals(listOf(last, effort), writes)
    }

    @Test fun each_serial_patch_uses_the_last_acknowledged_values_as_its_cas_baseline() = runTest {
        val firstWrite = CompletableDeferred<Unit>()
        val baseline = BehaviorSaveBaseline().apply {
            replace(mapOf("agent" to ModelBehaviorSettings(
                "openrouter/reasoner-v1", ModelBehaviorValues(reasoningEffort = "low"),
            )))
        }
        val sent = mutableListOf<Pair<ModelBehaviorValues?, ModelBehaviorValues>>()
        val queue = BehaviorSaveQueue(
            scope = this,
            write = { request ->
                sent += baseline.expected(request) to request.values
                if (sent.size == 1) firstWrite.await()
            },
            onResult = { request, error ->
                if (error != null) throw error
                baseline.acknowledge(request)
            },
        )
        fun choice(effort: String) = BehaviorSaveRequest(
            "agent", "openrouter/reasoner-v1", ModelBehaviorValues(reasoningEffort = effort),
        )
        queue.submit(choice("medium"))
        runCurrent()
        queue.submit(choice("high"))
        firstWrite.complete(Unit)
        runCurrent()

        assertEquals(listOf(
            ModelBehaviorValues(reasoningEffort = "low") to ModelBehaviorValues(reasoningEffort = "medium"),
            ModelBehaviorValues(reasoningEffort = "medium") to ModelBehaviorValues(reasoningEffort = "high"),
        ), sent)
    }

    @Test fun a_conflict_discards_queued_and_debounced_choices_without_an_automatic_retry() = runTest {
        val firstWrite = CompletableDeferred<Unit>()
        val writes = mutableListOf<BehaviorSaveRequest>()
        lateinit var queue: BehaviorSaveQueue
        queue = BehaviorSaveQueue(
            scope = this,
            write = { request ->
                writes += request
                if (writes.size == 1) firstWrite.await()
                if (writes.size == 1) throw IllegalStateException("409")
            },
            onResult = { request, error ->
                if (error?.message == "409") queue.discard(request.role)
            },
        )
        val first = BehaviorSaveRequest("agent", "openrouter/reasoner-v1",
            ModelBehaviorValues(reasoningEffort = "low"))
        queue.submit(first)
        runCurrent()
        queue.submit(first.copy(values = ModelBehaviorValues(reasoningEffort = "high")))
        queue.submitBudget("agent", first.copy(values = ModelBehaviorValues(reasoningBudgetTokens = 512)))
        val otherRole = BehaviorSaveRequest("brief-judge", "openrouter/judge-v1",
            ModelBehaviorValues(reasoningEnabled = false))
        queue.submit(otherRole)
        firstWrite.complete(Unit)
        advanceTimeBy(500)
        runCurrent()

        assertEquals(listOf(first, otherRole), writes)
        assertEquals(false, queue.hasWork)
    }

    @Test fun a_debounced_budget_draft_prevents_a_refresh_from_adopting_external_values() = runTest {
        val firstWrite = CompletableDeferred<Unit>()
        val baseline = BehaviorSaveBaseline().apply {
            replace(mapOf("agent" to ModelBehaviorSettings("openrouter/reasoner-v1",
                ModelBehaviorValues(reasoningEffort = "low"))))
        }
        val expected = mutableListOf<ModelBehaviorValues?>()
        lateinit var queue: BehaviorSaveQueue
        queue = BehaviorSaveQueue(
            scope = this,
            write = { request ->
                expected += baseline.expected(request)
                if (expected.size == 1) firstWrite.await()
            },
            onResult = { request, error ->
                if (error != null) throw error
                baseline.acknowledge(request)
                if (!queue.hasUnsent) baseline.replace(mapOf("agent" to ModelBehaviorSettings(
                    "openrouter/reasoner-v1", ModelBehaviorValues(reasoningEffort = "external"),
                )))
            },
        )
        queue.submit(BehaviorSaveRequest("agent", "openrouter/reasoner-v1",
            ModelBehaviorValues(reasoningEffort = "medium")))
        runCurrent()
        queue.submitBudget("agent", BehaviorSaveRequest("agent", "openrouter/reasoner-v1",
            ModelBehaviorValues(reasoningBudgetTokens = 256)))
        assertEquals(setOf("agent"), queue.unsentRoles)
        firstWrite.complete(Unit)
        runCurrent()
        assertEquals(ModelBehaviorValues(reasoningEffort = "medium"), baseline.expected(
            BehaviorSaveRequest("agent", "openrouter/reasoner-v1", ModelBehaviorValues()),
        ))
        advanceTimeBy(400)
        runCurrent()
        assertEquals(listOf(
            ModelBehaviorValues(reasoningEffort = "low"),
            ModelBehaviorValues(reasoningEffort = "medium"),
        ), expected)
    }

    @Test fun a_role_conflict_refresh_preserves_another_roles_queued_cas_baseline() = runTest {
        val firstWrite = CompletableDeferred<Unit>()
        val baseline = BehaviorSaveBaseline().apply {
            replace(mapOf(
                "agent" to ModelBehaviorSettings("openrouter/reasoner-v1",
                    ModelBehaviorValues(reasoningEffort = "low")),
                "brief-judge" to ModelBehaviorSettings("openrouter/judge-v1",
                    ModelBehaviorValues(reasoningEffort = "low")),
            ))
        }
        val expected = mutableMapOf<String, ModelBehaviorValues?>()
        lateinit var queue: BehaviorSaveQueue
        queue = BehaviorSaveQueue(
            scope = this,
            write = { request ->
                expected[request.role] = baseline.expected(request)
                if (request.role == "agent") {
                    firstWrite.await()
                    throw IllegalStateException("409")
                }
            },
            onResult = { request, error ->
                if (error?.message == "409") {
                    queue.discard(request.role)
                    baseline.replace(mapOf(
                        "agent" to ModelBehaviorSettings("openrouter/reasoner-v1",
                            ModelBehaviorValues(reasoningEffort = "external")),
                        "brief-judge" to ModelBehaviorSettings("openrouter/judge-v1",
                            ModelBehaviorValues(reasoningEffort = "external")),
                    ), preserveRoles = queue.protectedRoles - request.role)
                }
            },
        )
        queue.submit(BehaviorSaveRequest("agent", "openrouter/reasoner-v1",
            ModelBehaviorValues(reasoningEffort = "high")))
        runCurrent()
        queue.submit(BehaviorSaveRequest("brief-judge", "openrouter/judge-v1",
            ModelBehaviorValues(reasoningEffort = "high")))
        firstWrite.complete(Unit)
        runCurrent()

        assertEquals(ModelBehaviorValues(reasoningEffort = "low"), expected["brief-judge"])
        assertEquals(ModelBehaviorValues(reasoningEffort = "external"), baseline.expected(
            BehaviorSaveRequest("agent", "openrouter/reasoner-v1", ModelBehaviorValues()),
        ))
    }

    @Test fun an_idle_overview_poll_aligns_the_confirmed_baseline_for_the_next_deliberate_choice() = runTest {
        val writeDone = CompletableDeferred<Unit>()
        val baseline = BehaviorSaveBaseline().apply {
            replace(mapOf("agent" to ModelBehaviorSettings("openrouter/reasoner-v1",
                ModelBehaviorValues(reasoningEffort = "low"))))
        }
        val queue = BehaviorSaveQueue(scope = this, write = { writeDone.await() }, onResult = { _, _ -> })
        queue.submit(BehaviorSaveRequest("agent", "openrouter/reasoner-v1",
            ModelBehaviorValues(reasoningEffort = "medium")))
        runCurrent()
        val external = mapOf("agent" to ModelBehaviorSettings("openrouter/reasoner-v1",
            ModelBehaviorValues(reasoningEffort = "high")))
        if (!queue.hasWork) baseline.replace(external)
        assertEquals(ModelBehaviorValues(reasoningEffort = "low"), baseline.expected(
            BehaviorSaveRequest("agent", "openrouter/reasoner-v1", ModelBehaviorValues()),
        ))
        writeDone.complete(Unit)
        runCurrent()
        if (!queue.hasWork) baseline.replace(external)

        assertEquals(ModelBehaviorValues(reasoningEffort = "high"), baseline.expected(
            BehaviorSaveRequest("agent", "openrouter/reasoner-v1",
                ModelBehaviorValues(reasoningEffort = "medium")),
        ))
    }
}
