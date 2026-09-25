// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.watches

import dev.omnesis.android.transport.dto.PrivacySubscriptionFiring
import dev.omnesis.android.transport.dto.WatchDisclosureDto
import dev.omnesis.android.transport.dto.WatchFiringDto
import dev.omnesis.android.transport.dto.WatchRecordDto
import dev.omnesis.android.transport.dto.WatchVerdictDto
import java.time.Instant

/**
 * How the watch surfaces say things, kept apart from the composables that draw them so the
 * wording can be tested without rendering anything. The iPhone app splits the same way.
 */

/**
 * A watch's state, named for what it is doing rather than for the token the runtime stores.
 *
 * Forward-compatible: a gateway newer than this build may name a state this one has never heard
 * of, and showing it verbatim is more use than showing "Unknown".
 */
internal fun watchStatusLabel(status: String): String = when (status) {
    "active" -> "running"
    "paused" -> "held"
    "retired" -> "finished"
    else -> status
}

/**
 * Who wanted this watch.
 *
 * Only an integration-authored watch names anybody: a watch the operator asked for themselves
 * needs no attribution beyond saying so.
 */
internal fun watchAskedBy(watch: WatchRecordDto): String {
    val disclosure = watch.disclosure
    if (disclosure == null || disclosure.authoredBy != "integration") return "You asked for this"
    return "${disclosure.integrationName ?: "An integration"} asked for this"
}

/** Where a firing goes, as a phrase short enough to sit on a row. */
internal fun watchDeliveryLabel(watch: WatchRecordDto): String = when (val delivery = watch.delivery) {
    "omnesis-notify" -> "Notifies you"
    "agent-wake" -> watch.disclosure?.integrationName?.let { "Wakes $it" } ?: "Wakes an agent"
    null -> "Records only"
    else -> delivery
}

/**
 * The same fact as a sentence, for the detail screen.
 *
 * A watch that delivers nowhere is the case worth spelling out: it is still doing its work, and
 * a reader who is not told will assume it is broken.
 */
internal fun watchDeliverySentence(watch: WatchRecordDto): String = when (watch.delivery) {
    "omnesis-notify" -> "Notifies your devices."
    null -> "Delivers nowhere. Every firing is recorded here and nobody is told."
    else -> "${watchDeliveryLabel(watch)}."
}

/** What the integration is woken with, quoted from the record it was granted under. */
internal fun watchDisclosureWakeSentence(disclosure: WatchDisclosureDto): String {
    val agent = disclosure.integrationName ?: "an integration"
    val instruction = disclosure.instruction?.trim()
    if (instruction.isNullOrEmpty()) return "Wakes $agent: No instruction was recorded."
    return "Wakes $agent: $instruction"
}

/**
 * The verdict worth marking on a row.
 *
 * Null unless the runtime says there is something to do about it — the ordinary "working"
 * verdict is not news, and marking every row would make the mark mean nothing.
 */
internal fun watchVerdictMark(verdict: WatchVerdictDto?): String? {
    if (verdict == null || !verdict.actionable) return null
    return verdict.label?.takeIf { it.isNotBlank() } ?: verdict.name.takeIf { it.isNotBlank() }
}

/**
 * One line of a watch's history: what the runtime recorded, what the egress ledger recorded, or
 * both halves of the same event.
 */
internal data class WatchFiringRow(
    val caught: WatchFiringDto?,
    val sent: PrivacySubscriptionFiring?,
    /**
     * Which firing at its sequence this is. A sequence names a set rather than one firing — a
     * broadcast arm re-judges every live cell at the tick's own sequence number — so without
     * this two rows on the same tick would share an identity.
     */
    val occurrence: Int = 0,
) {
    /** Stable within a watch: the sequence when there is one, else the disclosure's own id. */
    val id: String = when {
        caught == null -> "sent:${sent?.id.orEmpty()}"
        occurrence == 0 -> "seq:${caught.seq}"
        else -> "seq:${caught.seq}#$occurrence"
    }

    /** When this line happened, for ordering a history written by two subsystems. */
    val at: Long = caught?.let { epochMillisOf(it.noticedAt ?: it.firedAt) } ?: sent?.createdAt ?: 0L
}

private fun epochMillisOf(iso: String): Long =
    runCatching { Instant.parse(iso).toEpochMilli() }.getOrDefault(0L)

/**
 * Fold the runtime's firings and the egress ledger into one history, newest first.
 *
 * They are two records of the same events written by different subsystems, and read side by
 * side they never quite line up: the runtime records every firing, the ledger only those that
 * disclosed something. Joining on the journal sequence puts both halves of an event on one line
 * and keeps the unmatched ones rather than dropping them — a disclosure with no matching firing
 * is exactly the discrepancy a reader needs to see.
 */
internal fun mergeWatchFirings(
    caught: List<WatchFiringDto>,
    sent: List<PrivacySubscriptionFiring>,
): List<WatchFiringRow> {
    val bySeq = sent.filter { it.seq != null }
        .groupBy { checkNotNull(it.seq) }
        .mapValues { (_, firings) -> ArrayDeque(firings) }
    val occurrences = mutableMapOf<Int, Int>()
    val joined = caught.map { firing ->
        val occurrence = occurrences.getOrDefault(firing.seq, 0)
        occurrences[firing.seq] = occurrence + 1
        WatchFiringRow(
            caught = firing,
            sent = bySeq[firing.seq]?.removeFirstOrNull(),
            occurrence = occurrence,
        )
    }
    val unclaimed = bySeq.values.flatten() + sent.filter { it.seq == null }
    // Newest first, and by sequence within an instant: two firings on the same tick carry the
    // same time, and a stable sort alone would leave them in the order they arrived.
    return (joined + unclaimed.map { WatchFiringRow(caught = null, sent = it) })
        .sortedWith(compareByDescending<WatchFiringRow> { it.at }.thenByDescending { it.caught?.seq ?: Int.MIN_VALUE })
}
