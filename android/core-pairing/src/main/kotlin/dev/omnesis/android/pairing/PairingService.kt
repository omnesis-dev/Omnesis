// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.DeviceCapabilities
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.postJson
import dev.omnesis.android.transport.tls.PinnedOkHttp
import kotlinx.serialization.encodeToString
import okhttp3.OkHttpClient

/**
 * Coordinates pairing: decode a QR/manual payload, exchange the code for a device
 * token over the (optionally pinned) HTTPS client, and persist the result. Faithful
 * port of the iOS `PairingService`, including atomic credential persistence and
 * `current()` semantics. The [SecureStore] seam keeps it testable with an
 * [InMemoryStore].
 */
class PairingService(
    private val store: SecureStore,
    private val deviceName: String = "Android",
    private val deviceCapabilities: DeviceCapabilities = DeviceCapabilities.android(emptyList()),
    private val clientFactory: (fingerprint: String?) -> OkHttpClient = { fp -> PinnedOkHttp.build(fp) },
) {
    /** Pair from a scanned QR payload (V1-V4). */
    suspend fun pair(raw: String): Pairing = when (val p = PairingPayload.decode(raw)) {
        is PairingPayload.V4 -> when (val tls = p.tls) {
            PairingPayload.V4Tls.System -> exchangeAndPersist(
                p.gatewayUrl,
                p.pairingCode,
                fingerprint = null,
                tlsMode = PairingTlsMode.SYSTEM,
            )
            is PairingPayload.V4Tls.PinnedLeaf -> exchangeAndPersist(
                p.gatewayUrl,
                p.pairingCode,
                fingerprint = tls.fingerprint.lowercase(),
                tlsMode = PairingTlsMode.PINNED_LEAF,
            )
        }
        is PairingPayload.V1 -> persistV1(p)
        is PairingPayload.V2 -> exchangeAndPersist(
            p.gatewayUrl,
            p.pairingCode,
            fingerprint = null,
            tlsMode = PairingTlsMode.LEGACY,
        )
        is PairingPayload.V3 -> exchangeAndPersist(
            p.gatewayUrl,
            p.pairingCode,
            fingerprint = p.fingerprint.lowercase(),
            tlsMode = PairingTlsMode.PINNED_LEAF,
        )
    }

    /** Pair from manual entry (V2-style; V3 when a fingerprint is supplied). */
    suspend fun pairManually(gatewayUrl: String, pairingCode: String, fingerprint: String? = null): Pairing {
        PairingPayload.requireHttpsUrl(gatewayUrl)
        val fp = fingerprint?.takeIf { it.isNotBlank() }?.lowercase()?.also(PairingPayload::requireValidFingerprint)
        return exchangeAndPersist(
            gatewayUrl,
            pairingCode,
            fp,
            if (fp == null) PairingTlsMode.LEGACY else PairingTlsMode.PINNED_LEAF,
        )
    }

    /** The currently persisted pairing, or null if unpaired (any required key missing). */
    fun current(): Pairing? {
        store.get(Keys.CREDENTIAL)?.let { raw ->
            val bundle = runCatching {
                OmnesisJson.decodeFromString<PairingCredentialBundle>(raw)
            }.getOrNull() ?: return null
            return pairingFromBundle(bundle)
        }

        val url = store.get(Keys.URL) ?: return null
        val token = store.get(Keys.TOKEN) ?: return null
        val accountId = store.get(Keys.ACCOUNT_ID) ?: return null
        val name = store.get(Keys.NAME) ?: return null
        val scopes = store.get(Keys.SCOPES)
            ?.let { runCatching { OmnesisJson.decodeFromString<List<String>>(it) }.getOrDefault(emptyList()) }
            ?: emptyList()
        val fingerprint = store.get(Keys.FINGERPRINT)
        val tlsMode = PairingTlsMode.fromPersisted(store.get(Keys.TLS_MODE), fingerprint) ?: return null
        if (runCatching { PairingPayload.requireHttpsUrl(url) }.isFailure) return null
        if (tlsMode == PairingTlsMode.PINNED_LEAF &&
            runCatching { PairingPayload.requireValidFingerprint(fingerprint.orEmpty()) }.isFailure
        ) return null
        if (tlsMode == PairingTlsMode.SYSTEM && runCatching { requireSystemOrigin(url) }.isFailure) return null
        val effectiveFingerprint = if (tlsMode == PairingTlsMode.SYSTEM) null else fingerprint
        return Pairing(
            url = url,
            token = token,
            accountId = accountId,
            deviceId = store.get(Keys.DEVICE_ID) ?: accountId,
            gatewayName = name,
            scopes = scopes,
            fingerprint = effectiveFingerprint,
            tlsMode = tlsMode,
        )
    }

    /** Switch gateway URL (LAN/Tailscale/IP) without re-pairing. */
    fun updateGatewayURL(url: String) {
        PairingPayload.requireHttpsUrl(url)
        val pairing = current()
        if (pairing?.tlsMode == PairingTlsMode.SYSTEM) {
            val currentOrigin = requireSystemOrigin(pairing.url)
            val nextOrigin = requireSystemOrigin(url)
            if (currentOrigin != nextOrigin) {
                throw PairingPayloadException(
                    "system-trusted gateway authority cannot change without re-pairing",
                )
            }
        }
        val rawBundle = store.get(Keys.CREDENTIAL)
        if (rawBundle != null) {
            val bundle = runCatching {
                OmnesisJson.decodeFromString<PairingCredentialBundle>(rawBundle)
            }.getOrElse { throw PairingPayloadException("stored pairing credential is invalid") }
            store.set(Keys.CREDENTIAL, OmnesisJson.encodeToString(bundle.copy(url = url)))
        } else {
            store.set(Keys.URL, url)
        }
    }

    /**
     * Forget the pairing. The install identity survives: it is what lets the
     * next pairing adopt this phone's existing device row on the gateway.
     */
    fun unpair() {
        val installId = store.get(Keys.INSTALL_ID)
        val pendingRevocations = store.get(Keys.PENDING_REVOCATION)
        store.replaceAll(buildMap {
            if (installId != null) put(Keys.INSTALL_ID, installId)
            if (pendingRevocations != null) put(Keys.PENDING_REVOCATION, pendingRevocations)
        })
    }

    /** Persist the credential needed for remote revocation before local unpair. */
    fun stageUnpair(): Pairing? {
        val pairing = current() ?: return null
        val raw = store.get(Keys.CREDENTIAL) ?: OmnesisJson.encodeToString(
            PairingCredentialBundle(
                url = pairing.url,
                token = pairing.token,
                pairingGeneration = pairing.pairingGeneration,
                accountId = pairing.accountId,
                deviceId = pairing.deviceId ?: return null,
                name = pairing.gatewayName.orEmpty(),
                scopes = pairing.scopes,
                tlsMode = pairing.tlsMode.persistedValue,
                fingerprint = pairing.fingerprint,
            ),
        )
        val pending = pendingRevocationCredentials().toMutableList()
        val credential = OmnesisJson.decodeFromString<PairingCredentialBundle>(raw)
        if (credential !in pending) pending += credential
        val installId = store.get(Keys.INSTALL_ID)
        val encodedPending = OmnesisJson.encodeToString(pending)
        store.replaceAll(buildMap {
            if (installId != null) put(Keys.INSTALL_ID, installId)
            put(Keys.PENDING_REVOCATION, encodedPending)
        })
        return pairing
    }

    fun pendingRevocation(): Pairing? = pendingRevocationCredentials().firstOrNull()?.let(::pairingFromBundle)

    /** Compare-and-delete one exact generation from the durable FIFO outbox. */
    fun settlePendingRevocation(pairing: Pairing) {
        val pending = pendingRevocationCredentials().toMutableList()
        val index = pending.indexOfFirst {
            it.url == pairing.url &&
                it.deviceId == pairing.deviceId &&
                it.pairingGeneration == pairing.pairingGeneration
        }
        if (index < 0) return
        pending.removeAt(index)
        persistPendingRevocations(pending)
    }

    private fun pendingRevocationCredentials(): List<PairingCredentialBundle> {
        val raw = store.get(Keys.PENDING_REVOCATION) ?: return emptyList()
        return runCatching {
            OmnesisJson.decodeFromString<List<PairingCredentialBundle>>(raw)
        }.getOrElse {
            // Migration from the original single-entry journal.
            runCatching {
                listOf(OmnesisJson.decodeFromString<PairingCredentialBundle>(raw))
            }.getOrDefault(emptyList())
        }
    }

    private fun persistPendingRevocations(pending: List<PairingCredentialBundle>) {
        if (pending.isEmpty()) {
            store.delete(Keys.PENDING_REVOCATION)
        } else {
            store.set(Keys.PENDING_REVOCATION, OmnesisJson.encodeToString(pending))
        }
    }

    fun pushClaimCredential(deviceId: String): String? =
        if (store.get(Keys.PUSH_CLAIM_DEVICE_ID) == deviceId) {
            store.get(Keys.PUSH_CLAIM_TOKEN)
        } else null

    fun setPushClaimCredential(deviceId: String, token: String) {
        store.set(Keys.PUSH_CLAIM_DEVICE_ID, deviceId)
        store.set(Keys.PUSH_CLAIM_TOKEN, token)
    }

    fun clearPushClaimCredential() {
        store.delete(Keys.PUSH_CLAIM_DEVICE_ID)
        store.delete(Keys.PUSH_CLAIM_TOKEN)
    }

    private suspend fun exchangeAndPersist(
        gatewayUrl: String,
        pairingCode: String,
        fingerprint: String?,
        tlsMode: PairingTlsMode,
    ): Pairing {
        clearPushClaimCredential()
        val http = GatewayHttp(clientFactory(fingerprint), gatewayUrl, token = null)
        val response: DevicePairResponse = http.postJson(
            "devices/pair",
            PairExchangeBody(pairingCode = pairingCode, capabilities = capabilities()),
        )
        persistBundle(
            PairingCredentialBundle(
                url = gatewayUrl,
                token = response.token,
                pairingGeneration = response.tokenId.takeIf(String::isNotBlank),
                accountId = "local",
                deviceId = response.device.id,
                name = response.device.name,
                scopes = response.scopes,
                tlsMode = tlsMode.persistedValue,
                fingerprint = fingerprint,
            ),
        )
        return current() ?: error("pairing persisted but could not be read back")
    }

    private fun persistV1(p: PairingPayload.V1): Pairing {
        clearPushClaimCredential()
        persistBundle(
            PairingCredentialBundle(
                url = p.url,
                token = p.token,
                pairingGeneration = null,
                accountId = "local",
                deviceId = p.accountId,
                name = p.name,
                scopes = emptyList(),
                tlsMode = PairingTlsMode.LEGACY.persistedValue,
            ),
        )
        return current() ?: error("pairing persisted but could not be read back")
    }

    private fun persistBundle(bundle: PairingCredentialBundle) {
        // The complete credential and trust contract share one encrypted value.
        // Once this write returns it is authoritative; legacy split-key cleanup is
        // best-effort and can never expose a mixed or downgraded pairing.
        store.set(Keys.CREDENTIAL, OmnesisJson.encodeToString(bundle))
        legacyPairingKeys.forEach { key -> runCatching { store.delete(key) } }
    }

    private fun pairingFromBundle(bundle: PairingCredentialBundle): Pairing? {
        val tlsMode = PairingTlsMode.fromPersisted(bundle.tlsMode, bundle.fingerprint) ?: return null
        if (runCatching { PairingPayload.requireHttpsUrl(bundle.url) }.isFailure) return null
        if (tlsMode == PairingTlsMode.PINNED_LEAF &&
            runCatching { PairingPayload.requireValidFingerprint(bundle.fingerprint.orEmpty()) }.isFailure
        ) return null
        if (tlsMode == PairingTlsMode.SYSTEM &&
            runCatching { requireSystemOrigin(bundle.url) }.isFailure
        ) return null
        return Pairing(
            url = bundle.url,
            token = bundle.token,
            pairingGeneration = bundle.pairingGeneration,
            accountId = bundle.accountId,
            deviceId = bundle.deviceId,
            gatewayName = bundle.name,
            scopes = bundle.scopes,
            fingerprint = if (tlsMode == PairingTlsMode.SYSTEM) null else bundle.fingerprint,
            tlsMode = tlsMode,
        )
    }

    private fun capabilities(): DeviceCapabilities {
        val installId = installId()
        return deviceCapabilities.withPairingIdentity(
            hostname = deviceName,
            // Unique per install: two identical phones must never resolve to
            // one device row.
            suggestedName = "$deviceName-${installId.take(6)}",
            installId = installId,
            previousDeviceId = current()?.deviceId,
        )
    }

    /**
     * Stable per-install identity, minted once and kept in the secure store.
     * The gateway adopts the device row carrying it on re-pair.
     */
    private fun installId(): String {
        store.get(Keys.INSTALL_ID)?.let { return it }
        val fresh = java.util.UUID.randomUUID().toString()
        store.set(Keys.INSTALL_ID, fresh)
        return fresh
    }

    private fun requireSystemOrigin(raw: String): String {
        return PairingPayload.requireHttpsOrigin(raw)
    }

    /** Keychain key parity with iOS. */
    private object Keys {
        const val INSTALL_ID = "install.id"
        const val CREDENTIAL = "gateway.credential.v1"
        const val PENDING_REVOCATION = "gateway.pendingRevocation.v1"
        const val URL = "gateway.url"
        const val TOKEN = "gateway.token"
        const val ACCOUNT_ID = "gateway.accountId"
        const val DEVICE_ID = "gateway.deviceId"
        const val NAME = "gateway.name"
        const val SCOPES = "gateway.scopes"
        const val FINGERPRINT = "gateway.fingerprint"
        const val TLS_MODE = "gateway.tlsMode"
        const val PUSH_CLAIM_DEVICE_ID = "push.claim.deviceId"
        const val PUSH_CLAIM_TOKEN = "push.claim.token"
    }

    private companion object {
        val legacyPairingKeys = listOf(
            Keys.URL,
            Keys.TOKEN,
            Keys.ACCOUNT_ID,
            Keys.DEVICE_ID,
            Keys.NAME,
            Keys.SCOPES,
            Keys.FINGERPRINT,
            Keys.TLS_MODE,
        )
    }
}
