// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * [PrefsCipher] backed by an AES-256-GCM key held in the Android Keystore, so the
 * key material never enters app memory (hardware-backed on devices with a TEE, and
 * inside the StrongBox secure element where one is present). Sealed tokens are
 * `v1:<base64 iv>:<base64 ciphertext+tag>` with a fresh Keystore-generated IV per
 * seal. The key does not require user authentication: the pairing secrets must be
 * readable by background sync while the device is unlocked but unattended.
 */
class KeystorePrefsCipher : PrefsCipher {

    override fun seal(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val b64 = Base64.getEncoder()
        return "$TOKEN_VERSION:${b64.encodeToString(cipher.iv)}:${b64.encodeToString(ciphertext)}"
    }

    override fun open(sealed: String): String {
        val parts = sealed.split(':')
        if (parts.size != 3 || parts[0] != TOKEN_VERSION) {
            throw PrefsCipherException("unrecognized sealed-token format")
        }
        try {
            val b64 = Base64.getDecoder()
            val iv = b64.decode(parts[1])
            val ciphertext = b64.decode(parts[2])
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, iv))
            return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (e: Exception) {
            // Anything here — bad base64, a GCM tag mismatch, a rotated or
            // invalidated key, a Keystore provider error — means the token cannot
            // be opened. Surface it as the seam's exception so the store can treat
            // the value as absent instead of crashing a read path.
            throw PrefsCipherException("failed to open sealed token", e)
        }
    }

    /** Returns the sealing key, generating it inside the Android Keystore on first use. */
    @Synchronized
    private fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                return generateKey(strongBox = true)
            } catch (_: Exception) {
                // No StrongBox on this device (StrongBoxUnavailableException, or a
                // ProviderException on some OEMs) — fall back to the default
                // TEE-backed Keystore below.
            }
        }
        return generateKey(strongBox = false)
    }

    private fun generateKey(strongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .apply {
                if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    setIsStrongBoxBacked(true)
                }
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    private companion object {
        const val KEY_ALIAS = "omnesis-prefs-key"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TOKEN_VERSION = "v1"
        const val GCM_TAG_BITS = 128
    }
}
