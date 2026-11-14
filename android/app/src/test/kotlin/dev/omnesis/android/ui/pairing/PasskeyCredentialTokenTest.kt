// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import android.content.MutableContextWrapper
import android.content.pm.PackageInfo
import android.content.pm.Signature
import android.content.pm.SigningInfo
import android.util.Log
import androidx.credentials.Credential
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.domerrors.SecurityError
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.pairing.DeviceEnrollmentContract
import dev.omnesis.android.pairing.GatewayPasskeySigner
import java.lang.reflect.Proxy
import kotlin.coroutines.Continuation
import kotlin.coroutines.intrinsics.COROUTINE_SUSPENDED
import kotlin.coroutines.intrinsics.intercepted
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowLog
import org.robolectric.shadows.ShadowSigningInfo

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PasskeyCredentialTokenTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private val rpId = "relay.example.test"
    private val options get() = JSONObject().put("rpId", rpId)
        .put("challenge", "a".repeat(43)).put("userVerification", "required").toString()
    private fun manager(get: (Context, GetCredentialRequest) -> Credential): CredentialManager =
        Proxy.newProxyInstance(CredentialManager::class.java.classLoader, arrayOf(CredentialManager::class.java)) { _, method, args ->
            check(method.name == "getCredential")
            GetCredentialResponse(get(args!![0] as Context, args[1] as GetCredentialRequest))
        } as CredentialManager

    /** Credential exceptions are checked in Java, so the proxy resumes the caller with them rather than throwing. */
    private fun failing(error: Exception): CredentialManager =
        Proxy.newProxyInstance(CredentialManager::class.java.classLoader, arrayOf(CredentialManager::class.java)) { _, method, args ->
            check(method.name == "getCredential")
            @Suppress("UNCHECKED_CAST")
            (args!!.last() as Continuation<Any?>).intercepted().resumeWith(Result.failure(error))
            COROUTINE_SUSPENDED
        } as CredentialManager

    @Test fun `native passkey picker uses the server challenge and the platform supplied origin`() = runTest {
        val assertion = """{"id":"AQID","rawId":"AQID","type":"public-key","response":{"clientDataJSON":"AQID","authenticatorData":"AQID","signature":"AQID","userHandle":"AQID"}}"""
        val requestOptions = options
        val result = PasskeyCredentialToken.acquire(context, rpId, requestOptions, manager { activity, request ->
            assertSame(context, (activity as MutableContextWrapper).baseContext)
            val option = request.credentialOptions.single() as GetPublicKeyCredentialOption
            assertEquals(requestOptions, option.requestJson)
            assertNull(option.clientDataHash)
            PublicKeyCredential(assertion)
        })
        assertEquals(assertion, result)
    }

    @Test fun `wrong RP missing verification malformed challenges and oversized options never open a picker`() = runTest {
        val never = manager { _, _ -> fail("Invalid server options opened a picker"); PasswordCredential("fixture", "fixture") }
        for (value in listOf("{}", "{", JSONObject(options).put("rpId", "unrelated.example.test").toString(),
            JSONObject(options).put("userVerification", "preferred").toString(),
            JSONObject(options).put("challenge", "short").toString(), "x".repeat(65_537))) {
            try { PasskeyCredentialToken.acquire(context, rpId, value, never); fail("Invalid options accepted") }
            catch (_: Exception) { }
        }
    }

    @Test fun `unexpected credentials and cancellation cannot become passkey assertions`() = runTest {
        try {
            PasskeyCredentialToken.acquire(context, rpId, options, manager { _, _ -> PasswordCredential("fixture", "fixture") })
            fail("Password accepted as passkey")
        } catch (_: IllegalArgumentException) { }
        val cancelled = CancellationException("synthetic cancellation")
        try {
            PasskeyCredentialToken.acquire(context, rpId, options, manager { _, _ -> throw cancelled })
            fail("Cancellation ignored")
        } catch (actual: CancellationException) { assertSame(cancelled, actual) }
    }

    @Test fun `no passkey and a dismissed prompt stay a notice rather than a failure`() = runTest {
        for (error in listOf(NoCredentialException("synthetic none"), GetCredentialCancellationException("synthetic dismissal"))) {
            try { PasskeyCredentialToken.acquire(context, rpId, options, failing(error)); fail("Accepted without a passkey") }
            catch (_: AccountNoPasskey) { }
        }
    }

    @Test fun `a provider that cannot validate the site or fails otherwise is a passkey failure and is logged without request data`() = runTest {
        for ((error, expected) in listOf(
            GetPublicKeyCredentialDomException(SecurityError(), "RP ID cannot be validated.") to listOf(
                "GetPublicKeyCredentialDomException", "domError=androidx.credentials.TYPE_SECURITY_ERROR", "message=RP ID cannot be validated."),
            GetPublicKeyCredentialDomException(NotAllowedError(), "synthetic refusal") to listOf(
                "domError=androidx.credentials.TYPE_NOT_ALLOWED_ERROR", "message=synthetic refusal"),
            GetCredentialUnknownException("synthetic unknown") to listOf(
                "GetCredentialUnknownException", "type=${GetCredentialUnknownException("x").type}", "message=synthetic unknown"),
            GetCredentialProviderConfigurationException("synthetic configuration") to listOf(
                "GetCredentialProviderConfigurationException", "message=synthetic configuration"),
        )) {
            ShadowLog.clear()
            try { PasskeyCredentialToken.acquire(context, rpId, options, failing(error)); fail("Provider failure accepted") }
            catch (_: AccountPasskeyUnavailable) { }
            val logged = ShadowLog.getLogsForTag("Omnesis:passkey").single()
            assertEquals(Log.WARN, logged.type)
            for (part in expected) assertTrue(logged.msg, logged.msg.contains(part))
            assertFalse(logged.msg.contains("a".repeat(43)))
            assertNull(logged.throwable)
        }
    }
    private val certificate = "fictional signing certificate".toByteArray()

    @Test fun `the app's origin names its one signing certificate`() {
        val info = PackageInfo().apply {
            signingInfo = SigningInfo().also { Shadow.extract<ShadowSigningInfo>(it).setSignatures(arrayOf(Signature(certificate))) }
        }
        val origin = PasskeyCredentialToken.appOrigin(info)
        assertEquals(DeviceEnrollmentContract.androidApkKeyHashOrigin(certificate), origin)
        assertTrue(origin!!.matches(Regex("^android:apk-key-hash:[A-Za-z0-9_-]{43}$")))
        // Several signers, or none, name no single origin: the join then falls back to a person's approval.
        val several = PackageInfo().apply {
            signingInfo = SigningInfo().also { Shadow.extract<ShadowSigningInfo>(it).setSignatures(arrayOf(Signature(certificate), Signature("other".toByteArray()))) }
        }
        assertNull(PasskeyCredentialToken.appOrigin(several))
        assertNull(PasskeyCredentialToken.appOrigin(PackageInfo()))
        // The installed app is read without failing, whatever this test runtime reports for it.
        PasskeyCredentialToken.appOrigin(context)?.let { assertTrue(it.startsWith("android:apk-key-hash:")) }
    }

    @Suppress("DEPRECATION")
    @Config(sdk = [26])
    @Test fun `before Android 9 the origin comes from the package's signature`() {
        val info = PackageInfo().apply { signatures = arrayOf(Signature(certificate)) }
        assertEquals(DeviceEnrollmentContract.androidApkKeyHashOrigin(certificate), PasskeyCredentialToken.appOrigin(info))
    }

    @Test fun `a gateway signer prompts with the gateway's challenge for the build's relay`() = runTest {
        val signer = GatewayPasskeySigner(rpId, "android:apk-key-hash:" + "A".repeat(43)) { requestOptions ->
            PasskeyCredentialToken.acquire(context, rpId, requestOptions, manager { _, request ->
                val option = request.credentialOptions.single() as GetPublicKeyCredentialOption
                assertEquals(requestOptions, option.requestJson)
                assertNull("the platform supplies the origin", option.clientDataHash)
                PasswordCredential("fixture", "fixture")
            })
        }
        // The options pass the token's own checks before a picker opens; only the answer is wrong here.
        try { signer.enrollment("c".repeat(43), System.currentTimeMillis() + 60_000, "n".repeat(43)); fail("Password accepted") }
        catch (_: IllegalArgumentException) { }
    }
}
