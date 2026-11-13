// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import java.io.IOException
import java.net.URI
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.SSLException

@Serializable
data class AccountGatewayChoice(val gatewayId: String, val publicOrigin: String, val displayName: String? = null)

class AccountPairingException(val reason: Reason) : Exception("Account pairing could not be completed") {
    enum class Reason { UNAVAILABLE, NO_ACCOUNT, NO_GATEWAYS, INVALID_RESPONSE, EXPIRED, GATEWAY_OFFLINE, GATEWAY_UPDATE_REQUIRED, NOT_YOUR_GATEWAY }
}

/**
 * Sign-in enrollment as the device sees it (docs/device-enrollment.md). The relay's values are
 * recomputed before any prompt, the proof goes only to the gateway over the pinned connection,
 * and the gateway decides whether the device joins or waits for a person.
 */
class AccountCloudPairingClient(
    relayOrigin: String,
    private val googleClientId: String,
    private val presenterClientIds: Set<String> = setOf(googleClientId),
    private val direct: CloudPairingTransport = CloudPairingHTTP(),
    private val createGateway: (String) -> CloudPairingTransport = ::provisionalGatewayTransport,
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
    private val deviceKeys: DeviceKeyStore = KeystoreDeviceKeys(),
    /** Null skips the first-contact public-certificate check, for test gateways. */
    private val publicCertificateCheck: ((List<X509Certificate>, String) -> Boolean)? = PublicCertificateCheck()::accepts,
) : AutoCloseable {
    private val origin = exactOrigin(relayOrigin)
    private val json = Json { ignoreUnknownKeys = true }
    private val stage = AtomicReference("new")
    private val closed = AtomicBoolean(false)
    private val lifecycle = Any()
    private var intent: CloudPairingChallenge? = null
    private var operation: Operation? = null
    private var enrollment: SignInEnrollment? = null
    private var passkeyBinding: PasskeyBinding? = null
    private var proof: JsonObject? = null
    private var proofExpiresAt = 0L
    private var discovery: Discovery? = null
    private var choices = emptyList<AccountGatewayChoice>()
    private var gateway: CloudPairingTransport? = null
    private var active: CloudPairingConfirmation? = null
    private val verifier = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })

    @Serializable private data class Operation(val operationId: String, val ticket: String, val googleNonce: String, val expiresAt: Long, val salt: String = "")
    @Serializable private data class Discovery(val discoveryToken: String, val accountId: String, val expiresAt: Long, val credentialPublicKey: String? = null)
    @Serializable private data class Directory(val gateways: List<AccountGatewayChoice>, val nextCursor: String? = null)
    @Serializable private data class Selected(val binding: GoogleGatewayBinding, val accountId: String, val identityToken: String, val expiresAt: Long)
    @Serializable private data class IssuedChallenge(val challenge: String)
    private class SignInEnrollment(val key: DeviceKey, val nonce: String)
    /** The one request this sign-in sends: the challenge it answers and its exact bytes. */
    private class SentRequest(val challenge: String, val body: String, val requireApproval: Boolean)
    private var sent: SentRequest? = null
    private class PasskeyBinding(val salt: String, val issuedAt: String)
    data class PasskeyOptions(val ceremonyId: String, val options: String)

    /** Waiting for an offline gateway stops here: the sign-in can no longer join or be attested. */
    val retryUntilMillis: Long get() = minOf(proofExpiresAt, discovery?.expiresAt ?: 0L) * 1000

    suspend fun begin(challenge: CloudPairingChallenge): String {
        transition("new", "starting")
        val key = withContext(Dispatchers.Default) { deviceKeys.loadOrCreate() }
        val nonce = DeviceEnrollmentContract.enrollmentNonce(challenge.requestId, challenge.kind, challenge.name, challenge.secret, key.publicKey)
        val value = decode<Operation>(request("/_relay/v3/native/start", buildJsonObject {
            put("kind", "android"); put("nonce", nonce); put("challenge", cloudDigestUrl(verifier.toByteArray(Charsets.UTF_8)))
        }))
        checkOpen()
        if (!uuid(value.operationId) || !opaque(value.ticket) || !opaque(value.googleNonce) || value.expiresAt <= now() * 1000 || value.expiresAt > now() * 1000 + 310_000) invalid()
        // A sign-in the gateway could not check would be wasted, so a wrong value stops before the prompt.
        if (!opaque(value.salt) || value.googleNonce != DeviceEnrollmentContract.googleProofNonce(value.salt, nonce)) invalid()
        intent = challenge; operation = value; enrollment = SignInEnrollment(key, nonce)
        stage.set("authenticating")
        return value.googleNonce
    }

    suspend fun google(idToken: String): List<AccountGatewayChoice> {
        transition("authenticating", "verifying")
        val op = currentOperation()
        if (!googleClientId.endsWith(".apps.googleusercontent.com") || idToken.isBlank() || idToken.length > 16_384) invalid()
        val jwks = direct.request("https://www.googleapis.com/oauth2/v3/certs")
        checkOpen()
        val identity = GoogleIdentityVerifier(jwks, setOf(googleClientId), presenterClientIds).verify(idToken, op.googleNonce, now())
        proof = buildJsonObject { put("type", "google"); put("idToken", idToken); put("salt", op.salt) }
        proofExpiresAt = identity.issuedAt + PROOF_LIFETIME_SECONDS
        return authenticated(signIn("/_relay/v3/native/google", operationBody(op) { put("verifier", verifier); put("idToken", idToken) }))
    }

    suspend fun passkeyOptions(): PasskeyOptions {
        checkOpen(); if (stage.get() != "authenticating") invalid()
        val value = decode<JsonObject>(request("/_relay/v3/native/passkeys/options", operationBody(currentOperation())))
        val ceremonyId = value.text("ceremonyId")
        val options = value["options"]?.jsonObject ?: invalid()
        if (!opaque(ceremonyId) || options.text("rpId") != URI(origin).host || !opaque(options.text("challenge")) || options.text("userVerification") != "required") invalid()
        val salt = value.text("salt")
        val issuedAt = (value["issuedAt"] as? JsonPrimitive)?.contentOrNull ?: invalid()
        val nonce = enrollment?.nonce ?: invalid()
        if (!opaque(salt) || !ISSUED_AT.matches(issuedAt) || options.text("challenge") != DeviceEnrollmentContract.passkeyProofChallenge(salt, issuedAt, nonce)) invalid()
        passkeyBinding = PasskeyBinding(salt, issuedAt)
        return PasskeyOptions(ceremonyId, options.toString())
    }

    suspend fun passkey(options: PasskeyOptions, assertion: String): List<AccountGatewayChoice> {
        transition("authenticating", "verifying")
        if (!opaque(options.ceremonyId) || assertion.toByteArray(Charsets.UTF_8).size > 65_536) invalid()
        val binding = passkeyBinding ?: invalid()
        val credential = decode<JsonObject>(assertion)
        proofExpiresAt = binding.issuedAt.toLong() + PROOF_LIFETIME_SECONDS
        val response = signIn("/_relay/v3/native/passkeys/complete", operationBody(currentOperation()) {
            put("verifier", verifier); put("ceremonyId", options.ceremonyId); put("credential", credential)
        })
        val publicKey = decode<Discovery>(response).credentialPublicKey?.takeIf { BASE64URL.matches(it) && it.length <= 65_536 }
        proof = buildJsonObject {
            put("type", "passkey"); put("salt", binding.salt); put("issuedAt", binding.issuedAt)
            publicKey?.let { put("credentialPublicKey", it) }
            put("credential", proofCredential(credential))
        }
        return authenticated(response)
    }

    /** The relay names one refusal: the sign-in was verified and no Omnesis account exists for it. */
    private suspend fun signIn(path: String, body: JsonObject): String =
        try {
            request(path, body)
        } catch (error: CloudPairingException) {
            if (error.statusCode == 403 && error.refusal == NO_ACCOUNT_REFUSAL) throw AccountPairingException(AccountPairingException.Reason.NO_ACCOUNT)
            throw error
        }

    private suspend fun authenticated(response: String): List<AccountGatewayChoice> {
        checkOpen()
        val session = decode<Discovery>(response)
        if (!Regex("^[a-f0-9]{64}$").matches(session.accountId) || session.discoveryToken.isBlank() || session.discoveryToken.length > 4096 || session.expiresAt <= now() || session.expiresAt > currentOperation().expiresAt / 1000) invalid()
        discovery = session
        val all = mutableListOf<AccountGatewayChoice>(); var cursor: String? = null
        do {
            val page = decode<Directory>(request("/_relay/v3/gateways" + (cursor?.let { "?after=$it" } ?: ""), bearer = session.discoveryToken))
            checkOpen()
            if (page.gateways.size > 50) invalid()
            for (choice in page.gateways) {
                if (!uuid(choice.gatewayId) || exactOrigin(choice.publicOrigin) != choice.publicOrigin || choice.displayName?.let { it.isBlank() || it.length > 80 } == true || all.any { it.gatewayId == choice.gatewayId } || all.size >= 1000) invalid()
                all.add(choice)
            }
            val next = page.nextCursor
            if (next != null && (!uuid(next) || next == cursor || page.gateways.lastOrNull()?.gatewayId != next)) invalid()
            cursor = next
        } while (cursor != null)
        if (all.isEmpty()) throw AccountPairingException(AccountPairingException.Reason.NO_GATEWAYS)
        choices = all.toList(); stage.set("choosing")
        return choices
    }

    /** Throws GATEWAY_OFFLINE with the client ready to select again, once the gateway may be back. */
    suspend fun select(gatewayId: String): CloudPairingConfirmation {
        transition("choosing", "selecting")
        try {
            return enroll(gatewayId)
        } catch (error: Exception) {
            if (!offline(error)) throw error
            synchronized(lifecycle) { checkOpen(); gateway.also { gateway = null } }?.close()
            stage.set("choosing")
            throw AccountPairingException(AccountPairingException.Reason.GATEWAY_OFFLINE)
        }
    }

    private suspend fun enroll(gatewayId: String): CloudPairingConfirmation {
        val choice = choices.singleOrNull { it.gatewayId == gatewayId } ?: invalid()
        val session = discovery ?: invalid()
        if (session.expiresAt <= now() || proofExpiresAt <= now()) throw AccountPairingException(AccountPairingException.Reason.EXPIRED)
        val selected = decode<Selected>(request("/_relay/v3/gateway?gatewayId=${choice.gatewayId}", bearer = session.discoveryToken))
        checkOpen()
        if (selected.accountId != session.accountId || selected.binding.gatewayId != choice.gatewayId || selected.binding.publicOrigin != choice.publicOrigin || selected.identityToken.isBlank() || selected.identityToken.length > 16_384 || selected.expiresAt <= now() || selected.expiresAt > session.expiresAt) invalid()
        val pending = CloudPairingConfirmation(intent ?: invalid(), selected.binding, now() * 1000)
        val pinned = createGateway(pending.fingerprint)
        synchronized(lifecycle) {
            if (closed.get()) { pinned.close(); invalid() }
            gateway = pinned
        }
        val (progress, requireApproval) = sendEnrollment(pinned, pending, selected.identityToken)
        checkOpen(); pending.receive(progress, now() * 1000)
        // A gateway that was asked to hold the request and still approves it gets compared by a person.
        if (progress.status == "approved" && !requireApproval) pending.acceptJoin()
        synchronized(lifecycle) { checkOpen(); active = pending; stage.set("pairing") }
        return pending
    }

    private suspend fun sendEnrollment(pinned: CloudPairingTransport, pending: CloudPairingConfirmation, identityToken: String): Pair<CloudPairingProgress, Boolean> {
        val request = sent ?: run {
            val key = enrollment?.key ?: invalid()
            val signIn = proof ?: invalid()
            val identity = pending.challenge
            val challenge = decode<IssuedChallenge>(gatewayRequest(pinned, "${pending.origin}/devices/account/challenge", "{}", updateRequiredOn404 = true)).challenge
            if (!opaque(challenge)) invalid()
            val requireApproval = publicCertificateCheck?.let { !it(pinned.peerCertificates, URI(pending.origin).host) } ?: false
            val signature = withContext(Dispatchers.Default) {
                key.sign(DeviceEnrollmentContract.enrollmentSignatureTranscript(identity.requestId, identity.kind, identity.name, pending.spkiFingerprint, challenge, key.publicKey))
            }
            val body = json.encodeToJsonElement(identity).jsonObject.toMutableMap().apply {
                put("identityToken", JsonPrimitive(identityToken))
                put("deviceKey", buildJsonObject { put("publicKey", key.publicKey); put("challenge", challenge); put("signature", signature) })
                put("proof", signIn)
                put("requireApproval", JsonPrimitive(requireApproval))
            }
            SentRequest(challenge, JsonObject(body).toString(), requireApproval)
        }
        // The challenge is the gateway's commitment to its part of the comparison code, received
        // before the request below reveals this device's secret.
        pending.expect(request.challenge)
        // From here the secret may have reached a gateway, so it is no longer private: every
        // later attempt repeats these exact bytes. A fresh challenge is never answered, because
        // its nonce could have been picked by someone who already knows the secret. A gateway
        // that calls the challenge spent (409) ends this sign-in.
        sent = request
        return decode<CloudPairingProgress>(gatewayRequest(pinned, "${pending.origin}/devices/account/request", request.body)) to request.requireApproval
    }

    private suspend fun gatewayRequest(pinned: CloudPairingTransport, url: String, body: String, updateRequiredOn404: Boolean = false): String =
        try {
            pinned.request(url, body)
        } catch (error: CloudPairingException) {
            throw when {
                error.statusCode == 403 -> AccountPairingException(AccountPairingException.Reason.NOT_YOUR_GATEWAY)
                error.statusCode == 404 && updateRequiredOn404 -> AccountPairingException(AccountPairingException.Reason.GATEWAY_UPDATE_REQUIRED)
                else -> error
            }
        }

    suspend fun poll(pending: CloudPairingConfirmation) {
        val pinned = synchronized(lifecycle) { checkOpen(); if (active !== pending) invalid(); gateway ?: invalid() }
        val response = pinned.request("${pending.origin}/devices/account/poll", buildJsonObject { put("requestId", pending.challenge.requestId); put("secret", pending.challenge.secret) }.toString())
        checkOpen(); pending.receive(decode(response), now() * 1000)
    }

    override fun close() {
        val previous = synchronized(lifecycle) {
            if (!closed.compareAndSet(false, true)) return
            stage.set("closed"); active = null; choices = emptyList(); operation = null; intent = null; discovery = null
            enrollment = null; passkeyBinding = null; proof = null; sent = null
            gateway.also { gateway = null }
        }
        previous?.close(); direct.close()
    }
    private fun transition(from: String, to: String) { checkOpen(); if (!stage.compareAndSet(from, to)) invalid() }
    private fun checkOpen() { if (closed.get()) invalid() }
    private fun currentOperation(): Operation {
        checkOpen(); val op = operation ?: invalid()
        if (op.expiresAt <= now() * 1000) throw AccountPairingException(AccountPairingException.Reason.EXPIRED)
        return op
    }
    private suspend fun request(path: String, body: JsonObject? = null, bearer: String? = null): String {
        checkOpen()
        val response = direct.request(origin + path, body?.toString(), bearer)
        checkOpen(); return response
    }
    private fun operationBody(op: Operation, extra: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject { put("operationId", op.operationId); put("ticket", op.ticket); extra() }
    private inline fun <reified T> decode(value: String): T { if (value.toByteArray(Charsets.UTF_8).size > 65_536) invalid(); return json.decodeFromString<T>(value) }
    private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: invalid()
    private fun opaque(value: String) = Regex("^[A-Za-z0-9_-]{43}$").matches(value)
    private fun uuid(value: String) = runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false)
    private fun invalid(): Nothing = throw AccountPairingException(AccountPairingException.Reason.INVALID_RESPONSE)
    companion object {
        private const val PROOF_LIFETIME_SECONDS = 600L
        private const val NO_ACCOUNT_REFUSAL = "no-account"
        private val ISSUED_AT = Regex("^[1-9][0-9]{9,10}$")
        private val BASE64URL = Regex("^[A-Za-z0-9_-]+$")
        private val OFFLINE_STATUSES = setOf(502, 503, 504)

        private fun offline(error: Exception): Boolean = when (error) {
            is CloudPairingException -> error.statusCode in OFFLINE_STATUSES
            // A certificate that fails its pin is not an outage.
            is SSLException -> false
            is IOException -> true
            else -> false
        }

        /** The gateway's proof schema is strict, so a provider's extra fields must not reach it. */
        private fun proofCredential(credential: JsonObject): JsonObject = buildJsonObject {
            for (field in listOf("id", "rawId", "type", "authenticatorAttachment")) credential[field]?.let { put(field, it) }
            put("clientExtensionResults", credential["clientExtensionResults"] ?: JsonObject(emptyMap()))
            val response = credential["response"] as? JsonObject ?: JsonObject(emptyMap())
            putJsonObject("response") {
                for (field in listOf("clientDataJSON", "authenticatorData", "signature", "userHandle")) response[field]?.let { put(field, it) }
            }
        }

        private fun exactOrigin(value: String): String {
            val uri = URI(value)
            if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null || uri.rawPath !in listOf("", "/") || uri.port == 0) throw AccountPairingException(AccountPairingException.Reason.INVALID_RESPONSE)
            return "https://${uri.rawAuthority}".also { if (value != it && value != "$it/") throw AccountPairingException(AccountPairingException.Reason.INVALID_RESPONSE) }
        }
    }
}
