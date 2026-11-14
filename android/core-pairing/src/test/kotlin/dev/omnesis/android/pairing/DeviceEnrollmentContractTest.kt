// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import org.junit.Assert.*
import org.junit.Test
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/** The vectors are `packages/cloud-relay/src/device-enrollment.test.ts`'s, verbatim. Change them in all three places. */
class DeviceEnrollmentContractTest {
    private val requestId = "11111111-2222-4333-8444-555555555555"
    private val kind = "ios"
    private val name = "Maya’s iPhone \"16\"/é"
    private val secret = "a".repeat(64)
    private val devicePublicKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEGDyDirEL2lrGjSPy-YBjzDVmi8d4E-aXEboSjkFDnKjznab2Nbec2vu4J71RIvZmTL820xIfaxzOyXItT91cdQ"
    private val salt = "c2FsdHNhbHRzYWx0c2FsdHNhbHRzYWx0c2FsdHNhbHQ"
    private val issuedAt = "1794240000"
    private val challenge = "Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw"
    private val gatewaySpkiFingerprint = "b".repeat(64)
    private val nonce = DeviceEnrollmentContract.enrollmentNonce(requestId, kind, name, secret, devicePublicKey)

    @Test fun thumbprint() = assertEquals(
        "cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba",
        DeviceEnrollmentContract.deviceKeyThumbprint(devicePublicKey),
    )
    @Test fun `enrollment nonce`() = assertEquals("omSCKSEVp23kSohLBrNIqacoYRMiGzYGcjIUhbS6Utw", nonce)
    @Test fun `google nonce`() = assertEquals(
        "Z8TU9qZKGsXtT1SY13KcNLty5tRqlNr5UOvTqPcJeLc",
        DeviceEnrollmentContract.googleProofNonce(salt, nonce),
    )
    @Test fun `passkey challenge`() = assertEquals(
        "f-WX4FvBop2svycIMkHI019J6CxVseoBQsoKmoY5fHo",
        DeviceEnrollmentContract.passkeyProofChallenge(salt, issuedAt, nonce),
    )
    @Test fun `signature transcript`() = assertEquals(
        """["omnesis-device-enrollment-signature-v3","11111111-2222-4333-8444-555555555555","ios","5c543853f1bb8064d21e95a3a933cfbbb10f33c138e380e7003a483501b0b7a9","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw","cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba"]""",
        DeviceEnrollmentContract.enrollmentSignatureTranscript(requestId, kind, name, gatewaySpkiFingerprint, challenge, devicePublicKey).toString(Charsets.UTF_8),
    )
    @Test fun `rotation transcript`() = assertEquals(
        """["omnesis-device-token-rotation-v1","99999999-8888-4777-8666-555555555555","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Y2hhbGxlbmdlY2hhbGxlbmdlY2hhbGxlbmdlY2hhbGw","cf8e024c4f3ae3b188f18ea464529450e7d54f36ceafce6ac1db70b7668fa5ba"]""",
        DeviceEnrollmentContract.tokenRotationTranscript("99999999-8888-4777-8666-555555555555", gatewaySpkiFingerprint, challenge, devicePublicKey).toString(Charsets.UTF_8),
    )

    /** `packages/cloud-relay/src/gateway-passkey.test.ts`'s vectors, on the gateway page's origin. */
    @Test fun `gateway passkey challenges match the gateway's vectors for every purpose`() {
        val origin = "https://g-abcdefgh.relay.example.test"
        fun vector(purpose: String, binding: String) = DeviceEnrollmentContract.gatewayPasskeyChallenge(purpose, origin, challenge, binding)
        assertEquals("N54-1Hc8nIzZyGGjgVB2es2v2ut0AeLrQLlHiV9NaXM", vector("device-enrollment", nonce))
        assertEquals("s4TEruSndQL9XUX4vOZB8gLvPAjWmLWDn4hs6rqiev8", vector("approve-request", "l0NtUMoLWQPEqbViKuTTcNl21YlGfRT9uywbHtmcvzg"))
        assertEquals("mofVzFt_O3rjnPh-MGYHJ_17o3SpvObuqvY5jOi1uX4", vector("pin-passkey", "EAANDVb7NFK6CvK8jvrrt_qCOpVZtuhWoCGrICUHhsM"))
        assertEquals("uGxFctH1-FqRi73bqDy4iwjDPFJHx37qF8RGHMyJfnU", vector("step-up", "wAjeH2mnCBFwRS4nJrk5RaSmRfbLwLkGbSi1aF5o9bg"))
    }

    /** The same function in TypeScript (`gatewayPasskeyChallenge`), with the app's own origin. */
    @Test fun `in the app the challenge names the app's apk-key-hash origin`() {
        val app = "android:apk-key-hash:TPfeOsd2u2Uq8rCtF9DeGgc1m50jt6fPpDJYcUvAaCo"
        assertEquals("9of2vsQM7O9WUvlPVEJcoR6hDB_em4mPWcd_w7HLotY", DeviceEnrollmentContract.gatewayPasskeyChallenge("device-enrollment", app, challenge, nonce))
        assertEquals("Ya-uH3WpYI-yOGaMvUJTWj7vlpoa1QppRbGipQO4dyU",
            DeviceEnrollmentContract.gatewayPasskeyChallenge("approve-request", app, challenge, "l0NtUMoLWQPEqbViKuTTcNl21YlGfRT9uywbHtmcvzg"))
        // An assertion made for a page's origin and one made in the app never share a challenge.
        assertNotEquals(DeviceEnrollmentContract.gatewayPasskeyChallenge("device-enrollment", "https://g-abcdefgh.relay.example.test", challenge, nonce),
            DeviceEnrollmentContract.gatewayPasskeyChallenge("device-enrollment", app, challenge, nonce))
    }

    @Test fun `malformed gateway passkey parts are refused rather than hashed`() {
        assertThrows(IllegalArgumentException::class.java) { DeviceEnrollmentContract.gatewayPasskeyChallenge("other", "o", challenge, nonce) }
        assertThrows(IllegalArgumentException::class.java) { DeviceEnrollmentContract.gatewayPasskeyChallenge("step-up", "o", "short", nonce) }
    }

    @Test fun `the apk-key-hash origin is the base64url SHA-256 of the signing certificate`() {
        assertEquals("android:apk-key-hash:ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0", DeviceEnrollmentContract.androidApkKeyHashOrigin("abc".toByteArray()))
    }

    @Test fun `a device key publishes a base64url SPKI and signs DER the gateway can verify`() {
        val key = softwareDeviceKey()
        assertTrue(Regex("^[A-Za-z0-9_-]+$").matches(key.publicKey))
        val signature = key.sign("transcript".toByteArray())
        assertTrue(Regex("^[A-Za-z0-9_-]+$").matches(signature))
        val der = Base64.getUrlDecoder().decode(signature)
        assertEquals("DER SEQUENCE", 0x30, der[0].toInt())
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getUrlDecoder().decode(key.publicKey))))
        verifier.update("transcript".toByteArray())
        assertTrue(verifier.verify(der))
    }

    private class Backend(override val strongBoxAvailable: Boolean = true, var stored: DeviceKey? = null) : KeystoreDeviceKeys.Backend {
        val attempts = mutableListOf<Boolean>()
        var strongBoxFailure: Exception? = null
        override fun load() = stored
        override fun generate(strongBox: Boolean): DeviceKey {
            attempts += strongBox
            if (strongBox) strongBoxFailure?.let { throw it }
            return softwareDeviceKey().also { stored = it }
        }
    }

    @Test fun `one key per install is created once and then reloaded`() {
        val backend = Backend()
        val keys = KeystoreDeviceKeys(backend)
        val first = keys.loadOrCreate()
        assertSame(first, keys.loadOrCreate())
        assertEquals(listOf(true), backend.attempts)
    }

    @Test fun `StrongBox is preferred and its absence falls back to the ordinary Keystore`() {
        val missing = Backend().apply { strongBoxFailure = ProviderException("no StrongBox") }
        KeystoreDeviceKeys(missing).loadOrCreate()
        assertEquals(listOf(true, false), missing.attempts)
        val old = Backend(strongBoxAvailable = false)
        KeystoreDeviceKeys(old).loadOrCreate()
        assertEquals(listOf(false), old.attempts)
    }

    @Test fun `any other Keystore failure is not hidden by the fallback`() {
        val backend = Backend().apply { strongBoxFailure = IllegalStateException("broken") }
        assertThrows(IllegalStateException::class.java) { KeystoreDeviceKeys(backend).loadOrCreate() }
    }
}

/** A software P-256 key, so enrollment logic runs without a device. */
internal fun softwareDeviceKey(): DeviceKey {
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    return SigningDeviceKey(pair.private, pair.public)
}
