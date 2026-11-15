// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.GatewayPasskeyCeremony
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** A gateway's passkey ceremony, or the assertion made for it, that this app will not use. */
class GatewayPasskeyRefused(message: String) : Exception(message)

/**
 * Signs passkey ceremonies a gateway issued, in this app, with the platform's passkey provider
 * (`gateway-passkey`, docs/device-enrollment.md). Only the gateway's one-use value and what the
 * assertion approves come from the gateway, over the pinned connection. The WebAuthn challenge
 * is computed here with this app's own `android:apk-key-hash:` origin: never with an origin a
 * gateway or the relay names, and never one a server computed.
 *
 * @param rpId the build's relay host, which every account passkey belongs to.
 * @param appOrigin the origin the platform reports for this app's passkey assertions.
 * @param acquire runs the platform prompt for WebAuthn request options and returns the
 *   assertion JSON.
 */
class GatewayPasskeySigner(
    val rpId: String,
    val appOrigin: String,
    private val now: () -> Long = System::currentTimeMillis,
    private val acquire: suspend (String) -> String,
) {
    init {
        require(APP_ORIGIN.matches(appOrigin)) { "not an app origin" }
        require(rpId.isNotBlank())
    }

    /**
     * A device joining: the gateway value is the request's own `/devices/account/challenge`,
     * which commits the gateway to its part of the comparison code before the device reveals its
     * secret, and the binding is the device's enrollment nonce, computed on the device.
     */
    suspend fun enrollment(challenge: String, expiresAt: Long, enrollmentNonce: String): JsonObject =
        sign("device-enrollment", challenge, enrollmentNonce, expiresAt)

    /** Approving a held request: a ceremony the gateway issued for that request, its device key and its code. */
    suspend fun approval(ceremony: GatewayPasskeyCeremony): JsonObject {
        if (ceremony.purpose != "approve-request" || ceremony.rpId != rpId) refuse()
        return sign(ceremony.purpose, ceremony.challenge, ceremony.binding, ceremony.expiresAt)
    }

    /** The options the platform prompt receives; exposed for tests. */
    fun requestOptions(webauthnChallenge: String): String = buildJsonObject {
        put("challenge", webauthnChallenge); put("rpId", rpId); put("userVerification", "required")
        putJsonArray("allowCredentials") {}
    }.toString()

    private suspend fun sign(purpose: String, challenge: String, binding: String, expiresAt: Long): JsonObject {
        val current = now()
        if (!OPAQUE.matches(challenge) || !OPAQUE.matches(binding) || expiresAt <= current || expiresAt > current + MAX_LIFETIME_MILLIS) refuse()
        val webauthn = DeviceEnrollmentContract.gatewayPasskeyChallenge(purpose, appOrigin, challenge, binding)
        val assertion = acquire(requestOptions(webauthn))
        if (assertion.toByteArray(Charsets.UTF_8).size > 65_536) refuse()
        val credential = runCatching { Json.parseToJsonElement(assertion).jsonObject }.getOrNull() ?: refuse()
        // The provider reports where the assertion was made. A mismatch would only be refused by
        // the gateway, after the request had spent its challenge.
        val clientData = runCatching {
            val encoded = (credential["response"]?.jsonObject?.get("clientDataJSON") as JsonPrimitive).content
            Json.parseToJsonElement(cloudDecodeBase64Url(encoded).toString(Charsets.UTF_8)).jsonObject
        }.getOrNull() ?: refuse()
        fun text(key: String) = (clientData[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        if (text("type") != "webauthn.get" || text("challenge") != webauthn || text("origin") != appOrigin ||
            clientData["topOrigin"] != null || (clientData["crossOrigin"] as? JsonPrimitive)?.contentOrNull == "true") refuse()
        return buildJsonObject {
            put("type", "gateway-passkey"); put("challenge", challenge); put("credential", gatewayProofCredential(credential))
        }
    }

    private fun refuse(): Nothing = throw GatewayPasskeyRefused("The gateway's passkey request could not be used")

    private companion object {
        val OPAQUE = Regex("^[A-Za-z0-9_-]{43}$")
        val APP_ORIGIN = Regex("^android:apk-key-hash:[A-Za-z0-9_-]{43}$")
        /** Gateway values live two to three minutes; a longer one is not the gateway's. */
        const val MAX_LIFETIME_MILLIS = 300_000L
    }
}

/** The gateway's proof schemas are strict, so a provider's extra fields must not reach it. */
internal fun gatewayProofCredential(credential: JsonObject): JsonObject = buildJsonObject {
    for (field in listOf("id", "rawId", "type", "authenticatorAttachment")) credential[field]?.let { put(field, it) }
    put("clientExtensionResults", credential["clientExtensionResults"] ?: JsonObject(emptyMap()))
    val response = credential["response"] as? JsonObject ?: JsonObject(emptyMap())
    putJsonObject("response") {
        for (field in listOf("clientDataJSON", "authenticatorData", "signature", "userHandle")) response[field]?.let { put(field, it) }
    }
}
