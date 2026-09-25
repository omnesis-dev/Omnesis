// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.provider.CallLog
import android.telephony.PhoneNumberUtils
import dev.omnesis.android.transport.dto.DocumentInputDto
import dev.omnesis.android.transport.dto.DocumentMetadataDto
import dev.omnesis.android.transport.dto.PersonMentionDto
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** One raw call row, straight off `CallLog.Calls`. */
data class RawCallRow(
    val id: Long,
    val number: String?,
    val cachedName: String?,
    val dateMillis: Long,
    val durationSeconds: Long,
    /** One of `CallLog.Calls.INCOMING_TYPE`/`OUTGOING_TYPE`/`MISSED_TYPE`/etc. */
    val type: Int,
    val countryIso: String?,
    /** Bitmask; `CallLog.Calls.FEATURES_VIDEO` marks a video call. */
    val features: Int,
    /** Only meaningful when [type] is `MISSED_TYPE` (API 31+; null otherwise or on older devices). */
    val missedReason: Int?,
    /**
     * `CallLog.Calls.PRESENTATION_ALLOWED`/`RESTRICTED`/`PAYPHONE`/`UNKNOWN`.
     * Only `ALLOWED` means [number] is a genuine, dialable phone number — the
     * other three are the platform's way of saying the caller withheld their
     * number or none exists (private/blocked calls, payphones, carrier
     * gaps). Treating those as real numbers would fabricate a phone-shaped
     * identity for a caller who was never actually identified.
     */
    val numberPresentation: Int,
)

/**
 * Pure normalization functions for Android's `CallLog.Calls` — the analogue
 * of `call-log.ts`'s free functions for `apple-call-log`. Every call type
 * other than `OUTGOING_TYPE` is treated as an incoming-direction outcome
 * (missed/rejected/blocked/voicemail/answered-externally are all things that
 * happen to a call placed TO this device).
 */
object CallLogNormalizer {

    private val UTC_DATE: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE.withZone(ZoneOffset.UTC)

    fun isOutgoing(row: RawCallRow): Boolean = row.type == CallLog.Calls.OUTGOING_TYPE

    /** Whether the call actually connected — true for a plain incoming/outgoing call, false for every missed/declined outcome. */
    fun isConnected(row: RawCallRow): Boolean =
        row.type == CallLog.Calls.INCOMING_TYPE || row.type == CallLog.Calls.OUTGOING_TYPE

    fun callTypeLabel(row: RawCallRow): String = when (row.type) {
        CallLog.Calls.INCOMING_TYPE -> "incoming"
        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
        CallLog.Calls.MISSED_TYPE -> "missed"
        CallLog.Calls.VOICEMAIL_TYPE -> "voicemail"
        CallLog.Calls.REJECTED_TYPE -> "rejected"
        CallLog.Calls.BLOCKED_TYPE -> "blocked"
        CallLog.Calls.ANSWERED_EXTERNALLY_TYPE -> "answered_externally"
        else -> "unknown"
    }

    fun medium(row: RawCallRow): String =
        if (row.features and CallLog.Calls.FEATURES_VIDEO != 0) "video" else "voice"

    /** UTC calendar date for a call row. */
    fun callDate(row: RawCallRow): LocalDate =
        Instant.ofEpochMilli(row.dateMillis).atZone(ZoneOffset.UTC).toLocalDate()

    fun callDateKey(row: RawCallRow): String = UTC_DATE.format(Instant.ofEpochMilli(row.dateMillis))

    /**
     * The peer's phone number, E.164-formatted via the platform's own
     * geocoding data (no bundled phone-number library needed) when the
     * device's reported country ISO allows it. Falls back to the raw number
     * when formatting isn't possible (short codes, malformed numbers, or no
     * country ISO on the row). Returns null when [RawCallRow.numberPresentation]
     * says [RawCallRow.number] isn't a genuine number at all (withheld/private,
     * payphone, or unknown) — `NUMBER` still carries a placeholder string from
     * the provider in that case, but it must never be treated as a real phone.
     */
    fun normalizedPhone(row: RawCallRow): String? {
        if (row.numberPresentation != CallLog.Calls.PRESENTATION_ALLOWED) return null
        val raw = row.number?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val iso = row.countryIso?.uppercase()
        val formatted = iso?.let { PhoneNumberUtils.formatNumberToE164(raw, it) }
        return formatted ?: raw
    }

    fun peerMention(row: RawCallRow): PersonMentionDto? {
        val phone = normalizedPhone(row) ?: return null
        return PersonMentionDto(role = "participant", name = row.cachedName, phones = listOf(phone))
    }

    /**
     * Human label for a call whose number isn't a real, dialable number
     * (withheld/private, payphone, or the platform simply doesn't know).
     * `row.number` may still hold a provider placeholder string in this case
     * ("-1", "-2", ...) — never surfaced directly, since it isn't a phone
     * number a person could be identified by.
     */
    private fun unresolvedPeerLabel(row: RawCallRow): String = when (row.numberPresentation) {
        CallLog.Calls.PRESENTATION_RESTRICTED -> "Private number"
        CallLog.Calls.PRESENTATION_PAYPHONE -> "Payphone"
        else -> "Unknown"
    }

    /** Peer display label for the content line — cached name if known, else the number, else why there isn't one. */
    fun peerLabel(row: RawCallRow): String =
        row.cachedName ?: normalizedPhone(row) ?: unresolvedPeerLabel(row)

    /** Format a duration in seconds as a short human string ("12m", "1m 30s", "45s"). */
    fun formatDuration(seconds: Long): String {
        val total = seconds.coerceAtLeast(0)
        if (total < 60) return "${total}s"
        val m = total / 60
        val s = total % 60
        return if (s > 0) "${m}m ${s}s" else "${m}m"
    }

    /** Build the `android_call_log` analytics row for one raw call. */
    fun analyticsRow(row: RawCallRow): Map<String, JsonElement> {
        val phone = normalizedPhone(row)
        val instant = Instant.ofEpochMilli(row.dateMillis)
        return buildMap {
            put("id", JsonPrimitive(row.id.toString()))
            put("date", JsonPrimitive(callDateKey(row)))
            put("time", JsonPrimitive(instant.toString()))
            put("direction", JsonPrimitive(if (isOutgoing(row)) "outgoing" else "incoming"))
            put("call_type", JsonPrimitive(callTypeLabel(row)))
            put("medium", JsonPrimitive(medium(row)))
            put("duration_seconds", JsonPrimitive(row.durationSeconds))
            put("connected", JsonPrimitive(isConnected(row)))
            put("missed_reason", row.missedReason?.let { JsonPrimitive(it) } ?: JsonNull)
            put("counterparty", JsonPrimitive(phone ?: unresolvedPeerLabel(row)))
            put("counterparty_name", row.cachedName?.let { JsonPrimitive(it) } ?: JsonNull)
        }
    }

    /** Build the day-aggregate `call-log` document for every call on [date]. */
    fun buildDayDocument(
        rows: List<RawCallRow>,
        date: LocalDate,
        providerId: String,
        sourceId: String,
    ): DocumentInputDto {
        val dateStr = date.format(DateTimeFormatter.ISO_LOCAL_DATE)
        val lines = mutableListOf("# Calls — $dateStr", "")
        var totalDuration = 0L
        val calls = mutableListOf<JsonElement>()
        val people = mutableListOf(PersonMentionDto(role = "participant", isSelf = true))
        val seenPeers = mutableSetOf<String>()

        val sorted = rows.sortedBy { it.dateMillis }
        for (row in sorted) {
            val instant = Instant.ofEpochMilli(row.dateMillis)
            val time = instant.atZone(ZoneOffset.UTC).toLocalTime().toString().take(5)
            val outgoing = isOutgoing(row)
            val connected = isConnected(row)
            val mediumLabel = if (medium(row) == "video") "Video" else "Phone"
            val label = peerLabel(row)
            val arrow = if (outgoing) "→" else "←"
            val direction = if (outgoing) "Outgoing" else "Incoming"

            val qualifier = if (connected) {
                totalDuration += row.durationSeconds
                ", ${formatDuration(row.durationSeconds)}"
            } else {
                ", ${callTypeLabel(row)}"
            }
            lines += "- $time $direction $mediumLabel $arrow $label$qualifier"

            val mention = peerMention(row)
            if (mention != null) {
                val key = mention.phones?.firstOrNull() ?: ""
                if (key.isNotEmpty() && seenPeers.add(key)) {
                    people += mention
                }
            }

            calls += buildJsonObject {
                put("time", instant.toString())
                put("direction", if (outgoing) "outgoing" else "incoming")
                put("callType", callTypeLabel(row))
                put("medium", medium(row))
                put("durationSeconds", row.durationSeconds)
                put("connected", connected)
                put("peer", mention?.phones?.firstOrNull()?.let { JsonPrimitive(it) } ?: JsonNull)
            }
        }

        lines.add(2, "**Total:** ${sorted.size} call${if (sorted.size == 1) "" else "s"}, ${formatDuration(totalDuration)}")
        lines.add(3, "")
        val content = lines.joinToString("\n")

        return DocumentInputDto(
            providerId = providerId,
            sourceId = sourceId,
            externalId = "call-log:$dateStr",
            title = "Calls — $dateStr",
            content = content,
            contentHash = sha256Hex(content),
            metadata = DocumentMetadataDto(
                documentType = "call-log",
                // Rewritten every time a call lands on this date — route to the
                // daily batch instead of waking the real-time background agent.
                rollingAggregate = true,
                people = people,
                tags = emptyList(),
                extra = buildJsonObject {
                    put("date", dateStr)
                    put("callCount", sorted.size)
                    put("totalDurationSeconds", totalDuration)
                    put("calls", buildJsonArray { calls.forEach { add(it) } })
                },
            ),
            sourceCreatedAt = "${dateStr}T00:00:00.000Z",
            sourceUpdatedAt = "${dateStr}T23:59:59.999Z",
        )
    }

    private fun sha256Hex(content: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(content.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }
}
