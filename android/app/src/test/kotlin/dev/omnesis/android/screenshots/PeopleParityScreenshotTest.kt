// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.Annotation
import dev.omnesis.android.transport.dto.MergedFromPerson
import dev.omnesis.android.transport.dto.PersonAlias
import dev.omnesis.android.transport.dto.PeopleStats
import dev.omnesis.android.transport.dto.PersonDetail
import dev.omnesis.android.transport.dto.PersonSummary
import dev.omnesis.android.ui.people.MergedFromSheetBody
import dev.omnesis.android.ui.people.PeopleContent
import dev.omnesis.android.ui.people.PeopleViewModel
import dev.omnesis.android.ui.people.PersonDetailContent
import dev.omnesis.android.ui.people.PersonDetailViewModel
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.CursorPagingState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Pixel-parity screenshots for the People area against the canonical iOS fixtures
 * (`20-people-list`, `21-person-detail`, `22-people-empty`, `25-people-list-long-name`,
 * `26-person-detail-merged-from`, `27-person-detail-merged-into`). Robolectric + Roborazzi,
 * the Android analogue of the iOS preview snapshot loop. All sample data is invented
 * (privacy rule), never sourced from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PeopleParityScreenshotTest {


    // Neutral glyph fallback (no brand art) — mirrors the iOS source-strip doc icons.
    private val iconFor: (String) -> SourceIconModel = { id -> SourceIconModel(fallbackInitial = id.take(1).uppercase()) }

    // Relative timestamps are computed against the wall clock at render time, so anchor the
    // fixtures to "now" minus an offset to reproduce the iOS "seen 3m ago" / "1h ago" phrasing.
    private fun ago(amount: Long, unit: ChronoUnit): String = Instant.now().minus(amount, unit).toString()

    private fun capture(name: String, dark: Boolean, content: @androidx.compose.runtime.Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    // --- People list --------------------------------------------------------

    private fun other(id: String, name: String, aliases: Int, docs: Int, seen: String, strip: List<String>) =
        PersonSummary(id = id, canonicalName = name, aliasCount = aliases, documentCount = docs, lastSeen = seen, sourceIds = strip)

    // 12 non-self rows so the TOP CONTACTS (first 9) + EVERYONE (rest) split both populate.
    private fun people() = listOf(
        PersonSummary(
            id = "self", canonicalName = "You", isSelf = true, aliasCount = 7, documentCount = 18421,
            lastSeen = ago(3, ChronoUnit.MINUTES),
            sourceIds = listOf("gmail:a", "files:b", "notes:c", "events:d", "messages:e"),
        ),
        other("p1", "Maya Reeves", 3, 412, ago(1, ChronoUnit.HOURS), listOf("gmail:a", "files:b", "notes:c")),
        other("p2", "Jamie Lopez", 2, 287, ago(4, ChronoUnit.DAYS), listOf("gmail:a", "messages:e")),
        other("p3", "David Lin", 1, 150, ago(22, ChronoUnit.DAYS), listOf("files:b")),
        other("p4", "Priya Anand Chakraborty", 6, 2487, ago(1, ChronoUnit.DAYS), listOf("gmail:a", "files:b", "notes:c", "events:d", "messages:e")),
        other("p5", "Sarah Mendez", 2, 96, ago(6, ChronoUnit.DAYS), listOf("gmail:a")),
        other("p6", "Leo Whitfield", 4, 81, ago(9, ChronoUnit.DAYS), listOf("files:b", "notes:c")),
        other("p7", "Amara Osei", 1, 64, ago(17, ChronoUnit.DAYS), listOf("messages:e")),
        other("p8", "Felix Brandt", 3, 52, ago(28, ChronoUnit.DAYS), listOf("gmail:a", "events:d")),
        other("p9", "Nina Castellano", 2, 47, ago(5, ChronoUnit.HOURS), listOf("notes:c")),
        other("p10", "Theo Marsh", 1, 33, ago(2, ChronoUnit.DAYS), listOf("files:b")),
        other("p11", "Rosa Delacroix", 5, 21, ago(11, ChronoUnit.HOURS), listOf("gmail:a", "files:b")),
        other("p12", "Quentin Hale", 1, 9, ago(13, ChronoUnit.DAYS), listOf("messages:e")),
    )

    private fun peopleContent(query: String = "", list: List<PersonSummary> = people()): @androidx.compose.runtime.Composable () -> Unit = {
        PeopleContent(
            state = PeopleViewModel.State(
                query = query,
                people = Loadable.Content(list),
                stats = PeopleStats(pendingMergeCandidates = 133, mergeRules = 415),
            ),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    @Test
    fun people_list_dark() = capture("people_parity_list_dark", dark = true, content = peopleContent())

    @Test
    fun people_list_light() = capture("people_parity_list_light", dark = false, content = peopleContent())

    /**
     * Pulled to refresh: the rows stay, with the pull indicator over them. Before `Content`
     * could carry a reload, this state was a full-screen spinner and the list was gone.
     */
    @Test
    fun people_reloading_keeps_its_rows_dark() = capture(
        "people_parity_reloading_dark",
        dark = true,
    ) {
        PeopleContent(
            state = PeopleViewModel.State(
                people = Loadable.Content(people().take(4), refreshing = true),
                stats = PeopleStats(pendingMergeCandidates = 133, mergeRules = 415),
            ),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    private fun peoplePagingContent(): @androidx.compose.runtime.Composable () -> Unit = {
        PeopleContent(
            state = PeopleViewModel.State(
                people = Loadable.Content(people().take(2)),
                paging = CursorPagingState(nextCursor = "next-page"),
            ),
            onOpenMenu = {},
            onQueryChange = {},
            onRetry = {},
            onOpenPerson = { _, _ -> },
            iconFor = iconFor,
        )
    }

    @Test
    fun people_paging_dark() =
        capture("people_parity_paging_dark", dark = true, content = peoplePagingContent())

    @Test
    fun people_paging_light() =
        capture("people_parity_paging_light", dark = false, content = peoplePagingContent())

    @Test
    fun people_list_results_dark() = capture(
        "people_parity_results_dark", dark = true,
        content = peopleContent(query = "david", list = people().filter { it.isSelf || it.canonicalName.contains("David") }),
    )

    @Test
    fun people_empty_dark() = capture("people_parity_empty_dark", dark = true) {
        PeopleContent(
            state = PeopleViewModel.State(people = Loadable.Content(emptyList())),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    @Test
    fun people_empty_query_dark() = capture("people_parity_empty_query_dark", dark = true) {
        PeopleContent(
            state = PeopleViewModel.State(query = "zzz", people = Loadable.Content(emptyList())),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    @Test
    fun people_loading_dark() = capture("people_parity_loading_dark", dark = true) {
        PeopleContent(
            state = PeopleViewModel.State(people = Loadable.Loading),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    // --- Person detail ------------------------------------------------------

    private fun previewIcon(initial: String) = SourceIconModel(fallbackInitial = initial)

    private fun person() = PersonDetail(
        id = "p1", canonicalName = "Maya Reeves", isSelf = false,
        firstSeen = "2022-09-06T10:00:00Z", lastSeen = ago(1, ChronoUnit.HOURS),
        aliases = listOf(
            PersonAlias(id = "a1", aliasType = "email", alias = "maya@example.com"),
            PersonAlias(id = "a2", aliasType = "email", alias = "maya.reeves@work.example.co"),
            PersonAlias(id = "a3", aliasType = "phone", alias = "+1 (555) 010-0142"),
            PersonAlias(id = "a4", aliasType = "name", alias = "Maya R."),
        ),
        inboundCount = 200, outboundCount = 212, interactionScore = 0.412, interactionScoreRecent = 0.412,
    )

    private fun docs() = listOf(
        PersonDetailViewModel.DocRow("d1", "Q4 budget review", "Gmail", previewIcon("G"), listOf("sender"), "Email", "1h ago"),
        PersonDetailViewModel.DocRow("d2", "Re: vendor evaluation", "Gmail", previewIcon("G"), listOf("recipient", "mentioned"), "Email", "2d ago"),
        PersonDetailViewModel.DocRow("d3", "Studio Northstar contract", "Files", previewIcon("F"), listOf("participant"), "Document", "12d ago"),
    )

    private fun detail(p: PersonDetail = person(), d: List<PersonDetailViewModel.DocRow> = docs()) =
        PersonDetailViewModel.Content(person = p, docs = d)

    // Invented durable-observation rows (privacy rule) — a grounded claim with an evidence
    // quote, plus two ungrounded claims at varying confidence. The first two carry the
    // claim-basis chip + verification marker; the last is the legacy shape (neither).
    // Verification timestamps are relative to now so the "· Nd ago" recency stays stable.
    private fun annotations() = listOf(
        Annotation(
            id = "an-1", claimType = "preference",
            claimText = "Prefers async written updates over live meetings.",
            evidenceQuote = "Let's keep this to email — I can't do a call this week.",
            confidence = 0.82,
            claimBasis = "quoted",
            verificationState = "verified",
            lastVerifiedAt = ago(2, ChronoUnit.DAYS),
        ),
        Annotation(
            id = "an-2", claimType = "role",
            claimText = "Leads the design team on the Northstar project.",
            confidence = 0.74,
            claimBasis = "inferred",
            verificationState = "unverified",
        ),
        Annotation(
            id = "an-3", claimType = "location",
            claimText = "Based in the Pacific timezone.",
            confidence = 0.9,
        ),
    )

    private fun detailContent(content: PersonDetailViewModel.Content): @androidx.compose.runtime.Composable () -> Unit = {
        PersonDetailContent(
            state = Loadable.Content(content),
            onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    @Test
    fun person_detail_dark() = capture("people_parity_detail_dark", dark = true, content = detailContent(detail()))

    @Test
    fun person_detail_light() = capture("people_parity_detail_light", dark = false, content = detailContent(detail()))

    private fun detailPagingContent(): @androidx.compose.runtime.Composable () -> Unit = {
        PersonDetailContent(
            state = Loadable.Content(
                detail(d = docs().take(1)).copy(
                    documentsPaging = CursorPagingState(nextCursor = "30"),
                ),
            ),
            onBack = {},
            onRetry = {},
            onOpenDocument = {},
            onLoadMore = {},
            onOpenPerson = { _, _ -> },
            iconFor = iconFor,
        )
    }

    @Test
    fun person_detail_paging_dark() =
        capture("people_parity_detail_paging_dark", dark = true, content = detailPagingContent())

    @Test
    fun person_detail_paging_light() =
        capture("people_parity_detail_paging_light", dark = false, content = detailPagingContent())

    private fun detailEmptyPagingErrorContent(): @androidx.compose.runtime.Composable () -> Unit =
        detailContent(
            detail(d = emptyList()).copy(
                documentsPaging = CursorPagingState(
                    nextCursor = "documents-next",
                    paginationError = IllegalStateException("fictional page failure"),
                ),
            ),
        )

    @Test
    fun person_detail_empty_paging_error_dark() = capture(
        "people_parity_detail_empty_paging_error_dark",
        dark = true,
        content = detailEmptyPagingErrorContent(),
    )

    @Test
    fun person_detail_empty_paging_error_light() = capture(
        "people_parity_detail_empty_paging_error_light",
        dark = false,
        content = detailEmptyPagingErrorContent(),
    )

    @Test
    fun person_detail_merged_from_dark() = capture("people_parity_merged_from_dark", dark = true) {
        val canonical = person().copy(
            canonicalName = "david.lin@example.com",
            firstSeen = "2021-03-04T10:00:00Z", lastSeen = ago(4, ChronoUnit.DAYS),
            mergedFrom = mergedFrom(),
        )
        PersonDetailContent(
            state = Loadable.Content(detail(canonical, emptyList())),
            onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    @Test
    fun person_detail_merged_into_dark() = capture("people_parity_merged_into_dark", dark = true) {
        val loser = PersonDetail(
            id = "p9", canonicalName = "+15550100001", isSelf = false,
            firstSeen = "2024-01-02T10:00:00Z", lastSeen = ago(5, ChronoUnit.DAYS),
            mergedInto = "david", mergedIntoCanonicalName = "david.lin@example.com",
        )
        PersonDetailContent(
            state = Loadable.Content(detail(loser, emptyList())),
            onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    @Test
    fun person_detail_self_dark() = capture("people_parity_detail_self_dark", dark = true) {
        val self = person().copy(id = "self", canonicalName = "You", isSelf = true)
        PersonDetailContent(
            state = Loadable.Content(detail(self)),
            onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    // Annotations panel: "What Omnesis has learned about <name>" on a non-self person.
    @Test
    fun person_detail_annotations_dark() = capture(
        "people_parity_detail_annotations_dark", dark = true,
        content = detailContent(detail().copy(annotations = annotations())),
    )

    @Test
    fun person_detail_annotations_light() = capture(
        "people_parity_detail_annotations_light", dark = false,
        content = detailContent(detail().copy(annotations = annotations())),
    )

    // Self variant renders the "Profile" header instead.
    @Test
    fun person_detail_annotations_self_dark() = capture("people_parity_detail_annotations_self_dark", dark = true) {
        val self = person().copy(id = "self", canonicalName = "You", isSelf = true)
        PersonDetailContent(
            state = Loadable.Content(detail(self).copy(annotations = annotations())),
            onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    // Loading skeleton: avatar placeholder circle + preset name + "Loading person…" row.
    // Parity targets: iOS 23-person-detail-loading / 24-...-no-name.
    @Test
    fun person_detail_loading_dark() = capture("people_parity_detail_loading_dark", dark = true) {
        PersonDetailContent(
            state = Loadable.Loading, presetName = "Maya Reeves",
            onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    @Test
    fun person_detail_loading_no_name_dark() = capture("people_parity_detail_loading_no_name_dark", dark = true) {
        PersonDetailContent(
            state = Loadable.Loading, presetName = null,
            onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    // Progressive doc-row fill: a row still resolving shows "Loading…" + neutral fallback glyph.
    @Test
    fun person_detail_docs_loading_dark() = capture("people_parity_detail_docs_loading_dark", dark = true) {
        val pending = listOf(
            PersonDetailViewModel.DocRow("d1", "Q4 budget review", "Gmail", previewIcon("G"), listOf("sender"), "Email", "1h ago"),
            PersonDetailViewModel.DocRow(
                "d2", title = "Loading…", sourceLabel = "", icon = previewIcon("?"),
                roles = listOf("recipient"), loaded = false,
            ),
        )
        PersonDetailContent(
            state = Loadable.Content(detail(d = pending)),
            onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = iconFor,
        )
    }

    // --- Merged-from sheet body (the `28-merged-from-sheet` fixture) ---------

    private fun mergedFrom() = listOf(
        MergedFromPerson(id = "m1", canonicalName = "+15550100001", appliedAt = ago(1, ChronoUnit.MINUTES), sourceIds = listOf("messages:e")),
        MergedFromPerson(id = "m2", canonicalName = "David", appliedAt = ago(2, ChronoUnit.MINUTES), sourceIds = listOf("gmail:a")),
        MergedFromPerson(id = "m3", canonicalName = "David Lin (Google Docs)", appliedAt = ago(3, ChronoUnit.MINUTES), sourceIds = listOf("files:b")),
        MergedFromPerson(id = "m4", canonicalName = "david", appliedAt = ago(4, ChronoUnit.MINUTES), sourceIds = listOf("gmail:a", "files:b")),
    )

    @Test
    fun merged_from_sheet_dark() = capture("people_parity_merged_from_sheet_dark", dark = true) {
        MergedFromSheetBody(
            merged = mergedFrom(),
            canonicalName = "david.lin@example.com",
            iconFor = iconFor,
            onDone = {}, onOpenPerson = { _, _ -> },
        )
    }

    @Test
    fun merged_from_sheet_light() = capture("people_parity_merged_from_sheet_light", dark = false) {
        MergedFromSheetBody(
            merged = mergedFrom(),
            canonicalName = "david.lin@example.com",
            iconFor = iconFor,
            onDone = {}, onOpenPerson = { _, _ -> },
        )
    }
}
