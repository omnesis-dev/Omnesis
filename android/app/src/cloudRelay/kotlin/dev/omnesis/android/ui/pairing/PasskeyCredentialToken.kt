// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.pairing

import android.content.Context
import android.content.MutableContextWrapper
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import dev.omnesis.android.pairing.DeviceEnrollmentContract
import dev.omnesis.android.pairing.GatewayPasskeySigner
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
     * The origin Credential Manager reports for this app's passkey assertions: its one signing
     * certificate, as `android:apk-key-hash:`. Null when the app has no single signer to name,
     * which leaves joining with the relay's ceremony and a person's approval.
     */
    @Suppress("DEPRECATION")
    fun appOrigin(context: Context): String? = runCatching {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        appOrigin(context.packageManager.getPackageInfo(context.packageName, flags))
    }.getOrNull()

    /** The origin for a package's signer, read as [appOrigin] asks for it. */
    @Suppress("DEPRECATION")
    internal fun appOrigin(info: PackageInfo): String? {
        val signers = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.signingInfo?.takeUnless { it.hasMultipleSigners() }?.apkContentsSigners
        else info.signatures
        return signers?.singleOrNull()?.toByteArray()?.let(DeviceEnrollmentContract::androidApkKeyHashOrigin)
    }

    /** Signs a gateway's passkey ceremony in this app, for passkeys of the build's relay. */
    fun gatewaySigner(context: Context, rpId: String, manager: () -> CredentialManager): GatewayPasskeySigner? =
        appOrigin(context)?.let { origin -> GatewayPasskeySigner(rpId, origin) { options -> acquire(context, rpId, options, manager()) } }

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
