// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import dev.omnesis.android.ui.tasks.TaskFocusBus
import java.time.LocalDate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskWidgetDeepLinkTest {
    @Test fun `read-only task destination round trips reserved identifier characters`() {
        val link = TaskWidgetDeepLink(TaskWidgetDeepLink.View.MONTH, LocalDate.of(2028, 2, 29), "task /?#&+")
        assertEquals(link, TaskWidgetDeepLink.parse(link.uriString))
        assertEquals(null, TaskWidgetDeepLink.parse("omnesis://tasks?view=today&date=2028-02-29")?.taskId)
    }

    @Test fun `invalid calendar query structure and mutation inputs are refused`() {
        val invalid = listOf(
            "omnesis://tasks?view=today&date=2027-02-29",
            "omnesis://tasks?view=today&date=2026-13-01",
            "omnesis://tasks?view=today&date=0000-01-01",
            "omnesis://tasks?view=today&date=2026-1-01",
            "omnesis://tasks?view=today&date=2026-01-01&date=2026-01-02",
            "omnesis://tasks?view=today&date=2026-01-01&action=complete",
            "omnesis://tasks?view=done&date=2026-01-01",
            "omnesis://tasks?view=today&date=2026-01-01&task=",
            "omnesis://tasks?view=today&date=2026-01-01&task=%0Asecret",
            "omnesis://tasks?view=today&date=2026-01-01&task=%ZZ",
            "omnesis://user@tasks?view=today&date=2026-01-01",
            "omnesis://tasks:123?view=today&date=2026-01-01",
            "omnesis://tasks/path?view=today&date=2026-01-01",
            "omnesis://tasks?view=today&date=2026-01-01#fragment",
            "https://tasks?view=today&date=2026-01-01",
        )
        invalid.forEach { assertNull(it, TaskWidgetDeepLink.parse(it)) }
    }

    @Test fun `journal launch remains pending until shell handles it independently of task consumers`() {
        val bus = TaskFocusBus()
        val link = TaskWidgetDeepLink(TaskWidgetDeepLink.View.MONTH, LocalDate.of(2026, 11, 1))
        bus.postLaunch(link)
        val first = bus.launch.value!!
        bus.post("other-task")
        bus.consume(bus.request.value!!)
        assertEquals(first, bus.launch.value)
        bus.postLaunch(link)
        val second = bus.launch.value!!
        bus.consumeLaunch(first)
        assertEquals(second, bus.launch.value)
        bus.consumeLaunch(second)
        assertNull(bus.launch.value)
    }
}
