// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

@Serializable
enum class AccessSourceMode {
    @kotlinx.serialization.SerialName("all") ALL,
    @kotlinx.serialization.SerialName("allowlist") ALLOWLIST,
    @kotlinx.serialization.SerialName("denylist") DENYLIST,
}

@Serializable
data class AccessSourceBoundary(val mode: AccessSourceMode, val sourceIds: List<String>) {
    init {
        require(sourceIds.all(String::isNotBlank) && sourceIds.distinct().size == sourceIds.size)
        require(mode != AccessSourceMode.ALL || sourceIds.isEmpty())
    }
}

@Serializable
enum class AccessCapability {
    @kotlinx.serialization.SerialName("notes") NOTES,
    @kotlinx.serialization.SerialName("answer") ANSWER,
    @kotlinx.serialization.SerialName("direct") DIRECT,
}

@Serializable
enum class AccessAnswerReleaseMode {
    @kotlinx.serialization.SerialName("reviewed") REVIEWED,
    @kotlinx.serialization.SerialName("unreviewed") UNREVIEWED,
}

@Serializable
data class AccessAnswerRelease(
    val mode: AccessAnswerReleaseMode,
    val policyFamilyId: String? = null,
) {
    init {
        require(
            (mode == AccessAnswerReleaseMode.REVIEWED && !policyFamilyId.isNullOrBlank()) ||
                (mode == AccessAnswerReleaseMode.UNREVIEWED && policyFamilyId == null),
        ) { "A reviewed Answer release requires one policy; an unreviewed release cannot name one" }
    }

    companion object {
        fun reviewed(policyFamilyId: String): AccessAnswerRelease {
            require(policyFamilyId.isNotBlank())
            return AccessAnswerRelease(AccessAnswerReleaseMode.REVIEWED, policyFamilyId)
        }

        fun unreviewed() = AccessAnswerRelease(AccessAnswerReleaseMode.UNREVIEWED)
    }
}

@Serializable
data class AccessGrantRule(
    val capability: AccessCapability,
    val sources: AccessSourceBoundary,
    val release: AccessAnswerRelease? = null,
) {
    init {
        require(
            (capability == AccessCapability.ANSWER && release != null) ||
                (capability != AccessCapability.ANSWER && release == null),
        ) { "Answer rules require a release policy; Direct and Notes rules cannot have one" }
        require(capability != AccessCapability.NOTES || (sources.mode == AccessSourceMode.ALL && sources.sourceIds.isEmpty()))
    }

    companion object {
        fun notes() = AccessGrantRule(AccessCapability.NOTES, AccessSourceBoundary(AccessSourceMode.ALL, emptyList()))

        fun answer(sources: AccessSourceBoundary, release: AccessAnswerRelease) =
            AccessGrantRule(AccessCapability.ANSWER, sources, release)

        fun direct(sources: AccessSourceBoundary) =
            AccessGrantRule(AccessCapability.DIRECT, sources)
    }
}

@Serializable
data class AccessSourceInstance(
    val id: String,
    val name: String,
    val icon: String? = null,
    val available: Boolean = true,
)

@Serializable
data class AccessPolicyFamilySummary(val id: String, val name: String, val revision: String)

/**
 * An authorization request still waiting on the owner, as the overview lists it. [userCode]
 * is the short code the client showed; [id] resolves the same request without it.
 */
@Serializable
data class AccessPendingRequest(
    val id: String,
    val clientName: String,
    val userCode: String,
    val createdAt: Long,
    val expiresAt: Long,
)

@Serializable
data class AccessCredentialSummary(
    val id: String,
    val label: String,
    val status: String,
    val revokedAt: Long? = null,
    /** When this sign-in last reached the gateway; null until it has. */
    val lastUsedAt: Long? = null,
    /** The name the signed-in app reported for itself; null from a gateway that does not send it. */
    val clientName: String? = null,
)

@Serializable
data class AccessGrantSummary(
    val id: String,
    val name: String,
    val revision: Int,
    val rules: List<AccessGrantRule>,
    val credentials: List<AccessCredentialSummary>,
    val expiresAt: Long? = null,
    val revokedAt: Long? = null,
    /**
     * The access level these permissions come from. Null only for a revoked or legacy grant,
     * or from a gateway without access levels.
     */
    val levelId: String? = null,
)

/**
 * A named set of permissions that any number of connections use. Gateway type:
 * `AccessLevelSummary` in `packages/gateway/src/access/types.ts`.
 */
@Serializable
data class AccessLevelSummary(
    val id: String,
    val name: String,
    val revision: Int,
    val rules: List<AccessGrantRule>,
    /** How many live connections use this level. */
    val connectionCount: Int,
)

@Serializable
data class AccessPrincipalSummary(
    val id: String,
    val name: String,
    val kind: String,
    val grants: List<AccessGrantSummary>,
    val revokedAt: Long? = null,
)

@Serializable(with = AccessOverviewSerializer::class)
data class AccessOverview(
    val principals: List<AccessPrincipalSummary>,
    val sources: List<AccessSourceInstance>,
    val policyFamilies: List<AccessPolicyFamilySummary> = emptyList(),
    val defaultPolicyFamilyId: String? = null,
    /** Requests waiting on the owner, newest first; empty from a gateway that does not list them. */
    val pendingRequests: List<AccessPendingRequest> = emptyList(),
    /** The live access levels; empty from a gateway that has none or predates them. */
    val levels: List<AccessLevelSummary> = emptyList(),
)

@Serializable
private data class AccessOverviewWire(
    val principals: List<AccessPrincipalSummary>,
    val sources: List<AccessSourceInstance>,
    val policyFamilies: List<AccessPolicyFamilySummary>? = null,
    val privacyPolicies: List<AccessPolicyFamilySummary>? = null,
    val defaultPolicyFamilyId: String? = null,
    val pendingRequests: List<AccessPendingRequest>? = null,
    val levels: List<AccessLevelSummary>? = null,
)

object AccessOverviewSerializer : KSerializer<AccessOverview> {
    override val descriptor: SerialDescriptor = AccessOverviewWire.serializer().descriptor

    override fun deserialize(decoder: Decoder): AccessOverview {
        val wire = AccessOverviewWire.serializer().deserialize(decoder)
        return AccessOverview(
            principals = wire.principals,
            sources = wire.sources,
            policyFamilies = wire.policyFamilies ?: wire.privacyPolicies.orEmpty(),
            defaultPolicyFamilyId = wire.defaultPolicyFamilyId,
            pendingRequests = wire.pendingRequests.orEmpty(),
            levels = wire.levels.orEmpty(),
        )
    }

    override fun serialize(encoder: Encoder, value: AccessOverview) {
        AccessOverviewWire.serializer().serialize(
            encoder,
            AccessOverviewWire(
                principals = value.principals,
                sources = value.sources,
                policyFamilies = value.policyFamilies,
                defaultPolicyFamilyId = value.defaultPolicyFamilyId,
                pendingRequests = value.pendingRequests,
                levels = value.levels,
            ),
        )
    }
}

@Serializable
data class AccessAuthorizationRequest(
    val id: String,
    val approvalId: String,
    val status: String,
    val clientId: String,
    val clientName: String,
    val clientUri: String? = null,
    val redirectOrigin: String,
    val resource: String,
    val scope: String,
    val expiresAt: Long,
    val requiresAnswer: Boolean,
)

@Serializable
data class AccessAuthorizationLookupBody(val code: String)

/**
 * The access a connecting client already holds, as a gateway without connection proposals
 * reports it: approving with [AccessAuthorizationSelection.Connect] reconnects the client to
 * [grant]. A gateway that sends [AccessAuthorizationLookupEnvelope.connection] always sends
 * null here.
 *
 * [matchedBy] is `"client"` when a live credential carries the request's OAuth client id and
 * `"name"` when a live interactive principal shares the request's client name.
 */
@Serializable
data class AccessReconnectProposal(
    val matchedBy: String,
    val principal: AccessReconnectPrincipal,
    val grant: AccessGrantSummary,
)

@Serializable
data class AccessReconnectPrincipal(val id: String, val name: String)

/**
 * How the gateway suggests approving a pending request. Gateway type:
 * `AccessConnectionProposal` in `packages/gateway/src/access/types.ts`.
 *
 * [defaultName] and [defaultLevelName] are the names a new connection and a new access level
 * take unless the owner changes them. [match] is the live connection from the same app the
 * gateway found, if any. [recommended] is `"existing-level"`, `"new-level"` or `"replace"`; a
 * value this build does not know reads as `"new-level"`.
 */
@Serializable
data class AccessConnectionProposal(
    val defaultName: String,
    val defaultLevelName: String = "",
    val match: AccessConnectionMatch? = null,
    val recommended: String = "new-level",
)

/**
 * A live connection from the same app as the request. [matchedBy] is `"device"`, `"client"`
 * or `"name"`; [grant] is that connection's current permissions.
 */
@Serializable
data class AccessConnectionMatch(
    val connectionId: String,
    val connectionName: String,
    val matchedBy: String,
    val levelId: String? = null,
    val grant: AccessGrantSummary,
)

/**
 * A lookup reply. [connection] is present for a pending request on a gateway that knows
 * connections; its absence means the gateway predates them and accepts only
 * [AccessAuthorizationSelection.Connect].
 */
@Serializable
data class AccessAuthorizationLookupEnvelope(
    val request: AccessAuthorizationRequest,
    val reconnect: AccessReconnectProposal? = null,
    val connection: AccessConnectionProposal? = null,
)

/** The access level a new connection uses. */
sealed interface AccessConnectionLevel {
    /** A level created by this approval, holding [rules]. */
    data class New(val name: String, val rules: List<AccessGrantRule>) : AccessConnectionLevel {
        init {
            require(name.isNotBlank() && name.length <= MAX_ACCESS_NAME_LENGTH)
            require(rules.isNotEmpty())
        }
    }

    /** A live level, at the revision the owner reviewed. */
    data class Existing(val levelId: String, val expectedLevelRevision: Int) : AccessConnectionLevel {
        init {
            require(levelId.isNotBlank())
        }
    }
}

/** The longest connection or access level name the gateway accepts, after trimming. */
const val MAX_ACCESS_NAME_LENGTH = 120

sealed interface AccessAuthorizationSelection {
    /** A new connection named [name], whose permissions are those of [level]. */
    data class NewConnection(
        val name: String,
        val level: AccessConnectionLevel,
    ) : AccessAuthorizationSelection {
        init {
            require(name.isNotBlank() && name.length <= MAX_ACCESS_NAME_LENGTH)
        }
    }

    /**
     * The client signs in as the existing connection, keeping its name and access level, at
     * the grant revision reviewed; the connection's other sign-ins stop working once this one
     * completes.
     */
    data class ReplaceConnection(
        val connectionId: String,
        val expectedGrantRevision: Int,
    ) : AccessAuthorizationSelection {
        init {
            require(connectionId.isNotBlank())
        }
    }

    /**
     * The client connects with these rules and the gateway chooses the connection. This is
     * the only kind a gateway without connection proposals accepts.
     */
    data class Connect(
        val rules: List<AccessGrantRule>,
        val credentialLabel: String,
    ) : AccessAuthorizationSelection {
        init {
            require(rules.isNotEmpty())
            require(credentialLabel.isNotBlank() && credentialLabel.length <= 160)
        }
    }
}

sealed interface AccessAuthorizationDecision {
    data object Deny : AccessAuthorizationDecision
    data class Approve(val selection: AccessAuthorizationSelection) : AccessAuthorizationDecision

    fun toWireJson(): JsonObject = buildJsonObject {
        when (this@AccessAuthorizationDecision) {
            Deny -> put("decision", "deny")
            is Approve -> {
                put("decision", "approve")
                val selected = selection
                put("selection", buildJsonObject {
                    when (selected) {
                        is AccessAuthorizationSelection.NewConnection -> {
                            put("kind", "new-connection")
                            put("name", selected.name)
                            put("level", buildJsonObject {
                                when (val level = selected.level) {
                                    is AccessConnectionLevel.New -> {
                                        put("kind", "new")
                                        put("name", level.name)
                                        put("rules", OmnesisJson.encodeToJsonElement(level.rules))
                                    }
                                    is AccessConnectionLevel.Existing -> {
                                        put("kind", "existing")
                                        put("levelId", level.levelId)
                                        put("expectedLevelRevision", level.expectedLevelRevision)
                                    }
                                }
                            })
                        }
                        is AccessAuthorizationSelection.ReplaceConnection -> {
                            put("kind", "replace-connection")
                            put("connectionId", selected.connectionId)
                            put("expectedGrantRevision", selected.expectedGrantRevision)
                        }
                        is AccessAuthorizationSelection.Connect -> {
                            put("kind", "connect")
                            put("rules", OmnesisJson.encodeToJsonElement(selected.rules))
                            put("credentialLabel", selected.credentialLabel)
                        }
                    }
                })
            }
        }
    }
}
