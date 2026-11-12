// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.pairing

import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.DeviceCapabilities
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.postJson
import dev.omnesis.android.transport.tls.GatewayTrustPolicy
import dev.omnesis.android.transport.tls.PinnedOkHttp
import dev.omnesis.android.transport.routing.DirectGatewayCandidate
import dev.omnesis.android.transport.routing.DirectGatewayRoute
import kotlinx.serialization.encodeToString
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
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
    private val strictClientFactory: (fingerprint: String) -> OkHttpClient = { fp ->
        PinnedOkHttp.build(fp, requirePin = true, requireCertificateValidity = true)
    },
    private val keyClientFactory: (spkiFingerprint: String, host: String) -> OkHttpClient = { spki, host ->
        PinnedOkHttp.build(spkiFingerprint = spki, host = host, requirePin = true)
    },
    private val fetchDirectCandidates: suspend (String, String, String) -> List<DirectGatewayCandidate> = ::fetchPairedDirectCandidates,
    /** Follows the capability the build sets with cloud connectivity. Off, pairing behaves as it did before the feature. */
    private val cloudRelay: Boolean = deviceCapabilities.pairingNotifications,
) {
    private val mutations = ReentrantLock()
    private var generation = java.util.UUID.randomUUID()

    private fun begin(): java.util.UUID = mutations.withLock {
        generation = java.util.UUID.randomUUID()
        generation
    }

    /** Pair from a scanned QR payload (V1-V4). */
    suspend fun pair(raw: String): Pairing {
        val payload = PairingPayload.decode(raw, cloudRelay)
        if (cloudRelay) currentCoroutineContext().ensureActive()
        val operation = begin()
        return when (val p = payload) {
        is PairingPayload.V4 -> when (val tls = p.tls) {
            PairingPayload.V4Tls.System -> exchangeAndPersist(
                operation,
                p.gatewayUrl,
                p.pairingCode,
                fingerprint = null,
                tlsMode = PairingTlsMode.SYSTEM,
            )
            is PairingPayload.V4Tls.PinnedLeaf -> exchangeAndPersist(
                operation,
                p.gatewayUrl,
                p.pairingCode,
                fingerprint = tls.fingerprint.lowercase(),
                tlsMode = PairingTlsMode.PINNED_LEAF,
            )
            is PairingPayload.V4Tls.PinnedKeyStrict -> exchangeAndPersist(
                operation,
                p.gatewayUrl, p.pairingCode, fingerprint = null, tlsMode = PairingTlsMode.PINNED_KEY_STRICT,
                spkiFingerprint = tls.spkiFingerprint.lowercase(),
            )
            is PairingPayload.V4Tls.PinnedLeafStrict -> exchangeAndPersist(
                operation,
                p.gatewayUrl, p.pairingCode, fingerprint = tls.fingerprint.lowercase(),
                tlsMode = PairingTlsMode.PINNED_LEAF_STRICT,
            )
        }
        is PairingPayload.V1 -> mutations.withLock {
            checkOperation(operation)
            persistV1(p)
        }
        is PairingPayload.V2 -> exchangeAndPersist(
                operation,
            p.gatewayUrl,
            p.pairingCode,
            fingerprint = null,
            tlsMode = PairingTlsMode.LEGACY,
        )
        is PairingPayload.V3 -> exchangeAndPersist(
                operation,
            p.gatewayUrl,
            p.pairingCode,
            fingerprint = p.fingerprint.lowercase(),
            tlsMode = PairingTlsMode.PINNED_LEAF,
        )
    }

    }

    /**
     * Pair from a sign-in enrollment. The gateway recorded this install's key with the request,
     * so the token's rotation clock starts now.
     */
    suspend fun pairEnrolled(raw: String, now: Long = System.currentTimeMillis()): Pairing {
        pair(raw)
        return markDeviceKeyRecorded(now)
    }

    internal fun markDeviceKeyRecorded(now: Long): Pairing = mutations.withLock {
        val bundle = store.get(Keys.CREDENTIAL)?.let { OmnesisJson.decodeFromString<PairingCredentialBundle>(it) }
            ?: error("pairing persisted but could not be read back")
        persistBundle(bundle.copy(deviceKeyRecorded = true, tokenRotatedAt = now))
        current() ?: error("pairing persisted but could not be read back")
    }

    /**
     * Swap in a rotated token if [expected] is still the current pairing. The token and its
     * generation share the one encrypted value, so a reader sees the old pair or the new one.
     */
    fun replaceToken(expected: Pairing, token: String, tokenId: String?, now: Long): Boolean = mutations.withLock {
        val saved = current() ?: return false
        if (saved.token != expected.token || saved.deviceId != expected.deviceId || saved.url != expected.url) return false
        val raw = store.get(Keys.CREDENTIAL) ?: return false
        val bundle = OmnesisJson.decodeFromString<PairingCredentialBundle>(raw)
        persistBundle(bundle.copy(
            token = token,
            pairingGeneration = tokenId?.takeIf(String::isNotBlank) ?: bundle.pairingGeneration,
            tokenRotatedAt = now,
        ))
        true
    }

    /** Pair from manual entry (V2-style; V3 when a fingerprint is supplied). */
    suspend fun pairManually(gatewayUrl: String, pairingCode: String, fingerprint: String? = null): Pairing {
        PairingPayload.requireHttpsUrl(gatewayUrl)
        if (cloudRelay) currentCoroutineContext().ensureActive()
        val operation = begin()
        val fp = fingerprint?.takeIf { it.isNotBlank() }?.lowercase()?.also(PairingPayload::requireValidFingerprint)
        return exchangeAndPersist(
                operation,
            gatewayUrl,
            pairingCode,
            fp,
            if (fp == null) PairingTlsMode.LEGACY else PairingTlsMode.PINNED_LEAF,
        )
    }

    /** The currently persisted pairing, or null if unpaired (any required key missing). */
    fun current(): Pairing? {
        return mutations.withLock {
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
            if (tlsMode == PairingTlsMode.PINNED_KEY_STRICT || tlsMode.isStrict && !cloudRelay) return null
            if (runCatching { PairingPayload.requireHttpsUrl(url) }.isFailure) return null
            if (tlsMode.requiresPin &&
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
    }

    /** Switch gateway URL (LAN/Tailscale/IP) without re-pairing. */
    fun updateGatewayURL(url: String) {
        return mutations.withLock {
            generation = java.util.UUID.randomUUID()
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
    }

    /**
     * Switch a pinned-leaf pairing to system trust after the gateway presented a
     * chain the platform trusts for the paired DNS name, so a later renewal of that
     * publicly trusted certificate cannot strand the phone. Applies only when
     * the pairing URL is an HTTPS origin whose host qualifies under
     * [GatewayTrustPolicy.systemTrustQualifies]; everything else about the pairing,
     * its generation included, is kept. Returns true when the pairing changed.
     */
    fun upgradeTrustToSystem(): Boolean {
        return mutations.withLock {
            val pairing = current() ?: return false
            if (pairing.tlsMode != PairingTlsMode.PINNED_LEAF) return false
            if (runCatching { requireSystemOrigin(pairing.url) }.isFailure) return false
            val host = runCatching { PairingPayload.requireHttpsUrl(pairing.url).host }.getOrNull()
            if (!GatewayTrustPolicy.systemTrustQualifies(host)) return false
            val existing = store.get(Keys.CREDENTIAL)?.let { raw ->
                runCatching { OmnesisJson.decodeFromString<PairingCredentialBundle>(raw) }.getOrNull()
            }
            val bundle = existing ?: PairingCredentialBundle(
                url = pairing.url,
                token = pairing.token,
                pairingGeneration = pairing.pairingGeneration,
                accountId = pairing.accountId,
                deviceId = pairing.deviceId ?: return false,
                name = pairing.gatewayName.orEmpty(),
                scopes = pairing.scopes,
                tlsMode = pairing.tlsMode.persistedValue,
                fingerprint = pairing.fingerprint,
                spkiFingerprint = pairing.spkiFingerprint,
                directCandidates = pairing.directCandidates,
            )
            persistBundle(bundle.copy(tlsMode = PairingTlsMode.SYSTEM.persistedValue, fingerprint = null))
            return true

        }
    }

    /** Refresh authenticated routing facts without changing the credential or pairing generation. */
    fun updateDirectCandidates(expected: Pairing, candidates: List<DirectGatewayCandidate>): Boolean =
        updateDirectCandidates(expected, candidates) { }

    /** Apply live routing changes while the same authority still owns the mutation fence. */
    fun updateDirectCandidates(expected: Pairing, candidates: List<DirectGatewayCandidate>, apply: (Pairing) -> Unit): Boolean = mutations.withLock {
        val saved = current() ?: return false
        if (!saved.tlsMode.isStrict || saved.copy(directCandidates = expected.directCandidates) != expected) return false
        DirectGatewayRoute.create(saved.url, candidates)
        if (saved.directCandidates == candidates) { apply(saved); return true }
        val raw = store.get(Keys.CREDENTIAL) ?: return false
        val bundle = OmnesisJson.decodeFromString<PairingCredentialBundle>(raw)
        persistBundle(bundle.copy(directCandidates = candidates))
        apply(saved.copy(directCandidates = candidates))
        true
    }

    /**
     * Forget the pairing. The install identity survives: it is what lets the
     * next pairing adopt this phone's existing device row on the gateway.
     */
    fun unpair() {
        return mutations.withLock {
            generation = java.util.UUID.randomUUID()
            val installId = store.get(Keys.INSTALL_ID)
            val pendingRevocations = store.get(Keys.PENDING_REVOCATION)
            store.replaceAll(buildMap {
                if (installId != null) put(Keys.INSTALL_ID, installId)
                if (pendingRevocations != null) put(Keys.PENDING_REVOCATION, pendingRevocations)
            })

        }
    }

    /** Persist the credential needed for remote revocation before local unpair. */
    fun stageUnpair(): Pairing? {
        return mutations.withLock {
            generation = java.util.UUID.randomUUID()
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
                    spkiFingerprint = pairing.spkiFingerprint,
                    directCandidates = pairing.directCandidates,
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
    }

    fun pendingRevocation(): Pairing? = pendingRevocationCredentials().firstOrNull()?.let(::pairingFromBundle)

    /** Compare-and-delete one exact generation from the durable FIFO outbox. */
    fun settlePendingRevocation(pairing: Pairing) {
        return mutations.withLock {
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
        return mutations.withLock {
            store.set(Keys.PUSH_CLAIM_DEVICE_ID, deviceId)
            store.set(Keys.PUSH_CLAIM_TOKEN, token)

        }
    }

    fun clearPushClaimCredential() {
        return mutations.withLock {
            store.delete(Keys.PUSH_CLAIM_DEVICE_ID)
            store.delete(Keys.PUSH_CLAIM_TOKEN)

        }
    }

    private suspend fun exchangeAndPersist(
        operation: java.util.UUID,
        gatewayUrl: String,
        pairingCode: String,
        fingerprint: String?,
        tlsMode: PairingTlsMode,
        spkiFingerprint: String? = null,
    ): Pairing {
        if (!cloudRelay) clearPushClaimCredential()
        val client = if (tlsMode == PairingTlsMode.PINNED_KEY_STRICT) keyClientFactory(requireNotNull(spkiFingerprint), java.net.URI(gatewayUrl).host)
            else if (tlsMode == PairingTlsMode.PINNED_LEAF_STRICT) strictClientFactory(requireNotNull(fingerprint))
            else clientFactory(fingerprint)
        val http = GatewayHttp(client, gatewayUrl, token = null)
        val response: DevicePairResponse = http.postJson(
            "devices/pair",
            PairExchangeBody(pairingCode = pairingCode, capabilities = capabilities()),
        )
        val directCandidates = if (tlsMode == PairingTlsMode.PINNED_KEY_STRICT) {
            optionalDirectCandidates {
                val candidates = fetchDirectCandidates(gatewayUrl, response.token, requireNotNull(spkiFingerprint))
                DirectGatewayRoute.create(gatewayUrl, candidates)
                candidates
            }
        } else emptyList()
        if (cloudRelay) currentCoroutineContext().ensureActive()
        return mutations.withLock {
            checkOperation(operation)
            if (cloudRelay) clearPushClaimCredential()
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
                    spkiFingerprint = spkiFingerprint,
                    directCandidates = directCandidates,
                ),
            )
            current() ?: error("pairing persisted but could not be read back")
        }
    }

    private fun checkOperation(operation: java.util.UUID) {
        if (cloudRelay && generation != operation) throw CancellationException("pairing superseded")
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
        if (tlsMode.isStrict && !cloudRelay) return null
        if (runCatching { PairingPayload.requireHttpsUrl(bundle.url) }.isFailure) return null
        val pin = if (tlsMode == PairingTlsMode.PINNED_KEY_STRICT) bundle.spkiFingerprint else bundle.fingerprint
        if (tlsMode.requiresPin &&
            runCatching { PairingPayload.requireValidFingerprint(pin.orEmpty()) }.isFailure
        ) return null
        if (tlsMode == PairingTlsMode.SYSTEM &&
            runCatching { requireSystemOrigin(bundle.url) }.isFailure
        ) return null
        val directCandidates = if (tlsMode.isStrict) runCatching {
            DirectGatewayRoute.create(bundle.url, bundle.directCandidates)
            bundle.directCandidates
        }.getOrDefault(emptyList()) else emptyList()
        return Pairing(
            url = bundle.url,
            token = bundle.token,
            pairingGeneration = bundle.pairingGeneration,
            accountId = bundle.accountId,
            deviceId = bundle.deviceId,
            gatewayName = bundle.name,
            scopes = bundle.scopes,
            fingerprint = if (tlsMode == PairingTlsMode.SYSTEM) null else bundle.fingerprint,
            spkiFingerprint = if (tlsMode == PairingTlsMode.PINNED_KEY_STRICT) bundle.spkiFingerprint else null,
            directCandidates = directCandidates,
            tlsMode = tlsMode,
            deviceKeyRecorded = bundle.deviceKeyRecorded,
            tokenRotatedAt = bundle.tokenRotatedAt,
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
    private fun installId(): String = mutations.withLock {
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
