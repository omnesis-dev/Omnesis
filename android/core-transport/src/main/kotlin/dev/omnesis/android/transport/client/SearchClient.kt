// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.client

import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.Annotation
import dev.omnesis.android.transport.dto.AnnotationDependent
import dev.omnesis.android.transport.dto.AnnotationsResponse
import dev.omnesis.android.transport.dto.AttachmentsResponse
import dev.omnesis.android.transport.dto.DevAnnotationBody
import dev.omnesis.android.transport.dto.DocumentAttachment
import dev.omnesis.android.transport.dto.DocumentDetail
import dev.omnesis.android.transport.dto.DocumentEventTrail
import dev.omnesis.android.transport.dto.DocumentNearDupes
import dev.omnesis.android.transport.dto.DocumentRefs
import dev.omnesis.android.transport.dto.MergeCandidate
import dev.omnesis.android.transport.dto.MergeCandidatesResponse
import dev.omnesis.android.transport.dto.MergeClusterBody
import dev.omnesis.android.transport.dto.MergeClusterResult
import dev.omnesis.android.transport.dto.MergeRule
import dev.omnesis.android.transport.dto.MergeRuleGroup
import dev.omnesis.android.transport.dto.MergeRulesResponse
import dev.omnesis.android.transport.dto.Page
import dev.omnesis.android.transport.dto.PeopleResponse
import dev.omnesis.android.transport.dto.PeopleStats
import dev.omnesis.android.transport.dto.PersonDetail
import dev.omnesis.android.transport.dto.PersonDocumentEntry
import dev.omnesis.android.transport.dto.PersonMention
import dev.omnesis.android.transport.dto.PersonSummary
import dev.omnesis.android.transport.dto.RecentItemsResponse
import dev.omnesis.android.transport.dto.SearchBody
import dev.omnesis.android.transport.dto.SearchResponse
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.http.delete
import dev.omnesis.android.transport.http.getJson
import dev.omnesis.android.transport.http.post
import dev.omnesis.android.transport.http.postJson
import dev.omnesis.android.transport.http.postJsonDiscarding
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/** Search + document read surface. Mirrors the iOS `SearchClient`. */
class SearchClient(private val http: GatewayHttp) {

    suspend fun search(
        text: String,
        limit: Int? = null,
        verbose: Boolean = false,
    ): SearchResponse = http.postJson(
        "search",
        SearchBody(text = text, limit = limit, verbose = verbose),
    )

    suspend fun document(id: String): DocumentDetail = http.getJson("documents/$id")

    suspend fun people(id: String): List<PersonMention> =
        http.getJson<PeopleResponse>("documents/$id/people").people

    suspend fun refs(id: String, limit: Int = 25): DocumentRefs = try {
        coroutineScope {
            val outbound = async { outboundRefs(id, limit) }
            val inbound = async { inboundRefs(id, limit) }
            val outboundPage = outbound.await()
            val inboundPage = inbound.await()
            DocumentRefs(
                outbound = outboundPage.items,
                inbound = inboundPage.items,
                outboundPageInfo = outboundPage.pageInfo,
                inboundPageInfo = inboundPage.pageInfo,
            )
        }
    } catch (_: GatewayException.NotFound) {
        // Compatibility with gateways predating the direction-specific pages.
        http.getJson("documents/$id/refs")
    }

    suspend fun outboundRefs(
        id: String,
        limit: Int = 25,
        cursor: String? = null,
    ): Page<dev.omnesis.android.transport.dto.OutboundRef> =
        http.getJson(
            "documents/$id/refs/outbound",
            buildMap {
                put("limit", limit.toString())
                cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
            },
        )

    suspend fun inboundRefs(
        id: String,
        limit: Int = 25,
        cursor: String? = null,
    ): Page<dev.omnesis.android.transport.dto.InboundRef> =
        http.getJson(
            "documents/$id/refs/inbound",
            buildMap {
                put("limit", limit.toString())
                cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
            },
        )

    suspend fun attachments(id: String): List<DocumentAttachment> =
        http.getJson<AttachmentsResponse>("documents/$id/attachments").attachments

    /** `GET /documents/:id/near-dupes` — near-duplicate edges for the inspector "Similar" section. */
    suspend fun nearDupes(
        id: String,
        limit: Int = 20,
        cursor: String? = null,
    ): DocumentNearDupes = http.getJson(
        "documents/$id/near-dupes",
        buildMap {
            put("limit", limit.toString())
            cursor?.takeIf { it.isNotBlank() }?.let { put("after", it) }
        },
    )

    /** `GET /documents/:id/trail` — the event trail seeded from this document, for the Timeline tab. */
    suspend fun documentTrail(id: String): DocumentEventTrail = http.getJson("documents/$id/trail")

    /**
     * `GET /documents/:id/annotations` — the agent's durable LLM-derived observations grounded
     * on this document ("Enriched by Omnesis"). Experimental-gated server-side: 404s when
     * experimental mode is off, so callers gate the request and swallow the miss.
     */
    suspend fun documentAnnotations(
        id: String,
        limit: Int = 20,
        cursor: String? = null,
    ): AnnotationsResponse =
        http.getJson(
            "documents/$id/annotations",
            buildMap {
                put("limit", limit.toString())
                put("includeDependents", "0")
                cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
            },
        )

    suspend fun annotationDependents(
        store: String,
        annotationId: String,
        limit: Int = 25,
        cursor: String? = null,
    ): Page<AnnotationDependent> =
        http.getJson(
            "admin/cognition/annotations/$store/$annotationId/dependents",
            buildMap {
                put("limit", limit.toString())
                cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
            },
        )

    /**
     * `DELETE /documents/:id` — remove a single document from the corpus for
     * privacy. The gateway also deletes its extracted-attachment
     * children. By default it writes a durable tombstone so a re-sync /
     * re-capture can't bring the page back; with [keepCopy] only this copy goes
     * and the source may bring it back. Requires a write scope for the
     * document's source (a read-only token gets a 403).
     */
    suspend fun deleteDocument(id: String, keepCopy: Boolean = false) =
        http.delete("documents/$id", if (keepCopy) mapOf("tombstone" to "0") else emptyMap())

    suspend fun recent(
        sourceId: String,
        limit: Int = 25,
        cursor: String? = null,
    ): RecentItemsResponse =
        http.getJson(
            "sources/$sourceId/recent",
            buildMap {
                put("limit", limit.toString())
                cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
            },
        )

    suspend fun peoplePage(
        query: String? = null,
        limit: Int = 50,
        cursor: String? = null,
    ): Page<PersonSummary> {
        val params = buildMap {
            query?.takeIf { it.isNotBlank() }?.let { put("q", it) }
            put("limit", limit.toString())
            cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
        }
        return http.getJson("people", params)
    }

    suspend fun people(query: String? = null, limit: Int = 50): List<PersonSummary> =
        peoplePage(query, limit).items

    /**
     * `GET /people/stats` — summary counts for the People list view, including
     * the pending merge-candidate and active merge-rule totals that label the
     * two merge-shortcut buttons.
     */
    suspend fun peopleStats(): PeopleStats = http.getJson("people/stats")

    suspend fun person(id: String): PersonDetail = http.getJson("people/$id")

    suspend fun personDocuments(id: String, limit: Int = 30, offset: Int = 0): List<PersonDocumentEntry> =
        http.getJson<Page<PersonDocumentEntry>>(
            "people/$id/documents",
            mapOf("limit" to limit.toString(), "cursor" to offset.toString()),
        ).items

    /**
     * `GET /people/:id/annotations` — the agent's durable LLM-derived observations about this
     * person (the self person's are the user's own "Profile"). Experimental-gated server-side:
     * 404s when experimental mode is off, so callers gate the request and swallow the miss.
     */
    suspend fun personAnnotations(
        id: String,
        limit: Int = 20,
        cursor: String? = null,
    ): AnnotationsResponse =
        http.getJson(
            "people/$id/annotations",
            buildMap {
                put("limit", limit.toString())
                put("includeDependents", "0")
                cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
            },
        )

    /**
     * `GET /people/merge-rules` — operator-visible merge rules, each a
     * directional "loser → winner" identity merge. `resolve`+`details`+
     * `preMerge` request the pre-merge identities each side originally
     * carried, with their aliases and source-icon strips (mirrors the
     * portal's merge-rules page). Read-only on mobile.
     */
    suspend fun mergeRules(): List<MergeRule> =
        http.getJson<MergeRulesResponse>(
            "people/merge-rules",
            mapOf("active" to "1", "resolve" to "1", "details" to "1", "preMerge" to "1"),
        ).rules

    /** Whole-card page; the gateway never splits one surviving identity. */
    suspend fun mergeRuleGroups(
        limit: Int = 25,
        cursor: String? = null,
        query: String? = null,
        kind: String? = null,
    ): Page<MergeRuleGroup> =
        http.getJson(
            "people/merge-rule-groups",
            buildMap {
                put("limit", limit.toString())
                cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
                query?.takeIf { it.isNotBlank() }?.let { put("q", it) }
                kind?.takeIf { it.isNotBlank() }?.let { put("kind", it) }
            },
        )

    /**
     * `GET /people/merge-candidates` — probable-duplicate identities the
     * fuzzy detector surfaced for review. The gateway returns them already
     * cluster-contiguous, each carrying the resolved people on both sides, so
     * the cluster card is built client-side. `status` defaults to `pending`;
     * the high `limit` keeps a cluster from being truncated mid-card.
     */
    suspend fun mergeCandidates(
        status: String = "pending",
        clusterLimit: Int = 25,
        cursor: String? = null,
        query: String? = null,
    ): MergeCandidatesResponse =
        http.getJson(
            "people/merge-candidates",
            buildMap {
                put("status", status)
                put("clusterLimit", clusterLimit.toString())
                cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
                query?.takeIf { it.isNotBlank() }?.let { put("q", it) }
            },
        )

    /**
     * `POST /people/merge-candidates/merge-cluster` — unify N people into one
     * identity (the portal's primary merge action; the gateway creates the
     * N-1 user merge rules and re-picks the canonical). Needs `admin` scope.
     */
    suspend fun mergeCluster(personIds: List<String>, reason: String? = null): MergeClusterResult =
        http.postJson("people/merge-candidates/merge-cluster", MergeClusterBody(personIds, reason))

    /**
     * `POST /people/merge-candidates/:id/deny` — dismiss a candidate so the
     * detector won't re-propose it. Idempotent. Needs `admin` scope. The
     * `{ candidate }` response is discarded.
     */
    suspend fun denyMergeCandidate(id: String) = http.post("people/merge-candidates/$id/deny")

    /**
     * File a developer annotation (`OMNESIS_DEV_MODE`) — the operator →
     * engineer data-quality feedback channel. The `/dev/annotations` route
     * 404s when the gateway isn't in developer mode; the shake-to-annotate
     * affordance is only offered when `GET /status` reports `developer`, so
     * this is reached only in developer mode. The context snapshot carries
     * the filing platform and app version/build so an engineer triaging with
     * `omnesis dev-annotations` can tell which binary produced the note.
     * Mirrors the iOS `SearchClient.createDevAnnotation`.
     */
    suspend fun createDevAnnotation(
        targetType: String,
        targetId: String?,
        note: String,
        contextLabel: String?,
        deepLink: String?,
        appVersion: String?,
        appBuild: String?,
    ) = http.postJsonDiscarding(
        "dev/annotations",
        DevAnnotationBody(
            targetType = targetType,
            targetId = targetId,
            note = note,
            context = buildMap {
                put("platform", "android")
                contextLabel?.takeIf { it.isNotBlank() }?.let { put("label", it) }
                appVersion?.takeIf { it.isNotBlank() }?.let { put("appVersion", it) }
                appBuild?.takeIf { it.isNotBlank() }?.let { put("appBuild", it) }
            },
            deepLink = deepLink?.takeIf { it.isNotBlank() },
        ),
    )
}
