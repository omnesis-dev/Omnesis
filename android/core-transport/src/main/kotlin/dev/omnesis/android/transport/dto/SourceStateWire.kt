// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * The parts of the source contract a phone has to read the same way the
 * collector does.
 *
 * A phone hosts sources of its own, so it meets the same persisted state, the
 * same failures and the same coverage claims. Re-deriving what those mean here
 * is how three implementations of one vocabulary drift: a value the gateway
 * started sending that this decoder silently reads as absent is invisible
 * until a device stops reporting something.
 *
 * `wire-fixtures/` at the repository root holds the canonical bytes, written
 * from the TypeScript definitions. `SourceStateWireTest` decodes those exact
 * files, so a change on either side that this decoder cannot read fails here
 * rather than on somebody's phone.
 */

/**
 * A source's persisted state, as the gateway stores it.
 *
 * The envelope is deliberately terse — it is written on every committed page —
 * and every field but the state itself is optional on the wire.
 */
@Serializable
data class StateEnvelope(
    /** Envelope format version. Only `1` exists; anything else is unreadable here. */
    @SerialName("e") val envelope: Int,
    /** The source's own state version, which its migration chain is keyed on. */
    @SerialName("v") val version: Int,
    /** Minor version within [version]; absent means zero. */
    @SerialName("m") val minorVersion: Int? = null,
    /** The source this envelope was written for. */
    @SerialName("s") val sourceId: String? = null,
    /** The state itself, opaque to everything but the source that wrote it. */
    @SerialName("state") val state: JsonObject,
)

/**
 * What a stored cursor turned out to be.
 *
 * The three arms are different situations and a decoder that collapses any two
 * of them loses the distinction that matters: [FromNewerBuild] must not be
 * discarded — starting over would overwrite a bookmark the newer build can
 * still use — and [Legacy] is a value written before envelopes existed, not a
 * corrupt one.
 */
sealed interface StoredState {
    /** An envelope this build can read. */
    data class Readable(val envelope: StateEnvelope) : StoredState

    /** An envelope stamped with a version this build does not have. */
    data class FromNewerBuild(val version: Int) : StoredState

    /** A raw cursor from before envelopes existed. */
    data class Legacy(val raw: JsonObject) : StoredState
}

/** How much a failure took with it. Ordered narrow to wide. */
@Serializable
enum class FailureScope {
    /** One upstream item; the page may step over it. */
    @SerialName("item")
    ITEM,

    /** One partition — a calendar, a mailbox, a device's stream. */
    @SerialName("partition")
    PARTITION,

    /** This configured source. The default when a failure does not say. */
    @SerialName("source")
    SOURCE,

    /** The credential, and so every source configured on it. */
    @SerialName("connection")
    CONNECTION,
}

/** What an upstream counts a rate limit against. */
@Serializable
enum class QuotaKind {
    /** Per authenticated account; other accounts are unaffected. */
    @SerialName("account")
    ACCOUNT,

    /** Per registered application; every account shares one budget. */
    @SerialName("app")
    APP,
}

/** The budget a limit was counted against, when the source named one. */
@Serializable
data class QuotaBucket(
    val kind: QuotaKind,
    /** Usually absent: the host derives the bucket from the source that failed. */
    val id: String? = null,
)

/**
 * How much of its upstream history a source holds.
 *
 * [UNKNOWN] is a real answer and not a synonym for [COMPLETE]: a source that
 * has not established whether it is missing history has not said it is whole,
 * and a client that collapses the two shows a corpus as complete on the
 * strength of nobody having checked. The field being absent is different again
 * — the question does not apply to that source, and it gets no line at all.
 */
@Serializable
enum class HistoryCoverage {
    @SerialName("complete")
    COMPLETE,

    @SerialName("partial")
    PARTIAL,

    @SerialName("unknown")
    UNKNOWN,
}
