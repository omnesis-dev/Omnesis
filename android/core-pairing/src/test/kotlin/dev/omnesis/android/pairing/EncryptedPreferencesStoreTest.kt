// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedPreferencesStoreTest {

    // --- Fakes -------------------------------------------------------------------

    /** Reversible fake cipher: sealed tokens are visibly distinct from their plaintext. */
    private class FakePrefsCipher : PrefsCipher {
        override fun seal(plaintext: String) = PREFIX + plaintext.reversed()

        override fun open(sealed: String): String {
            if (!sealed.startsWith(PREFIX)) throw PrefsCipherException("not a sealed token")
            return sealed.removePrefix(PREFIX).reversed()
        }

        companion object {
            const val PREFIX = "sealed:"
        }
    }

    /** In-memory SharedPreferences; [failCommits] simulates a write that never lands. */
    private class FakeSharedPreferences : SharedPreferences {
        val values = mutableMapOf<String, String>()
        var failCommits = false

        override fun getAll(): MutableMap<String, *> = values.toMutableMap()

        override fun getString(key: String?, defValue: String?): String? = values[key] ?: defValue

        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? =
            defValues

        override fun getInt(key: String?, defValue: Int): Int = defValue

        override fun getLong(key: String?, defValue: Long): Long = defValue

        override fun getFloat(key: String?, defValue: Float): Float = defValue

        override fun getBoolean(key: String?, defValue: Boolean): Boolean = defValue

        override fun contains(key: String?): Boolean = values.containsKey(key)

        override fun edit(): SharedPreferences.Editor = FakeEditor()

        override fun registerOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener?,
        ) = Unit

        override fun unregisterOnSharedPreferenceChangeListener(
            listener: SharedPreferences.OnSharedPreferenceChangeListener?,
        ) = Unit

        private inner class FakeEditor : SharedPreferences.Editor {
            private val puts = mutableMapOf<String, String>()
            private val removes = mutableSetOf<String>()
            private var cleared = false

            override fun putString(key: String?, value: String?): SharedPreferences.Editor {
                puts[key!!] = value!!
                return this
            }

            override fun remove(key: String?): SharedPreferences.Editor {
                removes.add(key!!)
                return this
            }

            override fun clear(): SharedPreferences.Editor {
                cleared = true
                return this
            }

            override fun commit(): Boolean {
                if (failCommits) return false
                if (cleared) values.clear()
                removes.forEach { values.remove(it) }
                values.putAll(puts)
                return true
            }

            override fun apply() {
                commit()
            }

            override fun putStringSet(key: String?, values: MutableSet<String>?) =
                throw UnsupportedOperationException("unused by the store")

            override fun putInt(key: String?, value: Int) =
                throw UnsupportedOperationException("unused by the store")

            override fun putLong(key: String?, value: Long) =
                throw UnsupportedOperationException("unused by the store")

            override fun putFloat(key: String?, value: Float) =
                throw UnsupportedOperationException("unused by the store")

            override fun putBoolean(key: String?, value: Boolean) =
                throw UnsupportedOperationException("unused by the store")
        }
    }

    /** In-memory stand-in for the legacy EncryptedSharedPreferences file. */
    private class FakeLegacyPrefs(initial: Map<String, String>? = null) : LegacyPrefs {
        private var entries: MutableMap<String, String>? = initial?.toMutableMap()
        var unreadable = false
        var readCount = 0
            private set

        override fun exists(): Boolean = entries != null

        override fun read(): Map<String, String>? {
            readCount++
            return if (unreadable) null else entries?.toMap()
        }

        override fun delete() {
            entries = null
        }
    }

    private fun store(
        prefs: FakeSharedPreferences = FakeSharedPreferences(),
        legacy: LegacyPrefs = FakeLegacyPrefs(),
    ) = EncryptedPreferencesStore(prefs, FakePrefsCipher(), legacy)

    // --- Round trip ----------------------------------------------------------------

    @Test
    fun set_get_round_trips_and_never_stores_plaintext() {
        val prefs = FakeSharedPreferences()
        val store = store(prefs)

        store.set("gateway.token", "secret-token")

        assertEquals("secret-token", store.get("gateway.token"))
        // The backing file holds only the sealed token, never the plaintext.
        assertEquals(FakePrefsCipher.PREFIX + "secret-token".reversed(), prefs.values["gateway.token"])
        assertFalse(prefs.values.values.any { it.contains("secret-token") })
    }

    @Test
    fun delete_and_deleteAll_remove_values() {
        val store = store()
        store.set("gateway.url", "https://gw.example.com:7600")
        store.set("gateway.token", "secret-token")

        store.delete("gateway.url")
        assertNull(store.get("gateway.url"))
        assertEquals("secret-token", store.get("gateway.token"))

        store.deleteAll()
        assertNull(store.get("gateway.token"))
    }

    @Test
    fun replaceAll_is_one_synchronous_commit_and_failure_preserves_old_state() {
        val prefs = FakeSharedPreferences()
        val store = store(prefs)
        store.set("gateway.credential.v1", "active")
        prefs.failCommits = true

        assertThrows(IllegalStateException::class.java) {
            store.replaceAll(mapOf("gateway.pendingRevocation.v1" to "pending"))
        }
        prefs.failCommits = false
        assertEquals("active", store.get("gateway.credential.v1"))
        assertNull(store.get("gateway.pendingRevocation.v1"))

        store.replaceAll(mapOf("gateway.pendingRevocation.v1" to "pending"))
        assertNull(store.get("gateway.credential.v1"))
        assertEquals("pending", store.get("gateway.pendingRevocation.v1"))
    }

    // --- Corruption ------------------------------------------------------------------

    @Test
    fun corrupt_sealed_value_reads_as_absent_and_service_reports_unpaired() {
        val prefs = FakeSharedPreferences()
        prefs.values["gateway.token"] = "garbage-not-a-sealed-token"
        val store = store(prefs)

        assertNull(store.get("gateway.token"))
        // The service layer sees an unpaired device and asks for a re-pair — no crash.
        assertNull(PairingService(store).current())
    }

    // --- Migration ---------------------------------------------------------------------

    @Test
    fun legacy_data_migrates_once_then_legacy_is_deleted() {
        val legacy = FakeLegacyPrefs(
            mapOf(
                "gateway.url" to "https://gw.example.com:7600",
                "gateway.token" to "legacy-token",
            ),
        )
        val prefs = FakeSharedPreferences()
        val store = store(prefs, legacy)

        assertEquals("legacy-token", store.get("gateway.token"))
        assertEquals("https://gw.example.com:7600", store.get("gateway.url"))
        assertFalse(legacy.exists())
        assertEquals(1, legacy.readCount)

        // Further access does not re-read the legacy file.
        store.get("gateway.url")
        assertEquals(1, legacy.readCount)

        // Migrated values landed sealed, not as plaintext.
        assertFalse(prefs.values.values.any { it.contains("legacy-token") })
    }

    @Test
    fun no_legacy_means_no_migration_read() {
        val legacy = FakeLegacyPrefs()
        val store = store(legacy = legacy)

        assertNull(store.get("gateway.token"))
        assertEquals(0, legacy.readCount)
    }

    @Test
    fun migration_reruns_idempotently_when_crash_hit_between_commit_and_delete() {
        val data = mapOf("gateway.token" to "legacy-token")
        val prefs = FakeSharedPreferences()
        store(prefs, FakeLegacyPrefs(data)).get("gateway.token")

        // A crash between commit and delete leaves the sealed copy AND the legacy
        // file; model the next launch as a fresh store whose legacy still exists.
        val legacyAgain = FakeLegacyPrefs(data)
        val next = store(prefs, legacyAgain)

        assertEquals("legacy-token", next.get("gateway.token"))
        // Sealed state already existed, so the leftover is deleted UNREAD.
        assertFalse(legacyAgain.exists())
        assertEquals(0, legacyAgain.readCount)
    }

    @Test
    fun repair_after_failed_migration_is_not_clobbered_by_stale_legacy() {
        val legacy = FakeLegacyPrefs(
            mapOf(
                "gateway.token" to "stale-legacy-token",
                "gateway.url" to "https://old.example.com:7600",
            ),
        )
        val prefs = FakeSharedPreferences().apply { failCommits = true }
        val store = store(prefs, legacy)
        assertNull(store.get("gateway.token")) // migration attempt failed

        // The user re-pairs in-process while the legacy file is still around.
        prefs.failCommits = false
        store.set("gateway.token", "fresh-token")

        // Next launch: the sealed store is the newer truth — the stale legacy
        // values are never copied over it, and the file is dropped unread.
        val next = store(prefs, legacy)
        assertEquals("fresh-token", next.get("gateway.token"))
        assertNull(next.get("gateway.url"))
        assertFalse(legacy.exists())
        assertEquals(1, legacy.readCount) // only the first (failed) attempt read it
    }

    @Test
    fun deleteAll_drops_legacy_so_unpair_cannot_be_resurrected() {
        val legacy = FakeLegacyPrefs(mapOf("gateway.token" to "legacy-token"))
        val prefs = FakeSharedPreferences().apply { failCommits = true }
        val store = store(prefs, legacy)
        assertNull(store.get("gateway.token")) // migration attempt failed
        assertTrue(legacy.exists())

        // The user unpairs; the legacy file must die with the sealed state, or the
        // next launch's migration would silently resurrect the full pairing.
        prefs.failCommits = false
        store.deleteAll()
        assertFalse(legacy.exists())

        val next = store(prefs, legacy)
        assertNull(next.get("gateway.token"))
    }

    @Test
    fun failed_commit_leaves_legacy_intact_and_next_launch_retries() {
        val legacy = FakeLegacyPrefs(mapOf("gateway.token" to "legacy-token"))
        val prefs = FakeSharedPreferences().apply { failCommits = true }

        // The sealed write never lands, so the legacy file must survive.
        assertNull(store(prefs, legacy).get("gateway.token"))
        assertTrue(legacy.exists())
        assertTrue(prefs.values.isEmpty())

        // Next launch, commits work again: the migration completes.
        prefs.failCommits = false
        val next = store(prefs, legacy)
        assertEquals("legacy-token", next.get("gateway.token"))
        assertFalse(legacy.exists())
    }

    @Test
    fun unreadable_legacy_is_dropped_and_store_starts_fresh() {
        val legacy = FakeLegacyPrefs(mapOf("gateway.token" to "unrecoverable")).apply {
            unreadable = true
        }
        val store = store(legacy = legacy)

        assertNull(store.get("gateway.token"))
        // Dropped rather than retried forever; the user re-pairs.
        assertFalse(legacy.exists())

        // The store remains fully functional afterwards.
        store.set("gateway.token", "fresh-token")
        assertEquals("fresh-token", store.get("gateway.token"))
    }
}
