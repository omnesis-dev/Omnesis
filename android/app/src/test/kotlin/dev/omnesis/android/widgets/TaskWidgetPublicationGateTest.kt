// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskWidgetPublicationGateTest {
    @Test fun unpair_render_cannot_be_overtaken_by_worker_that_already_read_private_tasks() {
        val gate = TaskWidgetPublicationGate()
        val current = AtomicReference<String?>("Private task from the paired gateway")
        val shown = Collections.synchronizedList(mutableListOf<String?>())
        val oldCaptured = CountDownLatch(1)
        val releaseOld = CountDownLatch(1)
        val unpairAttempted = CountDownLatch(1)
        val unpairPosted = CountDownLatch(1)
        val oldWorker = thread {
            gate.publish {
                val captured = current.get()
                oldCaptured.countDown()
                check(releaseOld.await(5, TimeUnit.SECONDS))
                shown += captured
            }
        }
        assertTrue(oldCaptured.await(5, TimeUnit.SECONDS))
        current.set(null)
        val lifecycle = thread {
            unpairAttempted.countDown()
            gate.publish {
                shown += current.get()
                unpairPosted.countDown()
            }
        }
        try {
            assertTrue(unpairAttempted.await(5, TimeUnit.SECONDS))
            // The newer lifecycle publication waits for the captured batch;
            // it must not post first and then be overwritten by private data.
            assertFalse(unpairPosted.await(100, TimeUnit.MILLISECONDS))
        } finally {
            releaseOld.countDown()
            oldWorker.join(5000)
            lifecycle.join(5000)
        }
        assertTrue(unpairPosted.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("Private task from the paired gateway", null), shown.toList())
        assertEquals(null, shown.last())
    }
}
