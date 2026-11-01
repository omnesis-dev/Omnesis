// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.widgets

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.pairing.PrefsCipher
import dev.omnesis.android.pairing.PrefsCipherException
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TaskWidgetStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    /** Tests use an opaque table so plaintext-in-preferences would fail the assertion below. */
    private class Cipher : PrefsCipher {
        val plaintext = mutableMapOf<String, String>()
        override fun seal(plaintext: String): String {
            val key = "sealed-${this.plaintext.size}"
            this.plaintext[key] = plaintext
            return key
        }
        override fun open(sealed: String): String = plaintext[sealed] ?: throw PrefsCipherException("missing test ciphertext")
    }

    @Test fun compact_snapshot_is_encrypted_and_bound_to_its_authority() {
        val prefs = context.getSharedPreferences("widget-test-encryption", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val cache = TaskWidgetCache(prefs, Cipher()) { "account-one" }
        val snapshot = TaskWidgetSnapshot(listOf(WidgetTask("one", "Read a new chapter")), 100)
        cache.save("account-one", snapshot)
        assertFalse(prefs.all.toString().contains("Read a new chapter"))
        assertEquals(snapshot, cache.read("account-one"))
        assertNull(cache.read("account-two"))
        cache.clear()
        assertNull(cache.read("account-one"))
    }

    @Test fun older_network_snapshot_cannot_resurrect_a_completed_task() {
        val prefs = context.getSharedPreferences("widget-test-ordering", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val cache = TaskWidgetCache(prefs, Cipher()) { "account-one" }
        val old = TaskWidgetSnapshot(listOf(WidgetTask("one", "Read a new chapter")), 100)
        cache.save("account-one", old)
        cache.save("account-one", old.copy(tasks = emptyList(), updatedAt = 200))
        cache.save("account-one", old)
        assertEquals(emptyList<WidgetTask>(), cache.read("account-one")?.tasks)
    }

    @Test fun late_old_account_write_cannot_repopulate_content_erased_during_unpair() {
        val prefs = context.getSharedPreferences("widget-test-unpair-fence", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        var current: String? = "account-one"
        val cache = TaskWidgetCache(prefs, Cipher()) { current }
        val captured = TaskWidgetSnapshot(listOf(WidgetTask("one", "Read a new chapter")), 100)
        cache.save("account-one", captured)
        assertEquals(captured, cache.read("account-one"))

        // A fetch has already captured its old authority when lifecycle
        // invalidation persists the unpaired state and erases the cache.
        current = null
        cache.clear()
        cache.save("account-one", captured.copy(updatedAt = 200))
        assertTrue(prefs.all.isEmpty())
        assertNull(cache.read("account-one"))

        current = "account-two"
        val replacement = TaskWidgetSnapshot(listOf(WidgetTask("two", "Choose a new recipe")), 300)
        cache.save("account-two", replacement)
        cache.save("account-one", captured.copy(updatedAt = 400))
        assertEquals(replacement, cache.read("account-two"))
        assertNull(cache.read("account-one"))
    }

    @Test fun presentation_state_is_independent_for_every_widget() {
        val store = TaskWidgetStore(context)
        store.save(31, TaskWidgetState(TaskWidgetPeriod.MONTH, offset = 1, page = 2))
        store.save(32, TaskWidgetState(TaskWidgetPeriod.DAY, offset = 1))
        assertEquals(TaskWidgetPeriod.MONTH, store.state(31).period)
        assertEquals(2, store.state(31).page)
        assertEquals(TaskWidgetPeriod.DAY, store.state(32).period)
        assertEquals(0, store.state(32).page)
        store.delete(31)
        assertEquals(TaskWidgetState(), store.state(31))
        assertEquals(1, store.state(32).offset)
    }

    @Test fun completion_capability_is_immutable_explicit_and_distinct_per_authority() {
        val first = TaskWidgetIntents.action(context, 31, TaskWidgetIntents.COMPLETE, "first-authority", "one")
        val second = TaskWidgetIntents.action(context, 31, TaskWidgetIntents.COMPLETE, "second-authority", "one")
        assertNotEquals(first, second)
        assertTrue(first.isImmutable)
        val intent = shadowOf(first).savedIntent
        assertEquals(TasksWidgetProvider::class.java.name, intent.component?.className)
        assertEquals("first-authority", intent.getStringExtra(TaskWidgetIntents.AUTHORITY))
        assertEquals("one", intent.getStringExtra(TaskWidgetIntents.TASK))
    }
}
