// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import kotlinx.serialization.Serializable

enum class SourceMultiDeviceMode(val wireValue: String) {
    EXCLUSIVE("exclusive"),
    HANDOFF("handoff"),
    REPLICATED("replicated"),
    PARTITIONED("partitioned"),
}

enum class ReplicaVersionPolicy(val wireValue: String) {
    SOURCE_UPDATED_AT("source-updated-at"),
}

/** Source-owned multi-device behavior, aggregated only at app composition. */
data class HostedSourceContract(
    val sourceType: String,
    val multiDeviceMode: SourceMultiDeviceMode = SourceMultiDeviceMode.EXCLUSIVE,
    val replicaVersionPolicy: ReplicaVersionPolicy? = null,
)

/** One capability shape shared by pairing and every device-socket hello. */
@Serializable
data class DeviceCapabilities(
    val platform: String,
    /**
     * Product version of this app build.
     *
     * The gateway's version ledger reads it to tell a phone on the current
     * release from one still on an older build — a normal state for an app,
     * whose store release trails the tag it was cut from. Optional on the
     * wire: a gateway never rejects a hello for omitting it.
     */
    val version: String? = null,
    val hostname: String? = null,
    val suggestedName: String? = null,
    val installId: String? = null,
    val previousDeviceId: String? = null,
    val pushAppId: String? = null,
    val hostableSourceTypes: List<String>,
    val pushBasedSourceTypes: List<String>,
    val multiDeviceModes: Map<String, String>,
    val replicaVersionPolicies: Map<String, String> = emptyMap(),
    val syncLease: Boolean = false,
) {
    fun withPairingIdentity(
        hostname: String,
        suggestedName: String,
        installId: String,
        previousDeviceId: String?,
    ) = copy(
        hostname = hostname,
        suggestedName = suggestedName,
        installId = installId,
        previousDeviceId = previousDeviceId,
    )

    companion object {
        /**
         * The capability set this app announces. `version` is supplied by the
         * composition root rather than read here, because the version lives
         * in the application module's `BuildConfig` and this transport module
         * has none of its own — which also keeps the pure-JVM tests able to
         * build a payload without an Android build at all.
         */
        fun android(
            contracts: Collection<HostedSourceContract>,
            version: String? = null,
            pushAppId: String? = null,
        ): DeviceCapabilities {
            require(contracts.all { it.sourceType.isNotBlank() }) { "source types must not be blank" }
            require(contracts.map { it.sourceType }.distinct().size == contracts.size) {
                "hosted source contracts must have unique source types"
            }
            val ordered = contracts.sortedBy(HostedSourceContract::sourceType)
            return DeviceCapabilities(
                platform = "android",
                version = version,
                pushAppId = pushAppId,
                hostableSourceTypes = ordered.map(HostedSourceContract::sourceType),
                pushBasedSourceTypes = ordered.map(HostedSourceContract::sourceType),
                multiDeviceModes = ordered
                    .filter { it.multiDeviceMode != SourceMultiDeviceMode.EXCLUSIVE }
                    .associate { it.sourceType to it.multiDeviceMode.wireValue },
                replicaVersionPolicies = ordered.mapNotNull { contract ->
                    contract.replicaVersionPolicy?.let { contract.sourceType to it.wireValue }
                }.toMap(),
                syncLease = ordered.any {
                    it.multiDeviceMode == SourceMultiDeviceMode.HANDOFF ||
                        it.multiDeviceMode == SourceMultiDeviceMode.REPLICATED
                },
            )
        }
    }
}
