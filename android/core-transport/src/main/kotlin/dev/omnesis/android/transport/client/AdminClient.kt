// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.PermissionHealthSnapshot
import dev.omnesis.android.transport.SourceMultiDeviceMode
import dev.omnesis.android.transport.SourceModeTransitionNotConfirmed
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.ActivateModelBody
import dev.omnesis.android.transport.dto.AccessAuthorizationDecision
import dev.omnesis.android.transport.dto.AccessAuthorizationLookupBody
import dev.omnesis.android.transport.dto.AccessAuthorizationLookupEnvelope
import dev.omnesis.android.transport.dto.AccessOverview
import dev.omnesis.android.transport.dto.AddBackendBody
import dev.omnesis.android.transport.dto.AssignCapabilityBody
import dev.omnesis.android.transport.dto.BackendProbeResult
import dev.omnesis.android.transport.dto.CapabilityVerdict
import dev.omnesis.android.transport.dto.CancelDownloadBody
import dev.omnesis.android.transport.dto.CancelDownloadReply
import dev.omnesis.android.transport.dto.CodexBackendStatus
import dev.omnesis.android.transport.dto.CodexCancelLoginResult
import dev.omnesis.android.transport.dto.CodexLoginFlow
import dev.omnesis.android.transport.dto.CodexLoginFlowEnvelope
import dev.omnesis.android.transport.dto.CodexRemoveResult
import dev.omnesis.android.transport.dto.CreatePairingBody
import dev.omnesis.android.transport.dto.CreateSourceBody
import dev.omnesis.android.transport.dto.CreateTokenBody
import dev.omnesis.android.transport.dto.DeleteAllResponse
import dev.omnesis.android.transport.dto.DeviceRecord
import dev.omnesis.android.transport.dto.InstallModelBody
import dev.omnesis.android.transport.dto.InstallModelReply
import dev.omnesis.android.transport.dto.MintedToken
import dev.omnesis.android.transport.dto.ModelCredentialEntry
import dev.omnesis.android.transport.dto.ModelsOverview
import dev.omnesis.android.transport.dto.ModelBehaviorValues
import dev.omnesis.android.transport.dto.SaveModelBehaviorBody
import dev.omnesis.android.transport.dto.NetworkIdentity
import dev.omnesis.android.transport.dto.OkResponse
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.Page
import dev.omnesis.android.transport.dto.PairQrBody
import dev.omnesis.android.transport.dto.PairQrResponse
import dev.omnesis.android.transport.dto.PatchSourceBody
import dev.omnesis.android.transport.dto.PendingPairing
import dev.omnesis.android.transport.dto.PrivacyApprovalDetail
import dev.omnesis.android.transport.dto.PrivacyApprovalEnvelope
import dev.omnesis.android.transport.dto.PrivacyApprovalResolution
import dev.omnesis.android.transport.dto.PrivacyApprovalsPage
import dev.omnesis.android.transport.dto.DirectAuditEventDetail
import dev.omnesis.android.transport.dto.DirectAuditEventEnvelope
import dev.omnesis.android.transport.dto.DirectAuditSessionEventsResponse
import dev.omnesis.android.transport.dto.DirectAuditSessionsResponse
import dev.omnesis.android.transport.dto.PrivacyAuditEventPage
import dev.omnesis.android.transport.dto.PrivacyConversationDetail
import dev.omnesis.android.transport.dto.PrivacyConversationEnvelope
import dev.omnesis.android.transport.dto.PrivacyExchangeFeedPage
import dev.omnesis.android.transport.dto.PrivacyExchangePresentationPage
import dev.omnesis.android.transport.dto.PrivacyPolicyDocument
import dev.omnesis.android.transport.dto.PrivacyPolicyFamiliesPage
import dev.omnesis.android.transport.dto.PrivacyPolicyFamilySummary
import dev.omnesis.android.transport.dto.PrivacyReviewerHealth
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalDetail
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalEnvelope
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalsEnvelope
import dev.omnesis.android.transport.dto.PrivacySubscriptionDetail
import dev.omnesis.android.transport.dto.PrivacySubscriptionEnvelope
import dev.omnesis.android.transport.dto.PrivacySubscriptionFiringPage
import dev.omnesis.android.transport.dto.RecentModelsResponse
import dev.omnesis.android.transport.dto.RemoveBackendBody
import dev.omnesis.android.transport.dto.SerializedDescriptor
import dev.omnesis.android.transport.dto.SetModelCredentialsBody
import dev.omnesis.android.transport.dto.DirectFcmPushRegistrationBody
import dev.omnesis.android.transport.dto.PushPlan
import dev.omnesis.android.transport.dto.RelayPushConsentBody
import dev.omnesis.android.transport.dto.RelayPushRegistrationBody
import dev.omnesis.android.transport.dto.InternalSource
import dev.omnesis.android.transport.dto.SourceMemberBody
import dev.omnesis.android.transport.dto.SourceMembershipResponse
import dev.omnesis.android.transport.dto.SourceMetaEntry
import dev.omnesis.android.transport.dto.SourceInventory
import dev.omnesis.android.transport.dto.SourceRecord
import dev.omnesis.android.transport.dto.SourceResponse
import dev.omnesis.android.transport.dto.SourceSyncStatus
import dev.omnesis.android.transport.dto.SystemInfo
import dev.omnesis.android.transport.dto.TokenRecord
import dev.omnesis.android.transport.dto.SubscriptionApprovalDecisionBody
import dev.omnesis.android.transport.dto.VerifyBackendBody
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.delete
import dev.omnesis.android.transport.http.deleteJson
import dev.omnesis.android.transport.http.deleteSegments
import dev.omnesis.android.transport.http.getJson
import dev.omnesis.android.transport.http.getPrivateJson
import dev.omnesis.android.transport.http.getRaw
import dev.omnesis.android.transport.http.patchJson
import dev.omnesis.android.transport.http.post
import dev.omnesis.android.transport.http.postEmpty
import dev.omnesis.android.transport.http.postEmptySegments
import dev.omnesis.android.transport.http.postJson
import dev.omnesis.android.transport.http.postJsonSegments
import dev.omnesis.android.transport.http.postJsonSegmentsDiscarding
import dev.omnesis.android.transport.http.putJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl

/**
 * Admin surface (sources, descriptors, sync status, devices) plus the mutating source
 * actions. Mirrors the iOS `AdminClient` routes/shapes exactly.
 */
class AdminClient(private val http: GatewayHttp) {

    /**
     * Resolve a pending MCP request only after the owner supplies its short code. The reply
     * also names the access the client already holds, when the gateway recognises it.
     */
    suspend fun lookupAccessAuthorization(code: String): AccessAuthorizationLookupEnvelope =
        http.postJson(
            "admin/access/authorizations/lookup",
            AccessAuthorizationLookupBody(code),
        )

    /**
     * Resolve a pending request the overview already named, without its code. The reply has
     * the shape of the code lookup; a request that is unknown or no longer pending is a 404.
     */
    suspend fun lookupAccessAuthorizationById(id: String): AccessAuthorizationLookupEnvelope =
        http.getPrivateJson(listOf("admin", "access", "authorizations", id))

    /** Authority choices available to a paired owner approving an MCP request. */
    suspend fun accessOverview(): AccessOverview = http.getPrivateJson(listOf("admin", "access"))

    /** Approve or deny a pending MCP authorization request. */
    suspend fun decideAccessAuthorization(id: String, decision: AccessAuthorizationDecision) {
        http.postJsonSegmentsDiscarding(
            listOf("admin", "access", "authorizations", id, "decision"),
            decision.toWireJson(),
        )
    }

    /**
     * The gateway's own origin (scheme + host + port). Used to build a pairing
     * QR's `gatewayUrl` by swapping in a chosen network identity's host while
     * preserving the real scheme + port — mirrors the portal's
     * `swapHostForUrl(window.location.origin, …)`.
     */
    val gatewayOrigin: HttpUrl get() = http.baseUrl

    /**
     * The source-descriptor registry that drives all generic, source-agnostic rendering:
     * the union across every online collector, so it is the same whether one host or
     * several are connected. (`admin/sources/descriptors` is one collector's registry
     * and refuses to pick when more than one is online.)
     */
    suspend fun descriptors(): List<SerializedDescriptor> =
        http.getJson<Page<SerializedDescriptor>>("admin/source-descriptors").items

    suspend fun sources(): List<SourceRecord> =
        http.getJson<Page<SourceRecord>>("admin/sources").items

    /**
     * Registered sources plus the gateway-internal ones (`internalSources`
     * on the same envelope) in a single fetch. A gateway that predates the
     * field decodes to no internal sources.
     */
    suspend fun sourcesAndInternal(): Pair<List<SourceRecord>, List<InternalSource>> {
        val envelope = sourceInventory()
        return envelope.items to envelope.internalSources.filter { it.id.isNotBlank() }
    }

    suspend fun sourceInventory(): SourceInventory = http.getJson("admin/sources")

    /** Retained tombstones include completed cleanup; old gateways advertise none. */
    suspend fun sourcesToWithdraw(deviceId: String?): List<String> {
        val snapshot = sourceInventory()
        // A detached phone leaves an extant logical row with authoritative
        // membership. An absent row alone is never removal evidence.
        val detached = snapshot.items.filter {
            deviceId != null && !it.hosts(deviceId)
        }.map { it.id }
        return (snapshot.removedSourceIds + detached).distinct()
    }

    suspend fun syncStatus(): List<SourceSyncStatus> =
        http.getJson<Page<SourceSyncStatus>>("admin/sync/status").items

    /** One source's authoritative live-or-persisted status. */
    suspend fun syncStatus(sourceId: String): SourceSyncStatus =
        http.getJson("admin/sync/status/$sourceId")

    suspend fun devices(): List<DeviceRecord> =
        http.getJson<Page<DeviceRecord>>("admin/devices").items

    /**
     * `GET /admin/tokens?deviceId=` — the credentials minted for one device.
     * Mirrors the token child-rows nested under each device in the portal's
     * devices page.
     */
    suspend fun tokens(deviceId: String): List<TokenRecord> =
        http.getJson<Page<TokenRecord>>("admin/tokens", mapOf("deviceId" to deviceId)).items

    /**
     * `POST /admin/tokens` — mint a new credential for a device. The raw token
     * value is in the response and can't be re-fetched (the gateway stores only
     * its hash). The app uses it for its own narrow `push:claim` credential;
     * operator-issued credentials come from the CLI.
     */
    suspend fun createToken(deviceId: String, scopes: List<String>, name: String? = null): MintedToken =
        http.postJson<CreateTokenBody, MintedToken>(
            "admin/tokens",
            CreateTokenBody(deviceId = deviceId, scopes = scopes, name = name),
        )

    /** `DELETE /admin/tokens/:id` — revoke one credential; discards `{ok:true}`. */
    suspend fun revokeToken(id: String) = http.delete("admin/tokens/$id")

    /**
     * `DELETE /admin/devices/:id` — revoke a device and every token it holds. The
     * row and the sources it hosts stay, marked revoked, so the same device can be
     * paired again and adopt them.
     */
    suspend fun revokeDevice(id: String) = http.delete("admin/devices/$id")

    /**
     * `DELETE /admin/devices/:id?forget=true` — delete the device row for good.
     * Refused with 409 `DEVICE_STILL_HOSTS_SOURCES` while any source still points
     * at the device. The envelope's message names those sources by id and points
     * at a CLI remedy, so a phone surface renders the code rather than the prose.
     */
    suspend fun forgetDevice(id: String) = http.delete("admin/devices/$id", mapOf("forget" to "true"))

    /**
     * `POST /admin/devices/pair` — mint a one-time pairing code (~10-min TTL)
     * carrying the kind's canonical scopes. The new device exchanges it for a
     * real token via the public `POST /devices/pair`. Returns the code + its expiry.
     */
    suspend fun createPairing(kind: String, repairDeviceId: String? = null): PendingPairing =
        http.postJson<CreatePairingBody, PendingPairing>(
            "admin/devices/pair",
            CreatePairingBody(kind = kind, repairDeviceId = repairDeviceId),
        )

    /**
     * `POST /admin/devices/pair-qr` — encode the pairing payload server-side so
     * every client shares the versioned TLS trust contract. Automatic policy
     * uses system trust for configured public origins and leaf pinning elsewhere.
     */
    suspend fun buildPairQr(pairingCode: String, gatewayUrl: String): String {
        suspend fun request(trustMode: String?): String =
            http.postJson<PairQrBody, PairQrResponse>(
                "admin/devices/pair-qr",
                PairQrBody(pairingCode = pairingCode, gatewayUrl = gatewayUrl, trustMode = trustMode),
            ).qrPayload
        return try {
            request("auto")
        } catch (e: GatewayException.ServerError) {
            if (e.status != 400 || e.code != "VALIDATION_ERROR") throw e
            // Older gateways predate the auto policy. Omission retains their
            // V2/V3 leaf-pinned compatibility path.
            request(null)
        }
    }

    /**
     * `GET /admin/network-identities` — the addresses this gateway is reachable
     * at (LAN, mDNS, Tailscale). The pairing flow lets the user pick which one
     * bakes into the QR's `gatewayUrl`.
     */
    suspend fun networkIdentities(): List<NetworkIdentity> =
        http.getJson<Page<NetworkIdentity>>("admin/network-identities").items

    /** Per-source display metadata (icons/labels/colors), keyed by sourceId and type. */
    suspend fun sourceMeta(): Map<String, SourceMetaEntry> =
        http.getJson("portal/source-meta.json")

    /**
     * `GET /admin/models` — the slice of the overview the mobile model-management
     * surface renders: the per-role display map, capability cards, resolved
     * per-role assignments (for the enabled / needs-attention / off state), and
     * the catalog + installed manifest + backend status (so the model picker can
     * offer the models the gateway already knows about).
     */
    suspend fun modelOverview(): ModelsOverview = http.getJson("admin/models")

    /** Save the catalog-backed inference controls for this capability's active model. */
    suspend fun saveModelBehavior(
        role: String,
        assignment: String,
        values: ModelBehaviorValues,
        expectedValues: ModelBehaviorValues? = null,
    ) {
        require(ROLE_SLUG.matches(role)) { "invalid capability role" }
        http.patchJson<SaveModelBehaviorBody, OkResponse>(
            "admin/models/behavior/$role",
            SaveModelBehaviorBody(assignment, values, expectedValues),
        )
    }

    /** Fetch one provider logo only through the paired gateway's cached SVG route. */
    suspend fun providerLogo(providerId: String): String {
        require(PROVIDER_SLUG.matches(providerId)) { "invalid provider id" }
        val url = http.urlForSegments(listOf("model-logos", "$providerId.svg"))
        return http.execute(http.newRequest(url).header("Accept", "image/svg+xml").get().build())
    }

    /**
     * `POST /admin/models/activate` — assign a catalog model (an installed local
     * GGUF, or an Anthropic API model) to a capability. `role` is the CATALOG
     * role ("embed"/"agent"/"transcribe"), matching the portal.
     */
    suspend fun activateModel(catalogId: String, role: String, capability: String? = null) {
        http.postJson<ActivateModelBody, OkResponse>(
            "admin/models/activate",
            ActivateModelBody(id = catalogId, role = role, capability = capability),
        )
    }

    /**
     * `GET /admin/models/recent/:capability` — the "Recently used" picker
     * entries for the capability being configured. Older gateways answer 404,
     * which callers treat as "no recent models" so the section hides.
     */
    suspend fun recentModels(capability: String): RecentModelsResponse =
        http.getJson("admin/models/recent/${pathEncode(capability)}")

    // --- Answer privacy boundary ---

    /**
     * `GET /admin/privacy/policies` — every policy family the gateway holds,
     * archived ones included, each with the grants whose answer release names
     * it. The default family is not marked here; `GET /admin/access` names it.
     */
    suspend fun privacyPolicyFamilies(): List<PrivacyPolicyFamilySummary> =
        http.getPrivateJson<PrivacyPolicyFamiliesPage>(listOf("admin", "privacy", "policies")).policies

    /**
     * `GET /admin/privacy/policies/{familyId}` — the document one named policy
     * family holds. A grant's answer release names a family, so showing the
     * policy an answer is judged under means asking for that family by id.
     */
    suspend fun privacyPolicyFamily(familyId: String): PrivacyPolicyDocument =
        http.getPrivateJson(listOf("admin", "privacy", "policies", familyId))

    /**
     * `GET /admin/privacy/approvals` — one page of the answer-approval queue,
     * newest first. The page carries an exact `totalCount` for the requested
     * status with expired rows excluded, so a caller that only needs the count
     * asks for a single row rather than walking the cursor. The gateway accepts
     * up to 500 rows per page.
     */
    suspend fun privacyApprovals(
        status: String = "pending",
        limit: Int = 50,
        cursor: String? = null,
    ): PrivacyApprovalsPage = http.getPrivateJson(
        listOf("admin", "privacy", "approvals"),
        buildMap {
            put("status", status)
            put("limit", limit.coerceIn(1, PRIVACY_APPROVALS_PAGE_MAX).toString())
            cursor?.let { put("cursor", it) }
        },
    )

    suspend fun privacyApproval(id: String): PrivacyApprovalDetail =
        http.getPrivateJson<PrivacyApprovalEnvelope>(
            listOf("admin", "privacy", "approvals", id),
        ).approval

    suspend fun approvePrivacyApproval(id: String): PrivacyApprovalResolution =
        http.postEmptySegments(listOf("admin", "privacy", "approvals", id, "approve"))

    suspend fun denyPrivacyApproval(id: String): PrivacyApprovalResolution =
        http.postEmptySegments(listOf("admin", "privacy", "approvals", id, "deny"))

    /** The Privacy landing feed: every exchange, newest first, across conversations. */
    suspend fun privacyExchangeFeed(
        limit: Int = 50,
        cursor: String? = null,
    ): PrivacyExchangeFeedPage = http.getPrivateJson(
        listOf("admin", "privacy", "exchanges"),
        buildMap {
            put("limit", limit.coerceIn(1, 100).toString())
            cursor?.let { put("cursor", it) }
        },
    )

    suspend fun privacyConversation(id: String): PrivacyConversationDetail =
        http.getPrivateJson<PrivacyConversationEnvelope>(
            listOf("admin", "privacy", "conversations", id),
        ).conversation

    suspend fun privacyConversationExchanges(
        conversationId: String,
        limit: Int = 50,
        cursor: String? = null,
        includeAgentTracesTaskId: String? = null,
    ): PrivacyExchangePresentationPage = http.getPrivateJson(
        listOf("admin", "privacy", "conversations", conversationId, "exchanges"),
        buildMap {
            put("limit", limit.coerceIn(1, 100).toString())
            cursor?.let { put("cursor", it) }
            includeAgentTracesTaskId?.takeIf { it.isNotBlank() }?.let {
                put("includeAgentTracesTaskId", it)
            }
        },
    )

    suspend fun privacyReviewerHealth(): PrivacyReviewerHealth =
        http.getPrivateJson(listOf("admin", "privacy", "reviewer-health"))

    suspend fun privacyConversationEvents(
        conversationId: String,
        limit: Int = 50,
        cursor: String? = null,
    ): PrivacyAuditEventPage = http.getPrivateJson(
        listOf("admin", "privacy", "conversations", conversationId, "events"),
        buildMap {
            put("limit", limit.coerceIn(1, 100).toString())
            cursor?.let { put("cursor", it) }
        },
    )

    suspend fun deletePrivacyConversation(id: String) {
        http.deleteSegments(listOf("admin", "privacy", "conversations", id))
    }

    // --- Direct audit transcript boundary ---

    /**
     * `GET /admin/privacy/direct/sessions` — transcript sessions, newest
     * first. Same admin posture as the Answer reads: the operator sees every
     * principal. A gateway from before this boundary answers 404 — callers
     * map that to an unsupported state, never to an empty list.
     */
    suspend fun directAuditSessions(limit: Int = 50) =
        http.getPrivateJson<DirectAuditSessionsResponse>(
            listOf("admin", "privacy", "direct", "sessions"),
            mapOf("limit" to limit.coerceIn(1, 100).toString()),
        ).sessions

    /** `GET /admin/privacy/direct/sessions/:id/events` — one session's calls, oldest first. */
    suspend fun directAuditSessionEvents(sessionId: String, limit: Int = 100) =
        http.getPrivateJson<DirectAuditSessionEventsResponse>(
            listOf("admin", "privacy", "direct", "sessions", sessionId, "events"),
            mapOf("limit" to limit.coerceIn(1, 100).toString()),
        ).events

    /** `GET /admin/privacy/direct/events/:eventId` — one call with its bounded payload. */
    suspend fun directAuditEvent(eventId: String): DirectAuditEventDetail =
        http.getPrivateJson<DirectAuditEventEnvelope>(
            listOf("admin", "privacy", "direct", "events", eventId),
        ).event

    /** `DELETE /admin/privacy/direct/sessions/:id` — delete a session with its transcript. */
    suspend fun deleteDirectAuditSession(sessionId: String) {
        http.deleteSegments(listOf("admin", "privacy", "direct", "sessions", sessionId))
    }

    suspend fun privacySubscriptionApprovals(
        status: String = "pending",
        limit: Int = 50,
        cursor: String? = null,
    ): PrivacySubscriptionApprovalsEnvelope =
        http.getPrivateJson(
            listOf("admin", "privacy", "subscription-approvals"),
            buildMap {
                put("status", status)
                put("limit", limit.coerceIn(1, 50).toString())
                cursor?.let { put("cursor", it) }
            },
        )

    suspend fun privacySubscriptionApproval(id: String): PrivacySubscriptionApprovalDetail =
        http.getPrivateJson<PrivacySubscriptionApprovalEnvelope>(
            listOf("admin", "privacy", "subscription-approvals", id),
        ).approval.requireTrustedSubscriptionApproval()

    suspend fun approvePrivacySubscription(id: String) {
        http.postJsonSegments<SubscriptionApprovalDecisionBody, JsonElement>(
            listOf("admin", "privacy", "subscription-approvals", id, "resolve"),
            SubscriptionApprovalDecisionBody("approve"),
        )
    }

    suspend fun denyPrivacySubscription(id: String) {
        http.postJsonSegments<SubscriptionApprovalDecisionBody, JsonElement>(
            listOf("admin", "privacy", "subscription-approvals", id, "resolve"),
            SubscriptionApprovalDecisionBody("deny"),
        )
    }

    suspend fun privacySubscription(id: String): PrivacySubscriptionDetail =
        http.getPrivateJson<PrivacySubscriptionEnvelope>(
            listOf("admin", "privacy", "subscriptions", id),
        ).subscription

    suspend fun revokePrivacySubscription(id: String): PrivacySubscriptionDetail =
        http.postEmptySegments<PrivacySubscriptionEnvelope>(
            listOf("admin", "privacy", "subscriptions", id, "revoke"),
        ).subscription

    suspend fun privacySubscriptionFirings(
        subscriptionId: String,
        limit: Int = 50,
        cursor: String? = null,
    ): PrivacySubscriptionFiringPage = http.getPrivateJson(
        listOf("admin", "privacy", "subscriptions", subscriptionId, "firings"),
        buildMap {
            put("limit", limit.coerceIn(1, 100).toString())
            cursor?.let { put("cursor", it) }
        },
    )

    suspend fun pushPlan(deviceId: String, appId: String): PushPlan =
        http.getJson(
            "admin/devices/$deviceId/push-plan",
            mapOf("platform" to "android", "appId" to appId),
        )

    suspend fun grantRelayPushConsent(deviceId: String, appId: String) {
        http.postJson<RelayPushConsentBody, OkResponse>(
            "admin/devices/$deviceId/push-relay-consent",
            RelayPushConsentBody(platform = "android", appId = appId),
        )
    }

    suspend fun setDirectFcmPushRegistration(
        deviceId: String,
        registrationToken: String,
        projectId: String,
    ) {
        http.postJson<DirectFcmPushRegistrationBody, OkResponse>(
            "admin/devices/$deviceId/push-registration",
            DirectFcmPushRegistrationBody(
                transport = "direct-fcm",
                registrationToken = registrationToken,
                projectId = projectId,
            ),
        )
    }

    suspend fun setRelayPushRegistration(
        deviceId: String,
        relayUrl: String,
        credential: String,
    ) {
        http.postJson<RelayPushRegistrationBody, OkResponse>(
            "admin/devices/$deviceId/push-registration",
            RelayPushRegistrationBody(
                transport = "relay",
                relayUrl = relayUrl,
                credential = credential,
            ),
        )
    }

    /**
     * `PATCH /admin/config` — assign or clear a capability via the generic config
     * patch the portal uses (`assignCapability`). `assignment` is the wire value
     * ("&lt;backendKey&gt;/&lt;model&gt;" for an HTTP-backend model, or null to
     * disable); catalog models go through [activateModel] instead.
     */
    suspend fun assignCapability(role: String, assignment: String?) {
        val value: JsonElement = if (assignment == null) JsonNull else JsonPrimitive(assignment)
        http.patchJson<AssignCapabilityBody, OkResponse>(
            "admin/config",
            AssignCapabilityBody(AssignCapabilityBody.AssignInference(mapOf(role to value))),
        )
    }

    // --- Inference backends (mirror iOS AdminClient) ---

    /**
     * `PATCH /admin/config` — add (or replace) a named HTTP inference backend,
     * exactly like the portal's `addHttpBackend`. `apiKey` is write-only: it's
     * sent here but never read back or rendered (the gateway only ever surfaces
     * a `hasApiKey` bool). The caller validates `key` against
     * `ModelManagement.validateBackendName` first; the gateway re-validates.
     */
    suspend fun addHttpBackend(
        key: String,
        url: String,
        apiKey: String? = null,
        apiPathPrefix: String? = null,
    ) {
        http.patchJson<AddBackendBody, OkResponse>(
            "admin/config",
            AddBackendBody(
                AddBackendBody.AddBackendInference(
                    mapOf(
                        key to AddBackendBody.HttpBackendConfig(
                            type = "http",
                            url = url,
                            apiKey = apiKey?.ifBlank { null },
                            apiPathPrefix = apiPathPrefix?.ifBlank { null },
                        ),
                    ),
                ),
            ),
        )
    }

    /**
     * `PATCH /admin/config` — remove an HTTP backend by setting its key to an
     * explicit `null` (mirrors the portal's `removeHttpBackend`). Like the
     * capability clear, the null must be serialized explicitly (a missing key
     * is a no-op patch).
     */
    suspend fun removeHttpBackend(key: String) {
        http.patchJson<RemoveBackendBody, OkResponse>(
            "admin/config",
            RemoveBackendBody(RemoveBackendBody.RemoveBackendInference(mapOf(key to JsonNull))),
        )
    }

    /**
     * `POST /admin/inference/backends/:key/probe` — re-probe a configured HTTP
     * backend. Reachability + the served-model list are refreshed server-side
     * (the cached status the next overview reads is updated in the same pass).
     */
    suspend fun probeBackend(key: String): BackendProbeResult =
        http.postEmpty("admin/inference/backends/$key/probe")

    /**
     * `POST /admin/inference/backends/:key/verify` — behaviorally confirm that
     * one of a backend's models can actually serve `role` (one of
     * embedder/agent/privacy-reviewer). Unlike the reachability probe, this
     * issues the role's minimal capability call (an embedding, a chat
     * completion, …) and reports the authoritative verdict. On-demand only —
     * never auto-issued per model on page load. `force` bypasses the gateway's
     * per-(backend, model, role) verdict cache. Returns the [CapabilityVerdict].
     */
    suspend fun verifyModel(
        key: String,
        model: String,
        role: String,
        force: Boolean = false,
    ): CapabilityVerdict =
        http.postJson<VerifyBackendBody, CapabilityVerdict>(
            "admin/inference/backends/$key/verify",
            VerifyBackendBody(model = model, role = role, force = force),
        )

    /** `POST /admin/inference/codex/refresh` — refresh Codex login/model status. */
    suspend fun refreshCodexBackend(): CodexBackendStatus =
        http.postEmpty("admin/inference/codex/refresh")

    /** `POST /admin/inference/codex/login` — start Codex's device-login flow. */
    suspend fun startCodexLogin(): CodexLoginFlow =
        http.postEmpty("admin/inference/codex/login")

    /** `GET /admin/inference/codex/login` — read the active Codex login flow. */
    suspend fun getCodexLogin(): CodexLoginFlow? =
        http.getJson<CodexLoginFlowEnvelope>("admin/inference/codex/login").flow

    /** `DELETE /admin/inference/codex/login` — cancel any active Codex login flow. */
    suspend fun cancelCodexLogin(): CodexCancelLoginResult =
        http.deleteJson("admin/inference/codex/login")

    /** `DELETE /admin/inference/codex` — log out Codex and clear Codex assignments. */
    suspend fun removeCodexBackend(): CodexRemoveResult =
        http.deleteJson("admin/inference/codex")

    // --- Model-provider credentials (mirror iOS AdminClient) ---

    /**
     * `GET /admin/model-credentials` — the gateway-host model-provider credential
     * registry (Anthropic API key today, more providers later). One row per
     * provider, each carrying its field spec + a `configured` bool. The secret
     * values themselves are never returned (the gateway only ever surfaces
     * `configured`), so nothing sensitive is decoded. The route returns a
     * `Page<ModelCredentialEntry>` with a sibling `hostname`; only the entries
     * are needed.
     */
    suspend fun modelCredentials(): List<ModelCredentialEntry> =
        http.getJson<Page<ModelCredentialEntry>>("admin/model-credentials").items

    /**
     * `POST /admin/model-credentials/:fileKey` — write a provider's credentials.
     * `fields` maps each spec field name to its value (e.g.
     * `{"apiKey": "sk-ant-…"}`). The values are write-only: sent here, never read
     * back or rendered (the registry only surfaces a `configured` bool), so
     * they're never logged. The gateway validates required fields + the per-field
     * pattern and re-evaluates model availability on success.
     */
    suspend fun setModelCredentials(fileKey: String, fields: Map<String, String>) {
        http.postJson<SetModelCredentialsBody, OkResponse>(
            "admin/model-credentials/$fileKey",
            SetModelCredentialsBody(fields),
        )
    }

    /**
     * `DELETE /admin/model-credentials/:fileKey` — clear a provider's credentials
     * (removes the credentials file). Idempotent.
     */
    suspend fun clearModelCredentials(fileKey: String) = http.delete("admin/model-credentials/$fileKey")

    // --- Local model lifecycle (mirror iOS AdminClient) ---

    /**
     * `GET /admin/system-info` — host capacity snapshot used for the local-model
     * "fit" badge (free RAM + free model-dir disk).
     */
    suspend fun systemInfo(): SystemInfo = http.getJson("admin/system-info")

    /**
     * `POST /admin/models/install` — start a GATEWAY-side GGUF download for the
     * catalog `id`. The file is downloaded on the gateway host (not the phone);
     * progress then shows up in the overview's `activeDownloads`, which the
     * local-model list polls while a download is in flight. Returns the
     * server-assigned download id.
     */
    suspend fun installModel(id: String): String =
        http.postJson<InstallModelBody, InstallModelReply>("admin/models/install", InstallModelBody(id)).downloadId

    /**
     * `POST /admin/models/cancel-download` — cancel the in-flight download for the
     * catalog `id` (the route keys by model id, not download id). Returns whether
     * a download was actually cancelled.
     */
    suspend fun cancelModelDownload(id: String): Boolean =
        http.postJson<CancelDownloadBody, CancelDownloadReply>("admin/models/cancel-download", CancelDownloadBody(id)).cancelled

    /**
     * `DELETE /admin/models/:id` — uninstall a downloaded local GGUF (the file is
     * deleted from the gateway host's models directory). The gateway rejects
     * removing a model currently assigned to a capability.
     */
    suspend fun uninstallModel(id: String) = http.delete("admin/models/$id")

    // --- Source actions (mirror iOS AdminClient) ---

    /**
     * `POST /admin/sources` — register a source row bound to a device. Idempotent: the
     * gateway re-uses an existing row for the same type+account. This is how a phone
     * claims a source it hosts itself (Health Connect here; Apple Health on iOS).
     */
    suspend fun createSource(
        type: String,
        accountId: String,
        deviceId: String,
        enabled: Boolean = true,
    ): SourceRecord = http.postJson<CreateSourceBody, SourceResponse>(
        "admin/sources",
        CreateSourceBody(type = type, accountId = accountId, deviceId = deviceId, enabled = enabled),
    ).source

    /** `POST /admin/sources/:id/sync` — trigger a manual sync on the device hosting the source. */
    suspend fun syncSource(sourceId: String) = http.post("admin/sources/$sourceId/sync")

    /** `PATCH /admin/sources/:id` — toggle enabled (pause/resume) and/or patch config. */
    suspend fun patchSource(
        sourceId: String,
        enabled: Boolean? = null,
        config: Map<String, JsonElement>? = null,
        deviceId: String? = null,
        multiDeviceMode: SourceMultiDeviceMode? = null,
    ): SourceRecord = http.patchJson<PatchSourceBody, SourceResponse>(
        "admin/sources/$sourceId",
        PatchSourceBody(
            enabled = enabled,
            config = config,
            deviceId = deviceId,
            multiDeviceMode = multiDeviceMode?.wireValue,
        ),
    ).source.also { source ->
        // Older gateways can ignore an unknown PATCH field while still returning HTTP 200.
        if (multiDeviceMode != null && source.multiDeviceMode != multiDeviceMode.wireValue) {
            throw SourceModeTransitionNotConfirmed(multiDeviceMode)
        }
    }

    /** Replace the complete, expiring OS-permission snapshot for one phone-hosted source. */
    suspend fun putPermissionHealth(sourceId: String, snapshot: PermissionHealthSnapshot) {
        http.putJson<PermissionHealthSnapshot, OkResponse>(
            "admin/sources/$sourceId/permission-health",
            snapshot,
        )
    }

    /** Report whether this phone's OS settings can turn a carrier wake into a visible alert. */
    suspend fun reportPushHealth(deviceId: String, status: String) {
        http.postJson<JsonObject, OkResponse>(
            "admin/devices/$deviceId/push-health",
            buildJsonObject { put("status", status) },
        )
    }

    /** `DELETE /admin/sources/:id` — remove a source (gateway routes to the hosting collector). */
    suspend fun removeSource(sourceId: String) = http.delete("admin/sources/$sourceId")

    /**
     * `POST /admin/sources/:id/members` — join this device to a source another
     * device already hosts. Idempotent for a device that is already a member.
     */
    suspend fun joinSourceMember(sourceId: String, deviceId: String): SourceMembershipResponse =
        http.postJson<SourceMemberBody, SourceMembershipResponse>(
            "admin/sources/$sourceId/members",
            SourceMemberBody(deviceId = deviceId),
        )

    /**
     * `DELETE /admin/sources/:id/members/:deviceId` — detach one device from a
     * source; the other members keep hosting it. 409 `LAST_MEMBER` when the device
     * is the only host (pause the source instead), 409 `DEVICE_NOT_MEMBER` when it
     * never hosted it.
     */
    suspend fun detachSourceMember(sourceId: String, deviceId: String): SourceMembershipResponse =
        http.deleteJson("admin/sources/$sourceId/members/$deviceId")

    /**
     * `GET /admin/sources/:id/debug` — the collector-side debug snapshot (cursor/stats). The
     * gateway proxies this to the owning device, so the shape is source-defined; we return it
     * as pretty-printed JSON for the debug sheet rather than decoding per-source.
     */
    suspend fun sourceDebug(sourceId: String): String {
        val raw = http.getRaw("admin/sources/$sourceId/debug")
        return runCatching {
            DEBUG_PRETTY.encodeToString(JsonElement.serializer(), OmnesisJson.parseToJsonElement(raw))
        }.getOrDefault(raw)
    }

    /**
     * `POST /documents/delete-all/source/:id` — delete all ingested documents (and analytics
     * rows) for a source. Phase one of the Resync flow, followed by [syncSource].
     */
    suspend fun deleteAllForSource(sourceId: String): DeleteAllResponse =
        http.postEmpty("documents/delete-all/source/$sourceId")

    private companion object {
        val ROLE_SLUG = Regex("[a-z][a-z0-9-]*")
        val PROVIDER_SLUG = Regex("[a-z0-9][a-z0-9-]*")
        /** Pretty-printer for the free-form debug payload (display only, never re-sent). */
        val DEBUG_PRETTY = Json(OmnesisJson) { prettyPrint = true }

        /**
         * Percent-encode one URL path segment (parity with the iOS client's
         * `percentEncode`). `URLEncoder` targets query strings (`+` for
         * space), so spaces come back as `%20`. Capability slugs are
         * `[a-z-]` in practice — this is belt-and-braces.
         */
        fun pathEncode(segment: String): String =
            java.net.URLEncoder.encode(segment, Charsets.UTF_8).replace("+", "%20")
    }
}

private fun PrivacySubscriptionApprovalDetail.requireTrustedSubscriptionApproval():
    PrivacySubscriptionApprovalDetail = apply {
        require(id.isNotBlank() && subscriptionId.isNotBlank() && workflowHandle.isNotBlank()) {
            "Subscription approval response is incomplete"
        }
        require(status in setOf("pending", "approved", "denied", "expired")) {
            "Subscription approval status is invalid"
        }
        require(revision > 0 && revisionId.isNotBlank() && createdAt > 0 && expiresAt > 0) {
            "Subscription approval revision metadata is incomplete"
        }
        require(integration.displayName.isNotBlank() && integration.source == "token") {
            "Subscription approval integration identity is incomplete"
        }
        require(
            interpretedCondition.summary.isNotBlank() &&
                interpretedCondition.pushDetail == "existence",
        ) {
            "Subscription approval interpretation is incomplete"
        }
        require(
            interpretation == interpretedCondition &&
                workflowId.isNotBlank() &&
                integrationDeviceId.isNotBlank() &&
                integrationDevice.id == integrationDeviceId &&
                integrationDevice.name.isNotBlank() &&
                integrationDevice.kind == "agent" &&
                workflow.id == workflowId &&
                workflow.name.isNotBlank() &&
                workflow.purpose.isNotBlank(),
        ) {
            "Subscription approval workflow identity is incomplete"
        }
        require(condition.kind == "natural-language" && condition.description.isNotBlank()) {
            "Subscription approval condition is incomplete"
        }
        require(reaction.kind == "agent-workflow" && reaction.instruction.isNotBlank()) {
            "Subscription approval reaction is incomplete"
        }
        require(
            categories.isNotEmpty() &&
                categories.all { it.isNotBlank() } &&
                policyRevision.isNotBlank(),
        ) {
            "Subscription approval privacy metadata is incomplete"
        }
    }

/** The largest approval page the gateway serves. */
const val PRIVACY_APPROVALS_PAGE_MAX = 500
