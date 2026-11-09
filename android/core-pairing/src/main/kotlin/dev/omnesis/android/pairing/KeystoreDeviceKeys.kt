// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.ProviderException
import java.security.spec.ECGenParameterSpec

/**
 * One P-256 key per install, held by the Android Keystore and inside StrongBox where the device
 * has one. It needs no user authentication: token rotation signs while the phone is unattended.
 * Unpairing keeps it, so a later sign-in can adopt the row that already holds this key.
 */
class KeystoreDeviceKeys internal constructor(private val backend: Backend) : DeviceKeyStore {
    constructor() : this(AndroidKeystoreBackend)

    internal interface Backend {
        val strongBoxAvailable: Boolean
        fun load(): DeviceKey?
        fun generate(strongBox: Boolean): DeviceKey
    }

    @Synchronized
    override fun loadOrCreate(): DeviceKey {
        backend.load()?.let { return it }
        if (backend.strongBoxAvailable) {
            try {
                return backend.generate(strongBox = true)
            } catch (_: ProviderException) {
                // StrongBoxUnavailableException, or a bare ProviderException on some OEMs.
            }
        }
        return backend.generate(strongBox = false)
    }

    private object AndroidKeystoreBackend : Backend {
        private const val PROVIDER = "AndroidKeyStore"
        private const val ALIAS = "omnesis-device-key"

        override val strongBoxAvailable get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P

        override fun load(): DeviceKey? {
            val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
            val entry = store.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry ?: return null
            return SigningDeviceKey(entry.privateKey, entry.certificate.publicKey)
        }

        override fun generate(strongBox: Boolean): DeviceKey {
            val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .apply { if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true) }
                .build()
            val pair = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
                .apply { initialize(spec) }
                .generateKeyPair()
            return SigningDeviceKey(pair.private, pair.public)
        }
    }
}
