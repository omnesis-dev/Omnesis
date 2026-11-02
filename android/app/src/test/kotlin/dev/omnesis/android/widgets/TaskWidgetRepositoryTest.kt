// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.client.TaskView
import java.time.LocalDate
import java.util.Locale
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class TaskWidgetRepositoryTest {
    private val today = LocalDate.of(2026, 10, 14)
    private fun state(period: TaskWidgetPeriod = TaskWidgetPeriod.DAY, offset: Int = 0) = TaskWidgetState(period, offset)
    private fun task(id: String, plan: String? = null, due: String? = null) =
        WidgetTask(id = id, title = "Plan a community workshop", scheduledFor = plan, dueDay = due)
    private val pairing = Pairing("https://gateway.example.com", "test-token", "generation-one", deviceId = "widget-phone",
        gatewayName = "Example gateway", tlsMode = PairingTlsMode.SYSTEM)

    @Test fun future_day_excludes_carry_and_resolved_tasks_and_advances_deadlines() {
        val tasks = listOf(task("carry", "2026-10-10"), task("tomorrow", "2026-10-15"),
            task("due", "2026-11-04", "2026-10-15"), task("done", "2026-10-15").copy(state = "done"),
            task("suggestion", "2026-10-15").copy(origin = "brain"))
        assertEquals(setOf("due", "tomorrow"), TaskWidgetSchedule.tasks(tasks, state(offset = 1), today).map { it.id }.toSet())
        assertEquals(listOf("carry"), TaskWidgetSchedule.tasks(tasks, state(), today).map { it.id })
    }

    @Test fun month_plans_and_month_deadline_day_have_no_invented_schedule_day() {
        val tasks = listOf(task("month", "2026-11"), task("day", "2026-11-04"), task("due", due = "2026-11-08"),
            task("anytime"), task("monthly-due", "2026-11", "2026-11-05"))
        assertEquals(setOf("month", "day", "due", "monthly-due"),
            TaskWidgetSchedule.tasks(tasks, state(TaskWidgetPeriod.MONTH, 1), today).map { it.id }.toSet())
        val november5 = LocalDate.of(2026, 11, 5)
        assertFalse(TaskWidgetSchedule.tasks(tasks, state(), november5.minusDays(1)).any { it.id == "monthly-due" })
        assertEquals(listOf("monthly-due"), TaskWidgetSchedule.tasks(tasks, state(offset = 1), november5.minusDays(1)).map { it.id })
    }

    @Test fun local_week_start_and_year_month_navigation_follow_calendar() {
        val tasks = listOf(task("carry", "2026-10-01"), task("sunday", "2026-10-18"), task("monday", "2026-10-19"))
        assertEquals(setOf("carry", "sunday"), TaskWidgetSchedule.tasks(tasks, state(TaskWidgetPeriod.WEEK), today, Locale.UK).map { it.id }.toSet())
        assertEquals(listOf("monday"), TaskWidgetSchedule.tasks(tasks, state(TaskWidgetPeriod.WEEK, 1), today, Locale.UK).map { it.id })
        assertEquals(LocalDate.of(2027, 1, 31), TaskWidgetSchedule.anchor(state(TaskWidgetPeriod.MONTH, 1), LocalDate.of(2026, 12, 31)))
    }

    @Test fun unknown_open_state_is_forward_compatible_but_unaccepted_suggestions_stay_hidden() {
        val tasks = listOf(task("future-state", "2026-10-14").copy(state = "new-open-state"),
            task("suggested", "2026-10-14").copy(origin = "brain"),
            task("accepted", "2026-10-14").copy(origin = "brain", accepted = true))
        assertEquals(listOf("accepted", "future-state"), TaskWidgetSchedule.tasks(tasks, state(), today).map { it.id })
    }

    @Test fun today_sorts_all_open_tasks_by_creation_before_widget_paging() {
        val tasks = listOf(
            task("old", "2026-10-14").copy(createdAt = "2026-10-10T08:00:00Z"),
            task("b-tie", "2026-10-14").copy(createdAt = "2026-10-14T10:00:00Z"),
            task("new-carried", "2026-10-12").copy(createdAt = "2026-10-14T11:00:00Z"),
            task("a-tie", "2026-11-01", "2026-10-14").copy(createdAt = "2026-10-14T10:00:00Z"),
            task("undated", "2026-10-10"),
        )
        val result = TaskWidgetSchedule.tasks(tasks, state(), today)
        assertEquals(listOf("new-carried", "a-tie", "b-tie", "old", "undated"), result.map { it.id })
        assertEquals(listOf("new-carried", "a-tie"), result.take(2).map { it.id })
    }

    @Test fun future_days_keep_schedule_order_and_older_creation_first() {
        val tasks = listOf(task("new", "2026-10-15").copy(createdAt = "2026-10-14T10:00:00Z"),
            task("old", "2026-10-15").copy(createdAt = "2026-10-14T08:00:00Z"))
        assertEquals(listOf("old", "new"), TaskWidgetSchedule.tasks(tasks, state(offset = 1), today).map { it.id })
    }

    @Test fun today_uses_newest_creation_before_identifier() {
        val tasks = listOf(task("a", "2026-10-14").copy(createdAt = "2026-10-10T09:00:00Z"),
            task("z", "2026-10-14").copy(createdAt = "2026-10-09T09:00:00Z"))
        assertEquals(listOf("a", "z"), TaskWidgetSchedule.tasks(tasks, state(), today).map { it.id })
    }

    private class Cache : WidgetSnapshotStore {
        var authority: String? = null
        var value: TaskWidgetSnapshot? = null
        var failSave = false
        override fun read(authority: String) = value.takeIf { this.authority == authority }
        override fun save(authority: String, snapshot: TaskWidgetSnapshot) {
            if (failSave) error("local cache unavailable")
            this.authority = authority
            value = snapshot
        }
        override fun clear() { authority = null; value = null }
    }

    private class Gateway : WidgetTasksGateway {
        var failure: Exception? = null
        var readGate: CompletableDeferred<Unit>? = null
        var entered = CompletableDeferred<Unit>()
        var values = listOf(WidgetTask("one", "Read a new chapter", scheduledFor = "2026-10-14"))
        val requested = mutableListOf<TaskView>()
        val completed = mutableListOf<String>()
        override suspend fun tasks(view: TaskView, day: String): List<WidgetTask> {
            requested += view
            entered.complete(Unit)
            readGate?.await()
            failure?.let { throw it }
            return values
        }
        override suspend fun complete(id: String) { failure?.let { throw it }; completed += id }
    }

    @Test fun fetch_reads_complete_partitions_deduplicates_and_excludes_suggestions() = runTest {
        val gateway = Gateway()
        gateway.values += WidgetTask("suggestion", "A suggestion", origin = "brain")
        val cache = Cache()
        val repository = TaskWidgetRepository({ pairing }, cache, { gateway }, { 100 }, { today })
        assertEquals(listOf("one"), repository.refresh().snapshot?.tasks?.map { it.id })
        assertEquals(listOf(TaskView.TODAY, TaskView.MONTH, TaskView.FUTURE, TaskView.ANYTIME), gateway.requested)
    }

    @Test fun network_failure_preserves_cache_and_auth_failure_hides_it() = runTest {
        val cache = Cache()
        val gateway = Gateway()
        val repository = TaskWidgetRepository({ pairing }, cache, { gateway }, { 100 }, { today })
        repository.refresh()
        gateway.failure = IllegalStateException("offline")
        assertEquals(TaskWidgetStatus.OFFLINE, repository.refresh().status)
        assertNotNull(cache.value)
        gateway.failure = GatewayException.Unauthorized()
        assertEquals(TaskWidgetStatus.UNPAIRED, repository.refresh().status)
        assertNull(cache.value)
    }

    @Test fun stale_rendered_authority_never_sends_completion_to_new_pairing() = runTest {
        val gateway = Gateway()
        val replacement = pairing.copy(token = "new-test-token", pairingGeneration = "generation-two")
        val repository = TaskWidgetRepository({ replacement }, Cache(), { gateway })
        try {
            repository.complete("one", TaskWidgetRepository.authority(pairing))
            fail("Expected stale authority refusal")
        } catch (_: StaleWidgetAuthority) { }
        assertTrue(gateway.completed.isEmpty())
        assertNotEquals(TaskWidgetRepository.authority(pairing), TaskWidgetRepository.authority(replacement))
    }

    @Test fun completion_failure_keeps_row_and_confirmed_success_removes_it() = runTest {
        val gateway = Gateway()
        val cache = Cache()
        val repository = TaskWidgetRepository({ pairing }, cache, { gateway }, { 100 }, { today })
        repository.refresh()
        gateway.failure = GatewayException.Network(Exception("offline"))
        try { repository.complete("one", TaskWidgetRepository.authority(pairing)); fail("Expected failure") }
        catch (_: GatewayException.Network) { }
        assertEquals(1, cache.value?.tasks?.size)
        gateway.failure = null
        repository.complete("one", TaskWidgetRepository.authority(pairing))
        assertTrue(cache.value?.tasks?.isEmpty() == true)
        assertEquals(listOf("one"), gateway.completed)
    }

    @Test fun cache_failure_after_confirmed_completion_does_not_report_action_failure() = runTest {
        val cache = Cache()
        val gateway = Gateway()
        val repository = TaskWidgetRepository({ pairing }, cache, { gateway }, { 100 }, { today })
        repository.refresh()
        cache.failSave = true
        repository.complete("one", TaskWidgetRepository.authority(pairing))
        assertEquals(listOf("one"), gateway.completed)
    }

    @Test fun old_account_fetch_cannot_populate_new_account_cache() = runTest {
        val cache = Cache()
        val gateway = Gateway().apply { readGate = CompletableDeferred() }
        var current = pairing
        val repository = TaskWidgetRepository({ current }, cache, { gateway }, { 100 }, { today })
        val read = async { repository.refresh() }
        gateway.entered.await()
        current = pairing.copy(token = "replacement-token")
        gateway.readGate!!.complete(Unit)
        assertEquals(TaskWidgetStatus.UNPAIRED, read.await().status)
        assertNull(cache.value)
    }
}
