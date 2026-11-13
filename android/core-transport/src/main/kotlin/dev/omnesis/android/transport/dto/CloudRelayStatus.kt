// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.time.Instant

/**
 * `GET /admin/cloud-relay` and the answer of every operation under it: the gateway's
 * `CloudRelayManagementStatus` (`packages/cloud-relay/src/management.ts`).
 *
 * Every field is optional and every state is a plain string, so a gateway that adds a field,
 * a state or an error code still decodes; the screen treats what it does not know as absent.
 */
@Serializable
data class CloudRelayStatus(
    val enabled: Boolean? = null,
    val serviceConfigured: Boolean? = null,
    val serviceError: String? = null,
    val gatewayId: String? = null,
    val hostname: String? = null,
    val publicOrigin: String? = null,
    val config: CloudRelayConfig? = null,
    val enrollment: CloudRelayEnrollment? = null,
    val tunnel: CloudRelayTunnel? = null,
    val certificate: CloudRelayCertificate? = null,
    val publicMcp: CloudRelayPublicMcp? = null,
    val google: CloudRelayGoogleLink? = null,
    val account: CloudRelayAccountLink? = null,
    val connect: CloudRelayConnect? = null,
    val deviceEnrollment: DeviceEnrollmentSettings? = null,
    val identities: List<CloudRelayIdentity>? = null,
    val directCertificate: CloudRelayDirectCertificate? = null,
    val recovery: CloudRelayRecovery? = null,
    val certificateMonitor: CloudRelayCertificateMonitor? = null,
    val can: CloudRelayAbilities? = null,
)

@Serializable
data class CloudRelayConfig(
    val relayUrl: String? = null,
    val acmeDirectoryUrl: String? = null,
    val acmeTermsUrl: String? = null,
)

/** `state`: `unconfigured`, `pending`, `enrolled` or `failed`. */
@Serializable
data class CloudRelayEnrollment(val state: String? = null, val error: String? = null)

/** `state`: `disabled`, `offline`, `connecting` or `online`. */
@Serializable
data class CloudRelayTunnel(
    val state: String? = null,
    val lastConnectedAt: JsonElement? = null,
    val lastError: String? = null,
)

/** `state`: `unconfigured`, `bootstrap`, `valid`, `expiring`, `expired` or `failed`. */
@Serializable
data class CloudRelayCertificate(
    val state: String? = null,
    val expiresAt: JsonElement? = null,
    val lastRenewedAt: JsonElement? = null,
    val lastError: String? = null,
)

@Serializable
data class CloudRelayPublicMcp(val ready: Boolean? = null, val url: String? = null, val lastError: String? = null)

/** The Google-only link that predates Omnesis accounts. */
@Serializable
data class CloudRelayGoogleLink(
    val configured: Boolean? = null,
    val linked: Boolean? = null,
    val canLink: Boolean? = null,
    val canUnlink: Boolean? = null,
    val lastError: String? = null,
)

@Serializable
data class CloudRelayAccountLink(
    val activated: Boolean? = null,
    val configured: Boolean? = null,
    val linked: Boolean? = null,
    val canLink: Boolean? = null,
    val canUnlink: Boolean? = null,
    val pendingUnlink: Boolean? = null,
    val lastError: String? = null,
)

/**
 * Progress of connecting by sign-in. `state`: `idle`, `waiting`, `registering`, `linking`,
 * `done` or `failed`. The addresses and the code are present only while waiting.
 */
@Serializable
data class CloudRelayConnect(
    val state: String? = null,
    val authorizeUrl: String? = null,
    val connectUrl: String? = null,
    val connectShortUrl: String? = null,
    val code: String? = null,
    val expiresAt: JsonElement? = null,
    val error: String? = null,
)

@Serializable
data class CloudRelayIdentity(
    val id: String? = null,
    val names: List<String>? = null,
    val label: String? = null,
    val kind: String? = null,
    val state: String? = null,
    val expiresAt: JsonElement? = null,
)

@Serializable
data class CloudRelayDirectCertificate(val state: String? = null, val expiresAt: JsonElement? = null)

/** `receipt`: `missing`, `present`, `expired` or `invalid`. */
@Serializable
data class CloudRelayRecovery(val receipt: String? = null, val expiresAt: JsonElement? = null)

@Serializable
data class CloudRelayCertificateMonitor(
    val state: String? = null,
    val lastCompletedAt: JsonElement? = null,
    val lastError: String? = null,
    val incidents: List<CloudRelayCertificateIncident>? = null,
)

/** A certificate naming this gateway that was issued for a key the gateway does not hold. */
@Serializable
data class CloudRelayCertificateIncident(
    val hostname: String? = null,
    val spkiFingerprint: String? = null,
    val certificateFingerprint: String? = null,
    val issuer: String? = null,
    val serial: String? = null,
    val validFrom: JsonElement? = null,
    val validTo: JsonElement? = null,
    val observedAt: JsonElement? = null,
    val providerEntryId: String? = null,
)

@Serializable
data class CloudRelayAbilities(
    val configure: Boolean? = null,
    val enable: Boolean? = null,
    val disable: Boolean? = null,
    val reconnect: Boolean? = null,
)

/**
 * A moment the gateway sent as an ISO string, milliseconds or Unix seconds, in epoch
 * milliseconds. Null for anything else.
 */
fun relayEpochMillis(value: JsonElement?): Long? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive.isString) return runCatching { Instant.parse(primitive.content).toEpochMilli() }.getOrNull()
    val number = primitive.doubleOrNull?.takeIf { it.isFinite() } ?: return null
    return (if (number < 1e12) number * 1000 else number).toLong()
}

@Serializable
internal data class CloudRelayConnectBody(val termsAccepted: Boolean, val intent: String)

@Serializable
internal class CloudRelayEmptyBody

/** The Omnesis account settings a paired admin device can read and change on its gateway. */
interface CloudRelayManaging {
    suspend fun cloudRelayStatus(): CloudRelayStatus

    /** Start connecting by sign-in. [intent] is `create` for a new account, `existing` otherwise. */
    suspend fun connectCloudRelay(intent: String): CloudRelayStatus
    suspend fun cancelCloudRelayConnect(): CloudRelayStatus

    /** One of the bodiless operations: `enable`, `disable`, `reconnect` or `account/unlink`. */
    suspend fun cloudRelayOperation(operation: String): CloudRelayStatus
    suspend fun setCloudRelayEnrollmentPolicy(policy: String): CloudRelayStatus
}
