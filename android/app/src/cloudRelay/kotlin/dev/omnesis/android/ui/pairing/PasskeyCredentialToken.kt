// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import android.content.MutableContextWrapper
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.NoCredentialException
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
        }
        require(credential is PublicKeyCredential)
        return credential.authenticationResponseJson.also {
            require(it.isNotBlank() && it.toByteArray(Charsets.UTF_8).size <= 65_536)
        }
    }
}
