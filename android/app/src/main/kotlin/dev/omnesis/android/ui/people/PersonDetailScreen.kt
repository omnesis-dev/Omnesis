// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.MailOutline
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.MergedFromPerson
import dev.omnesis.android.transport.dto.Annotation
import dev.omnesis.android.transport.dto.PersonAlias
import dev.omnesis.android.transport.dto.PersonDetail
import dev.omnesis.android.transport.dto.displayName
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.annotationsSectionItems

@Composable
fun PersonDetailScreen(
    onBack: () -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpenPerson: (id: String, name: String?) -> Unit = { _, _ -> },
    onOpenSettings: () -> Unit = {},
    vm: PersonDetailViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    PersonDetailContent(
        state = state,
        presetName = vm.presetName,
        onBack = onBack,
        onRetry = vm::load,
        onOpenDocument = onOpenDocument,
        onLoadMore = vm::loadMore,
        onOpenPerson = onOpenPerson,
        onOpenSettings = onOpenSettings,
        iconFor = vm::iconFor,
        onLoadMoreAnnotations = vm::loadMoreAnnotations,
        onToggleAnnotationDependents = vm::toggleAnnotationDependents,
        onLoadMoreAnnotationDependents = vm::loadMoreAnnotationDependents,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PersonDetailContent(
    state: Loadable<PersonDetailViewModel.Content>,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onOpenDocument: (String) -> Unit,
    onLoadMore: () -> Unit,
    presetName: String? = null,
    onOpenPerson: (id: String, name: String?) -> Unit = { _, _ -> },
    onOpenSettings: () -> Unit = {},
    iconFor: (String) -> SourceIconModel = { SourceIconModel() },
    onLoadMoreAnnotations: () -> Unit = {},
    onToggleAnnotationDependents: (Annotation) -> Unit = {},
    onLoadMoreAnnotationDependents: (Annotation) -> Unit = {},
) {
    val c = OmTheme.colors
    val person = (state as? Loadable.Content)?.value?.person
    // While the fetch is in flight, the title falls back to the preset canonicalName (the iOS
    // presetName), so the bar reads the tapped name instantly instead of a bare "Person".
    val title = person?.canonicalName?.takeIf { it.isNotBlank() }
        ?: presetName?.takeIf { it.isNotBlank() }
        ?: "Person"
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back", tint = c.textPrimary)
                    }
                },
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis, color = c.textPrimary) },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = c.bgPrimary,
                    scrolledContainerColor = c.bgPrimary,
                ),
            )
        },
    ) { padding ->
        when (state) {
            Loadable.Loading -> HeaderLoading(presetName, Modifier.padding(padding))
            is Loadable.Error -> GatewayErrorView(
                context = "load this person",
                error = state.throwable,
                onRetry = onRetry,
                onOpenSettings = onOpenSettings,
                modifier = Modifier.padding(padding),
            )
            is Loadable.Content -> Body(
                content = state.value,
                modifier = Modifier.padding(padding),
                onOpenDocument = onOpenDocument,
                onLoadMore = onLoadMore,
                onOpenPerson = onOpenPerson,
                iconFor = iconFor,
                onLoadMoreAnnotations = onLoadMoreAnnotations,
                onToggleAnnotationDependents = onToggleAnnotationDependents,
                onLoadMoreAnnotationDependents = onLoadMoreAnnotationDependents,
            )
        }
    }
}

/**
 * Loading skeleton mirroring the iOS `headerLoading`: a bgSecondary placeholder circle (56dp)
 * where the avatar will land, the preset name beside it (20sp bold) when known, then an inline
 * left-aligned ProgressView + "Loading person…" row — all inside the 16dp content padding.
 */
@Composable
private fun HeaderLoading(presetName: String?, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Column(
        modifier = modifier.fillMaxWidth().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(Modifier.size(56.dp).clip(CircleShape).background(c.bgSecondary))
            if (!presetName.isNullOrBlank()) {
                Text(
                    presetName,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = c.textPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OmSpinner(Modifier.size(16.dp), strokeWidth = 2.dp, color = c.textSecondary)
            Text("Loading person…", fontSize = 13.sp, color = c.textSecondary)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun Body(
    content: PersonDetailViewModel.Content,
    modifier: Modifier,
    onOpenDocument: (String) -> Unit,
    onLoadMore: () -> Unit,
    onOpenPerson: (id: String, name: String?) -> Unit,
    iconFor: (String) -> SourceIconModel,
    onLoadMoreAnnotations: () -> Unit,
    onToggleAnnotationDependents: (Annotation) -> Unit,
    onLoadMoreAnnotationDependents: (Annotation) -> Unit,
) {
    val c = OmTheme.colors
    val person = content.person
    val merged = person.mergedFrom.orEmpty()
    var showSheet by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()

    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        state = listState,
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item("header") { Header(person) }

        if (person.mergedInto != null) {
            item("merged-into") {
                MergedIntoBanner(
                    targetName = person.mergedIntoCanonicalName,
                    onOpen = { onOpenPerson(person.mergedInto!!, person.mergedIntoCanonicalName) },
                )
            }
        }
        if (merged.isNotEmpty()) {
            item("merged-from") {
                MergedFromSummary(count = merged.size, onShowDetails = { showSheet = true })
            }
        }
        if (person.aliases.isNotEmpty()) {
            item("aliases") { AliasesSection(person.aliases) }
        }
        if (!person.isSelf && (person.interactionScore != null || person.interactionScoreRecent != null || person.inboundCount != null || person.outboundCount != null)) {
            item("interaction") { InteractionSection(person) }
        }
        annotationsSectionItems(
            listState = listState,
            keyPrefix = "person-annotations",
            title = if (person.isSelf) {
                "Profile"
            } else {
                "What Omnesis has learned about ${person.canonicalName.ifBlank { "this person" }}"
            },
            annotations = content.annotations,
            paging = content.annotationsPaging,
            onLoadMore = onLoadMoreAnnotations,
            dependents = content.annotationDependents,
            onToggleDependents = onToggleAnnotationDependents,
            onLoadMoreDependents = onLoadMoreAnnotationDependents,
        )

        documentsSectionItems(
            listState = listState,
            docs = content.docs,
            paging = content.documentsPaging,
            onOpenDocument = onOpenDocument,
            onLoadMore = onLoadMore,
        )
    }

    if (showSheet && merged.isNotEmpty()) {
        ModalBottomSheet(
            onDismissRequest = { showSheet = false },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false),
            containerColor = c.bgPrimary,
        ) {
            MergedFromSheetBody(
                merged = merged,
                canonicalName = person.canonicalName,
                iconFor = iconFor,
                onDone = { showSheet = false },
                onOpenPerson = { id, name -> showSheet = false; onOpenPerson(id, name) },
            )
        }
    }
}

private fun LazyListScope.documentsSectionItems(
    listState: androidx.compose.foundation.lazy.LazyListState,
    docs: List<PersonDetailViewModel.DocRow>,
    paging: CursorPagingState,
    onOpenDocument: (String) -> Unit,
    onLoadMore: () -> Unit,
) {
    item("docs-header") {
        PeopleSectionHeader(
            title = "Latest documents",
            modifier = Modifier.fillMaxWidth(),
            trailing = docs.size.takeIf { it > 0 }?.let {
                "$it${if (paging.countIsPartial) "+" else ""}"
            },
        )
    }
    if (docs.isEmpty() && paging.canShowDefinitiveEmpty) {
        item("docs-empty") {
            Text(
                "No documents linked yet.",
                fontSize = 12.sp,
                color = OmTheme.colors.textMuted,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        }
    } else {
        // One item for the whole run of rows, so the list's 12dp section rhythm falls between
        // sections rather than between documents: a document and its separator read as one
        // continuous run, the way the iPhone app stacks them.
        item("docs-rows") {
            Column {
                docs.forEachIndexed { index, doc ->
                    DocRow(doc, onClick = { onOpenDocument(doc.id) })
                    if (index < docs.lastIndex) {
                        HorizontalDivider(
                            thickness = Dp.Hairline,
                            color = OmTheme.colors.borderLight,
                        )
                    }
                }
            }
        }
    }
    item("docs-paging") {
        ListPagingFooter(
            listState = listState,
            boundaryKey = "docs-paging",
            paging = paging,
            onLoadMore = onLoadMore,
            loadAction = "more documents",
        )
    }
}

@Composable
private fun Header(person: PersonDetail) {
    val c = OmTheme.colors
    val name = person.displayName
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PeopleAvatar(name = name, isSelf = person.isSelf, size = 56.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    name,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = c.textPrimary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (person.isSelf) {
                    Text("(self)", fontSize = 12.sp, fontWeight = FontWeight.Medium, color = c.success)
                }
            }
            val first = personRelativeTime(person.firstSeen)
            val last = personRelativeTime(person.lastSeen)
            if (first != null && last != null) {
                Text("first seen $first · last seen $last", fontSize = 11.sp, color = c.textMuted)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AliasesSection(aliases: List<PersonAlias>) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PeopleSectionHeader(title = "Aliases", modifier = Modifier.fillMaxWidth())
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            aliases.forEach { AliasChip(it) }
        }
    }
}

@Composable
private fun AliasChip(alias: PersonAlias) {
    val c = OmTheme.colors
    Row(
        Modifier
            .background(c.bgTertiary, RoundedCornerShape(6.dp))
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(aliasIcon(alias.aliasType), contentDescription = null, tint = c.textMuted, modifier = Modifier.size(10.dp))
        Text(
            alias.alias,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = c.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

private fun aliasIcon(type: String): ImageVector = when (type) {
    "email" -> Icons.Outlined.MailOutline
    "phone" -> Icons.Outlined.Phone
    "lid" -> Icons.Outlined.Tag
    "name" -> Icons.Outlined.Person
    else -> Icons.Outlined.Tag
}

@Composable
private fun InteractionSection(person: PersonDetail) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PeopleSectionHeader(title = "Interaction", modifier = Modifier.fillMaxWidth())
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            StatBlock("Recent", scoreText(person.interactionScoreRecent), Modifier.weight(1f))
            StatBlock("Lifetime", scoreText(person.interactionScore), Modifier.weight(1f))
            StatBlock("Edges", "${person.inboundCount ?: 0} in / ${person.outboundCount ?: 0} out", Modifier.weight(1f))
        }
    }
}

private fun scoreText(score: Double?): String = score?.let { "%.3f".format(it) } ?: "—"

@Composable
private fun StatBlock(label: String, value: String, modifier: Modifier = Modifier) {
    val c = OmTheme.colors
    Column(modifier, horizontalAlignment = Alignment.Start, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(value, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary, style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum"))
        Text(label, fontSize = 10.sp, color = c.textMuted)
    }
}

@Composable
private fun DocRow(doc: PersonDetailViewModel.DocRow, onClick: () -> Unit) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        SourceIcon(doc.icon, size = 22.dp, modifier = Modifier.padding(top = 2.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                doc.title,
                fontSize = 13.sp,
                // Without this the wrapped second line falls back to the device font's own
                // metrics, which run looser than the 13pt/16pt the iPhone app sets.
                lineHeight = 16.sp,
                fontWeight = FontWeight.Medium,
                color = c.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            val meta = buildList {
                doc.sourceLabel.takeIf { it.isNotBlank() }?.let { add(it) }
                doc.docTypeLabel?.let { add(it) }
                doc.whenLabel?.let { add(it) }
                doc.roles.takeIf { it.isNotEmpty() }?.let { add(it.joinToString(", ") { r -> r.replaceFirstChar { ch -> ch.uppercase() } }) }
            }.joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, fontSize = 11.sp, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        Spacer(Modifier.width(8.dp))
        Icon(
            Icons.AutoMirrored.Outlined.KeyboardArrowRight,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.padding(top = 2.dp).size(11.dp),
        )
    }
}

// --- Previews -------------------------------------------------------------

private val previewIcon = SourceIconModel(fallbackInitial = "G")
private val previewIconFor: (String) -> SourceIconModel = { SourceIconModel(fallbackInitial = it.take(1).uppercase()) }

private fun samplePerson() = PersonDetail(
    id = "p1", canonicalName = "Maya Reeves", isSelf = false,
    firstSeen = "2022-09-06T10:00:00Z", lastSeen = "2026-06-08T10:58:00Z",
    aliases = listOf(
        PersonAlias(id = "a1", aliasType = "email", alias = "maya@example.com"),
        PersonAlias(id = "a2", aliasType = "email", alias = "maya.reeves@work.example.co"),
        PersonAlias(id = "a3", aliasType = "phone", alias = "+1 (555) 010-0142"),
        PersonAlias(id = "a4", aliasType = "name", alias = "Maya R."),
    ),
    inboundCount = 200, outboundCount = 212, interactionScore = 0.412, interactionScoreRecent = 0.412,
)

private fun sampleDocs() = listOf(
    PersonDetailViewModel.DocRow("d1", "Q4 budget review", "Gmail", previewIcon, listOf("sender"), "Email", "1h ago"),
    PersonDetailViewModel.DocRow("d2", "Re: vendor evaluation", "Gmail", previewIcon, listOf("recipient", "mentioned"), "Email", "2d ago"),
    PersonDetailViewModel.DocRow("d3", "Studio Northstar contract", "Files", SourceIconModel(fallbackInitial = "F"), listOf("participant"), "Document", "12d ago"),
)

private fun sampleContent(person: PersonDetail = samplePerson(), docs: List<PersonDetailViewModel.DocRow> = sampleDocs()) =
    PersonDetailViewModel.Content(person = person, docs = docs)

@Preview(name = "Person detail · dark")
@Composable
private fun PersonDetailPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        PersonDetailContent(state = Loadable.Content(sampleContent()), onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = previewIconFor)
    }
}

@Preview(name = "Person detail · light")
@Composable
private fun PersonDetailPreviewLight() {
    OmnesisTheme(darkTheme = false) {
        PersonDetailContent(state = Loadable.Content(sampleContent()), onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = previewIconFor)
    }
}

@Preview(name = "Person detail · merged-from · dark")
@Composable
private fun PersonDetailMergedFromPreviewDark() {
    val canonical = samplePerson().copy(
        canonicalName = "david.lin@example.com",
        firstSeen = null,
        mergedFrom = listOf(
            MergedFromPerson(id = "m1", canonicalName = "+15550100001", appliedAt = "2026-06-08T11:56:00Z", sourceIds = listOf("messages:e")),
            MergedFromPerson(id = "m2", canonicalName = "David", appliedAt = "2026-06-08T11:55:00Z", sourceIds = listOf("gmail:a")),
            MergedFromPerson(id = "m3", canonicalName = "David Lin (Google Docs)", appliedAt = "2026-06-08T11:54:00Z", sourceIds = listOf("files:b")),
            MergedFromPerson(id = "m4", canonicalName = "david", appliedAt = "2026-06-08T11:53:00Z", sourceIds = listOf("gmail:a", "files:b")),
        ),
    )
    OmnesisTheme(darkTheme = true) {
        PersonDetailContent(state = Loadable.Content(sampleContent(canonical, emptyList())), onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = previewIconFor)
    }
}

@Preview(name = "Person detail · merged-into · dark")
@Composable
private fun PersonDetailMergedIntoPreviewDark() {
    val loser = PersonDetail(
        id = "p9", canonicalName = "+15550100001", isSelf = false,
        lastSeen = "2026-06-03T10:00:00Z",
        mergedInto = "david", mergedIntoCanonicalName = "david.lin@example.com",
    )
    OmnesisTheme(darkTheme = true) {
        PersonDetailContent(state = Loadable.Content(sampleContent(loser, emptyList())), onBack = {}, onRetry = {}, onOpenDocument = {}, onLoadMore = {}, onOpenPerson = { _, _ -> }, iconFor = previewIconFor)
    }
}
