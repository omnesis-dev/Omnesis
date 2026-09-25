// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File

/**
 * Migration-only view of the legacy pairing store. [EncryptedPreferencesStore]
 * drains it into the sealed store on first access, then deletes it.
 */
internal interface LegacyPrefs {
    fun exists(): Boolean

    /** All string entries, decrypted; null when the file cannot be read (corrupt keyset). */
    fun read(): Map<String, String>?

    fun delete()
}

/**
 * Reads the deprecated androidx.security-crypto EncryptedSharedPreferences file
 * that previously held the pairing secrets. This is the only remaining use of
 * security-crypto in the app — the dependency can be dropped (together with this
 * class) once installs have rolled through a release that runs the migration.
 */
internal class SecurityCryptoLegacyPrefs(context: Context) : LegacyPrefs {

    private val appContext = context.applicationContext

    override fun exists(): Boolean =
        File(File(appContext.dataDir, "shared_prefs"), "$PREFS_NAME.xml").exists()

    override fun read(): Map<String, String>? = try {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val prefs = EncryptedSharedPreferences.create(
            appContext,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        prefs.all.entries.mapNotNull { (key, value) -> (value as? String)?.let { key to it } }.toMap()
    } catch (_: Exception) {
        null
    }

    override fun delete() {
        appContext.deleteSharedPreferences(PREFS_NAME)
    }

    private companion object {
        /** The prefs file name the legacy EncryptedSharedPreferences store used. */
        const val PREFS_NAME = "omnesis.pairing"
    }
}
