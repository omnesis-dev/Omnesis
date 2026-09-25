// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.notifications

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import dev.omnesis.android.transport.dto.OmnesisJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import javax.inject.Inject
import javax.inject.Singleton

/** Possession-proof enrolment against the relay selected by the gateway. */
@Singleton
class RelayEnroller internal constructor(
    context: Context,
    private val client: OkHttpClient,
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val allowInsecureForTests: Boolean = false,
) {
    @Inject constructor(@ApplicationContext context: Context) : this(context, OkHttpClient())

    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    suspend fun begin(
        relayUrl: String,
        registrationToken: String,
        appId: String,
        deviceId: String,
        gatewayUrl: String,
    ) {
        val response: RelayEnrolResponse = post(
            relayUrl,
            "v1/enrol",
            RelayEnrolRequest(platform = "android", token = registrationToken, appId = appId),
        )
        requireOpaque(response.challengeId, "challenge id")
        preferences.edit()
            .putString(KEY_CHALLENGE_ID, response.challengeId)
            .putString(KEY_RELAY_URL, relayUrl)
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_GATEWAY_URL, gatewayUrl)
            .putString(KEY_REGISTRATION_TOKEN, registrationToken)
            .putString(KEY_APP_ID, appId)
            .putLong(KEY_PENDING_AT, nowMillis())
            .apply()
    }

    suspend fun verify(nonce: String, deviceId: String, gatewayUrl: String): VerifiedRelay? {
        if (nonce.isBlank() || nonce.length > MAX_OPAQUE_LENGTH) return null
        val pending = pending() ?: return null
        if (pending.deviceId != deviceId || pending.gatewayUrl != gatewayUrl) return null
        val response: RelayVerifyResponse = post(
            pending.relayUrl,
            "v1/enrol/verify",
            RelayVerifyRequest(challengeId = pending.challengeId, nonce = nonce),
        )
        requireOpaque(response.credential, "relay credential")
        clearPending()
        return VerifiedRelay(pending.relayUrl, response.credential)
    }

    fun clearPending() {
        preferences.edit()
            .remove(KEY_CHALLENGE_ID)
            .remove(KEY_RELAY_URL)
            .remove(KEY_DEVICE_ID)
            .remove(KEY_GATEWAY_URL)
            .remove(KEY_REGISTRATION_TOKEN)
            .remove(KEY_APP_ID)
            .remove(KEY_PENDING_AT)
            .apply()
    }

    fun clearAll() {
        preferences.edit().clear().apply()
    }

    /**
     * Keep a carrier challenge only while the gateway still selects the same
     * relay for the same phone identity. A late nonce from an obsolete plan
     * must never overwrite the gateway's newer direct/unavailable choice.
     */
    fun reconcilePlan(
        selectedRelayUrl: String?,
        registrationToken: String,
        appId: String,
        deviceId: String,
        gatewayUrl: String,
    ) {
        val selectedIdentity = selectedRelayUrl?.let {
            identity(it, registrationToken, appId, deviceId, gatewayUrl)
        }
        if (pendingIdentity() != selectedIdentity) clearPending()
        if (completedIdentity() != selectedIdentity) clearCompleted()
    }

    fun shouldRotate(
        relayUrl: String,
        registrationToken: String,
        appId: String,
        deviceId: String,
        gatewayUrl: String,
    ): Boolean {
        val identity = identity(relayUrl, registrationToken, appId, deviceId, gatewayUrl)
        val completedAge = nowMillis() - preferences.getLong(KEY_COMPLETED_AT, 0L)
        val completedIsFresh = preferences.getString(KEY_COMPLETED_IDENTITY, null) == identity &&
            completedAge in 0 until ROTATION_INTERVAL_MS
        if (completedIsFresh) return false
        val pendingAge = nowMillis() - preferences.getLong(KEY_PENDING_AT, 0L)
        val pendingIsFresh = pendingIdentity() == identity &&
            pendingAge in 0 until CHALLENGE_TTL_MS
        return !pendingIsFresh
    }

    fun markRegistered(
        relayUrl: String,
        registrationToken: String,
        appId: String,
        deviceId: String,
        gatewayUrl: String,
    ) {
        preferences.edit()
            .putString(
                KEY_COMPLETED_IDENTITY,
                identity(relayUrl, registrationToken, appId, deviceId, gatewayUrl),
            )
            .putLong(KEY_COMPLETED_AT, nowMillis())
            .apply()
        clearPending()
    }

    private fun pending(): PendingRelay? {
        val challengeId = preferences.getString(KEY_CHALLENGE_ID, null)?.takeIf { it.isNotBlank() }
            ?: return null
        val relayUrl = preferences.getString(KEY_RELAY_URL, null)?.takeIf { it.isNotBlank() }
            ?: return null
        val deviceId = preferences.getString(KEY_DEVICE_ID, null)?.takeIf { it.isNotBlank() }
            ?: return null
        val gatewayUrl = preferences.getString(KEY_GATEWAY_URL, null)?.takeIf { it.isNotBlank() }
            ?: return null
        return PendingRelay(challengeId, relayUrl, deviceId, gatewayUrl)
    }

    private fun requireOpaque(value: String, label: String) {
        require(value.isNotBlank() && value.length <= MAX_OPAQUE_LENGTH) { "invalid $label" }
    }

    private fun identity(
        relayUrl: String,
        registrationToken: String,
        appId: String,
        deviceId: String,
        gatewayUrl: String,
    ): String = listOf(relayUrl, registrationToken, appId, deviceId, gatewayUrl)
        .joinToString("\u001f")

    private fun pendingIdentity(): String? {
        val relayUrl = preferences.getString(KEY_RELAY_URL, null) ?: return null
        val registrationToken = preferences.getString(KEY_REGISTRATION_TOKEN, null) ?: return null
        val appId = preferences.getString(KEY_APP_ID, null) ?: return null
        val deviceId = preferences.getString(KEY_DEVICE_ID, null) ?: return null
        val gatewayUrl = preferences.getString(KEY_GATEWAY_URL, null) ?: return null
        return identity(relayUrl, registrationToken, appId, deviceId, gatewayUrl)
    }

    private fun completedIdentity(): String? =
        preferences.getString(KEY_COMPLETED_IDENTITY, null)

    private fun clearCompleted() {
        preferences.edit()
            .remove(KEY_COMPLETED_IDENTITY)
            .remove(KEY_COMPLETED_AT)
            .apply()
    }

    private suspend inline fun <reified RequestBody, reified ResponseBody> post(
        relayUrl: String,
        path: String,
        body: RequestBody,
    ): ResponseBody = withContext(Dispatchers.IO) {
        val base = requireNotNull(relayUrl.toHttpUrlOrNull()) { "invalid relay URL" }
        require(base.scheme == "https" || (allowInsecureForTests && base.scheme == "http")) {
            "relay URL must use HTTPS"
        }
        require(base.username.isEmpty() && base.password.isEmpty() && base.fragment == null) {
            "relay URL must not contain credentials or a fragment"
        }
        val url = base.newBuilder().apply {
            path.trim('/').split('/').forEach(::addPathSegment)
        }.build()
        val payload = OmnesisJson.encodeToString(body).toRequestBody(JSON_MEDIA)
        client.newCall(Request.Builder().url(url).post(payload).build()).execute().use { response ->
            val responseBody = response.body?.string().orEmpty()
            check(response.isSuccessful) { "relay request failed with HTTP ${response.code}" }
            OmnesisJson.decodeFromString(responseBody)
        }
    }

    data class VerifiedRelay(val relayUrl: String, val credential: String)
    private data class PendingRelay(
        val challengeId: String,
        val relayUrl: String,
        val deviceId: String,
        val gatewayUrl: String,
    )

    @Serializable
    private data class RelayEnrolRequest(
        val platform: String,
        val token: String,
        val appId: String,
    )

    @Serializable private data class RelayEnrolResponse(val challengeId: String)
    @Serializable private data class RelayVerifyRequest(val challengeId: String, val nonce: String)
    @Serializable private data class RelayVerifyResponse(val credential: String)

    private companion object {
        const val PREFERENCES = "omnesis_relay_enrolment"
        const val KEY_CHALLENGE_ID = "challenge_id"
        const val KEY_RELAY_URL = "relay_url"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_GATEWAY_URL = "gateway_url"
        const val KEY_REGISTRATION_TOKEN = "registration_token"
        const val KEY_APP_ID = "app_id"
        const val KEY_PENDING_AT = "pending_at"
        const val KEY_COMPLETED_IDENTITY = "completed_identity"
        const val KEY_COMPLETED_AT = "completed_at"
        const val MAX_OPAQUE_LENGTH = 4096
        const val ROTATION_INTERVAL_MS = 90L * 24 * 60 * 60 * 1000
        const val CHALLENGE_TTL_MS = 10L * 60 * 1000
        val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()
    }
}
