// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.Serializable

/**
 * One durable LLM-derived observation the agent recorded about a person or a document.
 * Person annotations (`GET /people/:id/annotations`) and document annotations
 * (`GET /documents/:id/annotations`) share this camelCase wire shape, so a single DTO
 * serves both. `confidence` is a defeasible probability in [0, 1]; `evidenceDocId` /
 * `evidenceQuote` are the grounding when the claim was drawn from a specific document.
 * Lenient decode: the nullable/defaulted fields tolerate the gateway omitting an optional
 * field (e.g. evidenceQuote/evidenceDocId on an ungrounded claim, which explicitNulls=false
 * drops from the wire); OmnesisJson's ignoreUnknownKeys separately tolerates any field a newer
 * gateway adds. Both endpoints are experimental-gated server-side (404 when off).
 */
@Serializable
data class Annotation(
    val id: String,
    val claimType: String = "",
    val claimText: String = "",
    val evidenceDocId: String? = null,
    val evidenceQuote: String? = null,
    val confidence: Double = 0.0,
    /** How far the claim reasons from its evidence ("quoted" | "inferred" | "synthesized"). */
    val claimBasis: String? = null,
    val createdAt: String? = null,
    /** Entailment-check stamp ("verified" | "unverified" | "failed"); null = no verifier. */
    val verificationState: String? = null,
    /** ISO timestamp of the last entailment check; null = never checked. */
    val lastVerifiedAt: String? = null,
    /** Number of live briefs/loops built on this prior. Loaded lazily on demand. */
    val dependentCount: Int = 0,
)

/** `{ annotations, pageInfo }` envelope returned by both annotation endpoints. */
@Serializable
data class AnnotationsResponse(
    val annotations: List<Annotation> = emptyList(),
    val pageInfo: PageInfo = PageInfo(limit = annotations.size),
)

/** One live brief/loop whose output consumed an annotation prior. */
@Serializable
data class AnnotationDependent(
    val kind: String,
    val id: String,
    val title: String = "",
    val runId: String? = null,
    val createdAt: String? = null,
)
