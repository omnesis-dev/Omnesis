// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import android.content.Context
import android.content.SharedPreferences

/**
 * Pairing-secrets store (the iOS Keychain analogue). Holds the complete pairing
 * credential bundle and auxiliary push credentials. Each value is sealed through a
 * [PrefsCipher] — in production an Android Keystore AES-256-GCM key
 * ([KeystorePrefsCipher]) — and persisted as an opaque token in a plain
 * SharedPreferences file, so the plaintext never touches disk.
 *
 * On first access it drains any data left by the deprecated
 * androidx.security-crypto EncryptedSharedPreferences file this store previously
 * used (read legacy → seal into the new file → synchronous commit → delete legacy).
 * The migration is idempotent and crash-safe: the legacy file is deleted only after
 * the sealed copy is durably committed, so a crash at any point leaves either the
 * legacy file (retried next launch) or the migrated state — never neither. Sealed
 * state always wins: a legacy file found when the sealed store already holds data
 * is deleted unread, so a re-pair is never clobbered by stale legacy values.
 *
 * A value that can no longer be opened (corrupt token, rotated key) reads as
 * absent: callers observe an unpaired state and re-pair, never a crash.
 */
class EncryptedPreferencesStore internal constructor(
    private val prefs: SharedPreferences,
    private val cipher: PrefsCipher,
    private val legacy: LegacyPrefs,
) : SecureStore {

    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE),
        KeystorePrefsCipher(),
        SecurityCryptoLegacyPrefs(context),
    )

    @Volatile
    private var migrationAttempted = false

    override fun get(key: String): String? {
        ensureMigrated()
        val sealed = prefs.getString(key, null) ?: return null
        return try {
            cipher.open(sealed)
        } catch (_: PrefsCipherException) {
            null
        }
    }

    override fun set(key: String, value: String) {
        ensureMigrated()
        prefs.edit().putString(key, cipher.seal(value)).apply()
    }

    override fun delete(key: String) {
        ensureMigrated()
        prefs.edit().remove(key).apply()
    }

    override fun deleteAll() {
        ensureMigrated()
        prefs.edit().clear().apply()
        // Unpair kills the legacy file too: if a migration attempt failed earlier,
        // a surviving legacy file would resurrect the full pairing (URL + token)
        // on the next launch. Idempotent — usually the file is already gone.
        legacy.delete()
    }

    override fun replaceAll(values: Map<String, String>) {
        ensureMigrated()
        val editor = prefs.edit().clear()
        values.forEach { (key, value) -> editor.putString(key, cipher.seal(value)) }
        check(editor.commit()) { "Could not durably replace pairing state" }
        legacy.delete()
    }

    /**
     * Migration is attempted at most once per store instance; a failed attempt
     * (commit refused, cipher error) leaves the legacy file in place so the next
     * launch retries.
     */
    private fun ensureMigrated() {
        if (migrationAttempted) return
        synchronized(this) {
            if (migrationAttempted) return
            runCatching { migrateLegacy() }
            migrationAttempted = true
        }
    }

    private fun migrateLegacy() {
        if (!legacy.exists()) return
        if (prefs.all.isNotEmpty()) {
            // The sealed store already holds state — either a crash landed between
            // commit and legacy-delete, or the user re-paired after a failed
            // attempt. Sealed state is always the newer truth: never clobber it
            // with stale legacy values; just finish the cleanup.
            legacy.delete()
            return
        }
        val entries = legacy.read()
        if (entries == null) {
            // Unreadable legacy file (corrupt keyset): the pairing is unrecoverable —
            // drop it and let the user re-pair instead of retrying forever.
            legacy.delete()
            return
        }
        val editor = prefs.edit()
        for ((key, value) in entries) editor.putString(key, cipher.seal(value))
        // Synchronous commit: delete the legacy file only once the sealed copy is
        // durable. A crash between the two re-runs this (idempotent) migration.
        if (editor.commit()) legacy.delete()
    }

    private companion object {
        /** Sealed-token prefs file; distinct from the legacy file name so the two never collide. */
        const val PREFS_NAME = "omnesis.pairing.sealed"
    }
}
