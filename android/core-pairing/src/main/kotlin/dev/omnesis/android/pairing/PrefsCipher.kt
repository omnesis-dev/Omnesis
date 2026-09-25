// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

/**
 * Crypto seam for [EncryptedPreferencesStore]: seals a preference value into an
 * opaque token safe to persist in a plain SharedPreferences file, and opens it
 * back. Production is [KeystorePrefsCipher]; tests substitute an in-memory fake.
 */
interface PrefsCipher {
    /** Encrypts [plaintext] into a self-contained token (version, IV, ciphertext). */
    fun seal(plaintext: String): String

    /**
     * Decrypts a token produced by [seal].
     *
     * @throws PrefsCipherException when the token is malformed or cannot be
     *   authenticated/decrypted (corrupt data, a rotated or invalidated key).
     */
    fun open(sealed: String): String
}

/** Thrown by [PrefsCipher.open] when a sealed token cannot be opened. */
class PrefsCipherException(message: String, cause: Throwable? = null) : Exception(message, cause)
