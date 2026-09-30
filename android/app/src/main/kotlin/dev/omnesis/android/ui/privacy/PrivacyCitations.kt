// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AnswerCitation
import dev.omnesis.android.transport.dto.PrivacyExchangePresentation
import dev.omnesis.android.ui.common.TimeFormat
import dev.omnesis.android.ui.document.canOpenLink
import dev.omnesis.android.ui.document.openFirstLink
import dev.omnesis.android.ui.document.openableDocUrls
import java.time.Instant
import java.time.OffsetDateTime

/** A field the privacy check may withhold from a citation it otherwise shares. */
internal enum class PrivacyCitationField { TITLE, DATE, WEB_LINK, APP_LINK }

/**
 * One row of a citation list: a citation that is (or would be) shared, with
 * the fields the privacy check took off the draft's copy of it, or a drafted
 * citation the check withheld whole.
 */
internal sealed interface PrivacyCitationRow {
    val citation: AnswerCitation

    /**
     * [draft] is the draft's copy of [citation] when the list is compared
     * against a draft; each of [withheldFields] shows the draft's value.
     */
    data class Shared(
        override val citation: AnswerCitation,
        val draft: AnswerCitation? = null,
        val withheldFields: List<PrivacyCitationField> = emptyList(),
    ) : PrivacyCitationRow {
        /** The value a row shows for [field]: the draft's when the check withheld it. */
        fun value(field: PrivacyCitationField): String? =
            (if (field in withheldFields) draft else citation)?.get(field)?.takeIf { it.isNotBlank() }
    }

    /** A citation the draft had and the answer does not; [citation] is the draft's copy. */
    data class Withheld(override val citation: AnswerCitation) : PrivacyCitationRow
}

private fun AnswerCitation.get(field: PrivacyCitationField): String? = when (field) {
    PrivacyCitationField.TITLE -> title
    PrivacyCitationField.DATE -> timestamp
    PrivacyCitationField.WEB_LINK -> sourceUrl
    PrivacyCitationField.APP_LINK -> appUrl
}

private fun AnswerCitation.has(field: PrivacyCitationField): Boolean = !get(field).isNullOrBlank()

/**
 * The rows of a citation list. Against a [drafted] baseline — the citations
 * the agent's recorded draft carried — rows follow the draft's order: a
 * drafted citation [released] keeps is shared and names the fields the draft
 * had and the released copy lacks, one it does not keep is withheld, and a
 * released citation the draft lacked follows at the end. With a null
 * [drafted] there is nothing to compare against, and every released citation
 * is stated as it is.
 */
internal fun privacyCitationRows(
    released: List<AnswerCitation>,
    drafted: List<AnswerCitation>? = null,
): List<PrivacyCitationRow> {
    if (drafted == null) return released.map { PrivacyCitationRow.Shared(it) }
    val releasedById = released.associateBy { it.documentId }
    val placed = hashSetOf<String>()
    val rows = drafted.distinctBy { it.documentId }.map { draft ->
        val kept = releasedById[draft.documentId] ?: return@map PrivacyCitationRow.Withheld(draft)
        placed += kept.documentId
        PrivacyCitationRow.Shared(
            kept,
            draft = draft,
            withheldFields = PrivacyCitationField.entries.filter { draft.has(it) && !kept.has(it) },
        )
    }
    return rows + released.filter { it.documentId !in placed }.map { PrivacyCitationRow.Shared(it) }
}

/**
 * The draft citations a list of the exchange's released or pending citations
 * is compared against: the draft's, but only when a draft was recorded, since
 * without one every citation would read as unchanged.
 */
internal fun privacyCitationBaseline(exchange: PrivacyExchangePresentation): List<AnswerCitation>? =
    exchange.draftCitations.takeIf { !exchange.draftAnswer.isNullOrEmpty() }

/**
 * The rows of the list of what left beside a shared answer, measured against
 * the recorded draft so a citation the check withheld is marked withheld
 * rather than simply missing. Empty without a recorded draft, since the draft
 * card then shows the shared answer and these same citations, and empty when
 * the shared citations equal the draft's in documents, fields and order, since
 * the draft card's list already shows exactly what left.
 */
internal fun privacySharedCitationRows(exchange: PrivacyExchangePresentation): List<PrivacyCitationRow> {
    if (exchange.draftAnswer.isNullOrBlank()) return emptyList()
    if (exchange.sharedCitations == exchange.draftCitations) return emptyList()
    return privacyCitationRows(exchange.sharedCitations, privacyCitationBaseline(exchange))
}

/**
 * The citations beside the answer the draft card shows: the list recorded
 * beside the first of draftAnswer, pendingCandidate and sharedAnswer that is
 * present, the same precedence [privacyDisplayedAnswer] uses, and none when
 * that answer is blank so the list always belongs to the text above it.
 */
internal fun privacyDisplayedCitations(exchange: PrivacyExchangePresentation): List<AnswerCitation> = when {
    privacyDisplayedAnswer(exchange) == null -> emptyList()
    exchange.draftAnswer != null -> exchange.draftCitations
    exchange.pendingCandidate != null -> exchange.pendingCitations
    else -> exchange.sharedCitations
}

/** The document's date, in the day format the spine uses, or null when it cannot be read. */
internal fun privacyCitationDay(timestamp: String?): String? {
    if (timestamp.isNullOrBlank()) return null
    val instant = runCatching { Instant.parse(timestamp) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(timestamp).toInstant() }.getOrNull()
        ?: return null
    return TimeFormat.day(instant.toEpochMilli()).ifBlank { null }
}

/** Heading of the draft card's list. */
internal const val PRIVACY_CITATIONS_DRAFT_HEADING = "Cited in this draft"

/** Heading of a list of what "Share once" would release. */
internal const val PRIVACY_CITATIONS_PENDING_HEADING = "Citations that would be shared"

/** Note under [PRIVACY_CITATIONS_PENDING_HEADING]. */
internal const val PRIVACY_CITATIONS_PENDING_NOTE = "Share once releases these documents and every link printed here."

/** Heading of the list of what left beside a shared answer. */
internal const val PRIVACY_CITATIONS_SHARED_HEADING = "Citations shared"

/** Note on a list that marks anything withheld. */
internal const val PRIVACY_CITATIONS_WITHHELD_NOTE =
    "Marked withheld: in the draft, removed by the privacy check. It did not leave this machine."

/**
 * A compact list of cited documents under the answer they belong to: each row's
 * title, source and date, then every link it carries written out, because the
 * links are what leaves and the reader must be able to see them rather than a
 * label standing in for them. A link an app on this phone opens is tappable.
 *
 * Anything the privacy check withheld is shown as the draft had it, struck
 * through, muted, never tappable, and marked withheld — a whole citation with
 * a "Withheld" chip, a single field with a "withheld" tag — and the list then
 * carries a note saying what the mark means. Renders nothing for an empty list.
 *
 * @param onOpenUrl opens one link; when null the link is handed to the first
 *   app that accepts it.
 */
@Composable
internal fun PrivacyCitationList(
    heading: String,
    rows: List<PrivacyCitationRow>,
    modifier: Modifier = Modifier,
    note: String? = null,
    catalog: SourceCatalog = SourceCatalog(),
    onOpenUrl: ((String) -> Unit)? = null,
) {
    if (rows.isEmpty()) return
    val c = OmTheme.colors
    val context = LocalContext.current
    val open: (String) -> Unit = onOpenUrl ?: { url -> context.openFirstLink(listOf(url)) }
    val marksWithheld = rows.any { row ->
        row is PrivacyCitationRow.Withheld || (row as? PrivacyCitationRow.Shared)?.withheldFields?.isNotEmpty() == true
    }
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                heading,
                style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.SemiBold),
                color = c.textPrimary,
            )
            note?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = c.textSecondary) }
            if (marksWithheld) {
                Text(PRIVACY_CITATIONS_WITHHELD_NOTE, style = MaterialTheme.typography.labelSmall, color = c.textSecondary)
            }
        }
        rows.forEach { row ->
            PrivacyCitationRowView(
                row = row,
                catalog = catalog,
                canOpen = context::canOpenLink,
                onOpenUrl = open,
            )
        }
    }
}

@Composable
private fun PrivacyCitationRowView(
    row: PrivacyCitationRow,
    catalog: SourceCatalog,
    canOpen: (String) -> Boolean,
    onOpenUrl: (String) -> Unit,
) {
    val c = OmTheme.colors
    val removed = row is PrivacyCitationRow.Withheld
    val withheldFields = (row as? PrivacyCitationRow.Shared)?.withheldFields.orEmpty()
    fun value(field: PrivacyCitationField): String? = when (row) {
        is PrivacyCitationRow.Shared -> row.value(field)
        is PrivacyCitationRow.Withheld -> row.citation.get(field)?.takeIf { it.isNotBlank() }
    }
    fun struck(field: PrivacyCitationField) = removed || field in withheldFields
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            val titleStruck = struck(PrivacyCitationField.TITLE)
            Text(
                value(PrivacyCitationField.TITLE) ?: "Untitled",
                style = MaterialTheme.typography.bodySmall.copy(
                    fontWeight = FontWeight.SemiBold,
                    textDecoration = if (titleStruck) TextDecoration.LineThrough else null,
                ),
                color = if (titleStruck) c.textMuted else c.textPrimary,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (PrivacyCitationField.TITLE in withheldFields) PrivacyWithheldTag()
            if (removed) PrivacyChip(PrivacyOutcomeDisplay(PrivacyTone.KEPT, "Withheld"))
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.xs),
        ) {
            val source = catalog.familyLabel(row.citation.sourceType).takeIf { it.isNotBlank() }
            val day = privacyCitationDay(value(PrivacyCitationField.DATE))
            if (source != null) {
                Text(source, style = MaterialTheme.typography.labelSmall, color = c.textSecondary)
            }
            if (source != null && day != null) {
                Text("·", style = MaterialTheme.typography.labelSmall, color = c.textSecondary)
            }
            if (day != null) {
                val dateStruck = struck(PrivacyCitationField.DATE)
                Text(
                    day,
                    style = MaterialTheme.typography.labelSmall.copy(
                        textDecoration = if (dateStruck) TextDecoration.LineThrough else null,
                    ),
                    color = if (dateStruck) c.textMuted else c.textSecondary,
                )
                if (PrivacyCitationField.DATE in withheldFields) PrivacyWithheldTag()
            }
        }
        listOf(
            PrivacyCitationField.WEB_LINK to "Link",
            PrivacyCitationField.APP_LINK to "App link",
        ).forEach { (field, label) ->
            val url = value(field) ?: return@forEach
            PrivacyCitationLink(
                label = label,
                url = url,
                withheldHere = field in withheldFields,
                struck = struck(field),
                canOpen = canOpen,
                onOpenUrl = onOpenUrl,
            )
        }
    }
}

/** The small "withheld" mark beside a field the privacy check took off. */
@Composable
private fun PrivacyWithheldTag() {
    val colors = privacyChipColors(PrivacyTone.KEPT)
    Text(
        "withheld",
        style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp, fontWeight = FontWeight.SemiBold),
        color = colors.foreground,
        maxLines = 1,
        modifier = Modifier
            .border(1.dp, colors.border, RoundedCornerShape(4.dp))
            .padding(horizontal = 4.dp),
    )
}

/**
 * One link, labelled and written out in full. It is accent-coloured and
 * tappable, with room for a finger, only when it is shared and something on
 * this phone opens it; a [struck] link stayed on this machine and is only text.
 */
@Composable
private fun PrivacyCitationLink(
    label: String,
    url: String,
    withheldHere: Boolean,
    struck: Boolean,
    canOpen: (String) -> Boolean,
    onOpenUrl: (String) -> Unit,
) {
    val c = OmTheme.colors
    // The shared document-link rules: a blocked scheme never opens, whatever claims it.
    val openable = !struck && openableDocUrls(appUrl = null, sourceUrl = url, canOpen = canOpen).isNotEmpty()
    val base = Modifier.fillMaxWidth()
    Row(
        modifier = if (openable) {
            base
                .clickable(onClickLabel = "Open link", role = Role.Button) { onOpenUrl(url) }
                .padding(vertical = 8.dp)
        } else {
            base.padding(vertical = 4.dp)
        },
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Column(Modifier.width(56.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = c.textMuted)
            if (withheldHere) PrivacyWithheldTag()
        }
        Text(
            url,
            style = MaterialTheme.typography.labelSmall.copy(
                textDecoration = if (struck) TextDecoration.LineThrough else null,
            ),
            color = when {
                openable -> c.accent
                struck -> c.textMuted
                else -> c.textSecondary
            },
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}
