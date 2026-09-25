// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport.dto

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * One thing a person should be told about a source on one device, worded by the
 * gateway. Mirrors `SourceNotice` in packages/types/src/source-notice.ts.
 *
 * Clients render [title], [detail] and [steps] verbatim and never derive notices
 * from `errorMessage`, `issues` or `coverage` themselves. The one exception is
 * [SourceSyncStatus.displayNotices], which stands in for a gateway that predates
 * the field (see [fallbackNotices]). [kind] and [severity] stay strings so a value
 * this build does not know still decodes; [level] maps an unknown severity to
 * [NoticeLevel.WARNING]. Lists decode through [LenientNoticeListSerializer], so one
 * malformed notice is skipped rather than failing the status it rides on.
 */
@Serializable
data class SourceNotice(
    val kind: String = "",
    val severity: String = "warning",
    val title: String = "",
    val detail: String? = null,
    val steps: List<String>? = null,
    /** ISO 8601 time the condition was first observed, when the gateway knows it. */
    val since: String? = null,
) {
    val level: NoticeLevel
        get() = when (severity) {
            "info" -> NoticeLevel.INFO
            "error" -> NoticeLevel.ERROR
            else -> NoticeLevel.WARNING
        }
}

/** A notice's severity, ordered from least to most severe. */
enum class NoticeLevel { INFO, WARNING, ERROR }

/**
 * Decodes a notice list one element at a time. An element that is not an object or
 * has no non-blank title is dropped, non-string fields read as absent, and null steps
 * are skipped — a notice is advisory, so a bad one must never cost the whole
 * `/admin/sync/status` page.
 */
object LenientNoticeListSerializer : KSerializer<List<SourceNotice>> {
    private val delegate = ListSerializer(SourceNotice.serializer())
    override val descriptor: SerialDescriptor = delegate.descriptor

    override fun serialize(encoder: Encoder, value: List<SourceNotice>) = delegate.serialize(encoder, value)

    override fun deserialize(decoder: Decoder): List<SourceNotice> {
        val json = decoder as? JsonDecoder ?: return delegate.deserialize(decoder)
        val array = json.decodeJsonElement() as? JsonArray ?: return emptyList()
        return array.mapNotNull { element -> (element as? JsonObject)?.let(::noticeFrom) }
    }

    private fun noticeFrom(o: JsonObject): SourceNotice? {
        fun str(key: String): String? = (o[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val title = str("title")?.takeIf(String::isNotBlank) ?: return null
        val steps = (o["steps"] as? JsonArray)
            ?.mapNotNull { step -> (step as? JsonPrimitive)?.takeIf { it.isString }?.content }
        return SourceNotice(
            kind = str("kind").orEmpty(),
            severity = str("severity") ?: "warning",
            title = title,
            detail = str("detail"),
            steps = steps,
            since = str("since"),
        )
    }
}

/** Titles of the notices synthesized for a gateway that predates `notices`. */
object FallbackNoticeTitles {
    const val NEEDS_AUTH = "Needs sign-in"
    const val RATE_LIMITED = "Paused by the provider's rate limit"
    const val ERROR = "The last sync failed"
    const val STALE = "No new data is arriving"
    const val EXPIRING_PREFIX = "Connection expires on "
}

/**
 * The notices an older gateway would have sent for [status], derived from its state:
 *
 * - `needs-auth` → error "Needs sign-in", detail = `errorMessage` without "needs reauth: ";
 * - `rate-limited` → info "Paused by the provider's rate limit", detail without "rate-limited: ";
 * - `error` → error "The last sync failed", detail = `errorMessage`;
 * - `stale` with a `staleHint` → warning "No new data is arriving", detail = the hint;
 * - `auth-expiring` with a `consentExpiresAt` → warning "Connection expires on <date>".
 *
 * Used only when `notices` is absent. The same table lives in the iOS client and
 * mirrors the gateway's wording, so an older gateway reads the same as a current one.
 */
internal fun fallbackNotices(status: SourceSyncStatus): List<SourceNotice> {
    val message = status.errorMessage?.takeIf(String::isNotBlank)
    val notice = when (status.state) {
        "needs-auth" -> SourceNotice(
            kind = "needs-auth", severity = "error", title = FallbackNoticeTitles.NEEDS_AUTH,
            detail = message?.removePrefix("needs reauth: ")?.takeIf(String::isNotBlank),
        )
        "rate-limited" -> SourceNotice(
            kind = "rate-limited", severity = "info", title = FallbackNoticeTitles.RATE_LIMITED,
            detail = message?.removePrefix("rate-limited: ")?.takeIf(String::isNotBlank),
        )
        "error" -> SourceNotice(kind = "error", severity = "error", title = FallbackNoticeTitles.ERROR, detail = message)
        "stale" -> status.staleHint?.takeIf(String::isNotBlank)?.let { hint ->
            SourceNotice(kind = "stale", severity = "warning", title = FallbackNoticeTitles.STALE, detail = hint)
        }
        "auth-expiring" -> status.consentExpiresAt?.takeIf(String::isNotBlank)?.let { deadline ->
            SourceNotice(
                kind = "auth-expiring",
                severity = "warning",
                title = FallbackNoticeTitles.EXPIRING_PREFIX + expiryDate(deadline),
            )
        }
        else -> null
    }
    return listOfNotNull(notice)
}

private val EXPIRY_DATE = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)

/** "Jul 15, 2026" in the device's zone, or the raw value when it does not parse. */
private fun expiryDate(iso: String): String {
    val instant = runCatching { Instant.parse(iso) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()
        ?: return iso
    return EXPIRY_DATE.withZone(ZoneId.systemDefault()).format(instant)
}
