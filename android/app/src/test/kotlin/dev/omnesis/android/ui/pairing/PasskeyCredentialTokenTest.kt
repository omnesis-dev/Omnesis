// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import android.content.MutableContextWrapper
import androidx.credentials.Credential
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.test.core.app.ApplicationProvider
import java.lang.reflect.Proxy
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

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
}
