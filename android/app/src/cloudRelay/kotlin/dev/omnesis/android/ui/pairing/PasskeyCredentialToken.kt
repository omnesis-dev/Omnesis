// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import android.content.MutableContextWrapper
import android.util.Log
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import org.json.JSONObject

/** Android chooses the passkey provider; the relay verifies the resulting WebAuthn assertion. */
internal object PasskeyCredentialToken {
    suspend fun acquire(context: Context, rpId: String, options: String,
                        manager: CredentialManager): String {
        require(options.toByteArray(Charsets.UTF_8).size <= 65_536)
        val requestOptions = JSONObject(options)
        require(requestOptions.getString("rpId") == rpId)
        require(requestOptions.getString("challenge").matches(Regex("^[A-Za-z0-9_-]{43}$")))
        require(requestOptions.getString("userVerification") == "required")
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetPublicKeyCredentialOption(options)).build()
        val credential = try {
            manager.getCredential(MutableContextWrapper(context), request).credential
        } catch (_: NoCredentialException) {
            throw AccountNoPasskey()
        } catch (_: GetCredentialCancellationException) {
            throw AccountNoPasskey()
        } catch (error: GetCredentialException) {
            Log.w(TAG, describe(error))
            throw AccountPasskeyUnavailable()
        }
        require(credential is PublicKeyCredential)
        return credential.authenticationResponseJson.also {
            require(it.isNotBlank() && it.toByteArray(Charsets.UTF_8).size <= 65_536)
        }
    }

    /**
     * Names the provider's failure, such as Google Play services refusing the relying party ID,
     * for logcat. Android's messages describe the failure only; no request or credential data is included.
     */
    private fun describe(error: GetCredentialException): String {
        val dom = (error as? GetPublicKeyCredentialDomException)?.domError?.type
        return "Passkey request failed: ${error.javaClass.simpleName} type=${error.type}" +
            (if (dom != null) " domError=$dom" else "") + " message=${error.errorMessage}"
    }

    private const val TAG = "Omnesis:passkey"
}
