// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import android.os.Bundle
import androidx.credentials.Credential
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import java.lang.reflect.Proxy
import androidx.credentials.CustomCredential
import androidx.credentials.PasswordCredential
import androidx.test.core.app.ApplicationProvider
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GoogleCredentialTokenTest {
    private val context get() = ApplicationProvider.getApplicationContext<Context>()
    private val clientId = "synthetic.apps.googleusercontent.com"

    private fun manager(get: (Context, GetCredentialRequest) -> Credential): CredentialManager =
        Proxy.newProxyInstance(CredentialManager::class.java.classLoader, arrayOf(CredentialManager::class.java)) { _, method, args ->
            check(method.name == "getCredential")
            GetCredentialResponse(get(args!![0] as Context, args[1] as GetCredentialRequest))
        } as CredentialManager

    @Test fun `credential request carries configured audience and cryptographic nonce`() = runTest {
        val credential = GoogleIdTokenCredential.Builder().setId("synthetic-account").setIdToken("signed-token").build()
        val token = GoogleCredentialToken.acquire(context, clientId, "challenge-nonce", manager { activity, request ->
            assertSame(context, (activity as android.content.MutableContextWrapper).baseContext)
            val option = request.credentialOptions.single() as GetSignInWithGoogleOption
            assertEquals(clientId, option.serverClientId)
            assertEquals("challenge-nonce", option.nonce)
            CustomCredential(GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL, credential.data)
        })
        assertEquals("signed-token", token)
        assertNotNull(GoogleCredentialToken.createManager(context))
    }

    @Test fun `non Google unknown custom and malformed Google credentials fail closed`() = runTest {
        for (credential in listOf(PasswordCredential("id", "password"), CustomCredential("unknown", Bundle()),
            CustomCredential(GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL, Bundle()))) {
            try {
                GoogleCredentialToken.acquire(context, clientId, "nonce", manager { _, _ -> credential })
                fail("Unexpected credential was accepted")
            } catch (_: Exception) { }
        }
    }

    @Test fun `provider error propagates to controller without fallback identity`() = runTest {
        val error = IllegalStateException("synthetic provider failure")
        try {
            GoogleCredentialToken.acquire(context, clientId, "nonce", manager { _, _ -> throw error })
            fail("Provider error must propagate")
        } catch (actual: IllegalStateException) { assertSame(error, actual) }
    }
}
