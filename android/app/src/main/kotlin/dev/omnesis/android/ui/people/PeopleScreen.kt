// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.CallMerge
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.GroupAdd
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PeopleStats
import dev.omnesis.android.transport.dto.PersonSummary
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.isReloading
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.PullToRefresh
import java.text.NumberFormat

@Composable
fun PeopleScreen(
    onOpenMenu: () -> Unit,
    onOpenPerson: (id: String, name: String?) -> Unit,
    onOpenMergeCandidates: () -> Unit = {},
    onOpenMergeRules: () -> Unit = {},
    onOpenSettings: () -> Unit = {},
    vm: PeopleViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    PeopleContent(
        state = state,
        onOpenMenu = onOpenMenu,
        onQueryChange = vm::onQueryChange,
        onRetry = vm::refresh,
        onOpenPerson = onOpenPerson,
        onOpenMergeCandidates = onOpenMergeCandidates,
        onOpenMergeRules = onOpenMergeRules,
        onRefresh = vm::refresh,
        onOpenSettings = onOpenSettings,
        iconFor = vm::iconFor,
        onLoadMore = vm::loadMore,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PeopleContent(
    state: PeopleViewModel.State,
    onOpenMenu: () -> Unit,
    onQueryChange: (String) -> Unit,
    onRetry: () -> Unit,
    onOpenPerson: (id: String, name: String?) -> Unit,
    onOpenMergeCandidates: () -> Unit = {},
    onOpenMergeRules: () -> Unit = {},
    onRefresh: () -> Unit = onRetry,
    onOpenSettings: () -> Unit = {},
    iconFor: (String) -> SourceIconModel = { SourceIconModel() },
    onLoadMore: () -> Unit = {},
) {
    val c = OmTheme.colors
    val keyboard = LocalSoftwareKeyboardController.current
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onOpenMenu) {
                        Icon(Icons.Outlined.Menu, contentDescription = "Menu", tint = c.accent)
                    }
                },
                title = {
                    Text("People", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = c.bgPrimary,
                    scrolledContainerColor = c.bgPrimary,
                ),
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().background(c.bgPrimary)) {
            SearchField(query = state.query, onQueryChange = onQueryChange, onSearch = { keyboard?.hide() })

            when (val people = state.people) {
                Loadable.Loading -> LoadingView()
                is Loadable.Error -> GatewayErrorView(
                    context = "load people",
                    error = people.throwable,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                is Loadable.Content -> {
                    if (people.value.isEmpty()) {
                        PeopleEmpty(query = state.query)
                    } else {
                        PullToRefresh(refreshing = people.isReloading, onRefresh = onRefresh) {
                            PeopleList(
                                people = people.value,
                                query = state.query,
                                stats = state.stats,
                                iconFor = iconFor,
                                onOpenPerson = onOpenPerson,
                                onOpenMergeCandidates = onOpenMergeCandidates,
                                onOpenMergeRules = onOpenMergeRules,
                                paging = state.paging,
                                onLoadMore = onLoadMore,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PeopleList(
    people: List<PersonSummary>,
    query: String,
    stats: PeopleStats?,
    iconFor: (String) -> SourceIconModel,
    onOpenPerson: (id: String, name: String?) -> Unit,
    onOpenMergeCandidates: () -> Unit,
    onOpenMergeRules: () -> Unit,
    paging: dev.omnesis.android.ui.common.CursorPagingState,
    onLoadMore: () -> Unit,
) {
    // Self is featured; the gateway already returns interaction-score order, so the first 9
    // non-self rows form TOP CONTACTS (query blank only) and the remainder is EVERYONE.
    val self = people.firstOrNull { it.isSelf }
    val others = people.filterNot { it.isSelf }
    val blank = query.isBlank()
    val top = if (blank) others.take(9) else emptyList()
    val rest = if (blank) others.drop(top.size) else others
    val listState = rememberLazyListState()

    LazyColumn(Modifier.fillMaxWidth(), state = listState) {
        // Two count buttons jumping to the merge-candidate queue and the
        // read-only merge-rules viewer; shown above "You" when browsing
        // (not while searching), once the counts have loaded.
        if (blank && stats != null) {
            item("merge-shortcuts") {
                MergeShortcuts(stats, onOpenMergeCandidates, onOpenMergeRules)
            }
        }
        if (self != null) {
            item("hdr-you") { SectionHeader("You") }
            item("self-${self.id}") {
                Column(Modifier.padding(horizontal = 16.dp)) {
                    PersonRow(self, iconFor = iconFor, onClick = { onOpenPerson(self.id, self.canonicalName) })
                    Spacer(Modifier.height(16.dp))
                }
            }
        }

        if (top.isNotEmpty()) {
            item("hdr-top") { SectionHeader("Top contacts") }
            item("top-block") {
                Column(Modifier.padding(horizontal = 16.dp)) {
                    top.forEach { p -> RowWithDivider(p, iconFor, onOpenPerson) }
                    Spacer(Modifier.height(16.dp))
                }
            }
        }

        item("hdr-rest") { SectionHeader(if (blank) "Everyone" else "Results") }
        items(rest, key = { "rest-${it.id}" }) { p ->
            Column(Modifier.padding(horizontal = 16.dp)) {
                RowWithDivider(p, iconFor, onOpenPerson)
            }
        }

        item("paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "paging",
                paging = paging,
                onLoadMore = onLoadMore,
                loadAction = "more people",
                modifier = Modifier.padding(horizontal = 16.dp),
            )
        }
        item("tail") { Spacer(Modifier.height(16.dp)) }
    }
}

@Composable
private fun RowWithDivider(
    person: PersonSummary,
    iconFor: (String) -> SourceIconModel,
    onOpenPerson: (id: String, name: String?) -> Unit,
) {
    PersonRow(person, iconFor = iconFor, onClick = { onOpenPerson(person.id, person.canonicalName) })
    // Inset hairline starting after the 36dp avatar + 12dp gap (= 56dp).
    Spacer(
        Modifier
            .padding(start = 56.dp)
            .fillMaxWidth()
            .height(1.dp)
            .background(OmTheme.colors.borderLight),
    )
}

@Composable
private fun SectionHeader(text: String) {
    PeopleSectionHeader(
        title = text,
        modifier = Modifier.padding(horizontal = 16.dp).fillMaxWidth().padding(bottom = 8.dp),
    )
}

@Composable
private fun MergeShortcuts(
    stats: PeopleStats,
    onOpenMergeCandidates: () -> Unit,
    onOpenMergeRules: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 8.dp, bottom = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        MergeShortcutPill(
            count = stats.pendingMergeCandidates,
            noun = "merge candidate",
            icon = Icons.Outlined.GroupAdd,
            onClick = onOpenMergeCandidates,
            modifier = Modifier.weight(1f),
        )
        MergeShortcutPill(
            count = stats.mergeRules,
            noun = "merge rule",
            icon = Icons.AutoMirrored.Outlined.CallMerge,
            onClick = onOpenMergeRules,
            modifier = Modifier.weight(1f),
        )
    }
}

/**
 * One of the two count buttons at the top of the People list. Shows the count
 * large with the unit noun beneath (e.g. "133" / "merge candidates") and a
 * trailing chevron; the whole card is tappable. Pluralizes the noun on the count.
 */
@Composable
private fun MergeShortcutPill(
    count: Int,
    noun: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    val label = "$noun${if (count == 1) "" else "s"}"
    Column(
        modifier
            .clip(RoundedCornerShape(12.dp))
            .background(c.bgSecondary)
            .border(1.dp, c.borderLight, RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(icon, contentDescription = null, tint = c.accent, modifier = Modifier.size(16.dp))
            Text(
                // Locale-aware grouping (matches the docCount rendering) so 12048 → "12,048".
                NumberFormat.getIntegerInstance().format(count),
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                color = c.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum"),
                modifier = Modifier.weight(1f),
            )
            Icon(
                Icons.AutoMirrored.Outlined.KeyboardArrowRight,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(18.dp),
            )
        }
        Text(
            label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = c.textSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun PersonRow(
    person: PersonSummary,
    iconFor: (String) -> SourceIconModel,
    onClick: () -> Unit,
) {
    val c = OmTheme.colors
    // Matches iOS PersonRow: empty canonicalName reads "(no name)" (the displayName extension's
    // "(unknown)" fallback is for the detail header's alias-fallback ladder, not the list row).
    val name = person.canonicalName.ifBlank { "(no name)" }
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        PeopleAvatar(name = name, isSelf = person.isSelf, size = 36.dp)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    name,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (person.isSelf) {
                    Text(
                        "(self)",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = c.success,
                        maxLines = 1,
                        softWrap = false,
                    )
                }
            }
            val meta = buildList {
                if (person.aliasCount > 0) add("${person.aliasCount} aliases")
                personRelativeTime(person.lastSeen)?.let { add("seen $it") }
            }.joinToString(" · ")
            if (meta.isNotBlank()) {
                Text(meta, fontSize = 11.sp, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        person.sourceIds?.takeIf { it.isNotEmpty() }?.let { ids ->
            PersonSourceStrip(sourceIds = ids, iconFor = iconFor, size = 14.dp)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(
                // Locale-aware integer grouping (respects the device locale's separator) to match
                // the iOS/portal docCount rendering instead of hardcoding US-style commas.
                NumberFormat.getIntegerInstance().format(person.documentCount),
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.textPrimary,
                style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum"),
            )
            Text("docs", fontSize = 10.sp, color = c.textMuted)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchField(query: String, onQueryChange: (String) -> Unit, onSearch: () -> Unit) {
    val c = OmTheme.colors
    // Borderless field sitting directly on the page background — mirrors iOS's native
    // `.searchable` nav-bar drawer (leading magnifier + grey placeholder, no filled pill).
    TextField(
        value = query,
        onValueChange = onQueryChange,
        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null, tint = c.textMuted) },
        placeholder = { Text("Search people", color = c.textMuted) },
        singleLine = true,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = Color.Transparent,
            unfocusedContainerColor = Color.Transparent,
            disabledContainerColor = Color.Transparent,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            disabledIndicatorColor = Color.Transparent,
            cursorColor = c.accent,
            focusedTextColor = c.textPrimary,
            unfocusedTextColor = c.textPrimary,
        ),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { onSearch() }),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

@Composable
private fun PeopleEmpty(query: String) {
    val c = OmTheme.colors
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Outlined.People, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(36.dp))
        Spacer(Modifier.height(10.dp))
        Text(
            if (query.isBlank()) "No people yet" else "No matches",
            style = MaterialTheme.typography.titleSmall,
            color = c.textPrimary,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            if (query.isBlank()) "People are extracted automatically as your sources sync."
            else "Try a different name, email, or phone.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

// --- Previews -------------------------------------------------------------

private fun samplePeople() = listOf(
    PersonSummary(
        id = "self", canonicalName = "You", isSelf = true, aliasCount = 7, documentCount = 18421,
        lastSeen = "2026-06-08T11:57:00Z", sourceIds = listOf("gmail:a", "files:b", "notes:c", "events:d", "messages:e"),
    ),
    PersonSummary(
        id = "p1", canonicalName = "Maya Reeves", aliasCount = 3, documentCount = 412,
        lastSeen = "2026-06-08T10:58:00Z", interactionScoreRecent = 0.82,
        sourceIds = listOf("gmail:a", "files:b", "notes:c"),
    ),
    PersonSummary(
        id = "p2", canonicalName = "Jamie Lopez", aliasCount = 2, documentCount = 287,
        lastSeen = "2026-06-04T10:00:00Z", interactionScoreRecent = 0.41,
        sourceIds = listOf("gmail:a", "messages:e"),
    ),
    PersonSummary(
        id = "p3", canonicalName = "David Lin", aliasCount = 1, documentCount = 150,
        lastSeen = "2026-05-17T10:00:00Z", interactionScoreRecent = 0.22,
        sourceIds = listOf("files:b"),
    ),
    PersonSummary(
        id = "p4", canonicalName = "Priya Anand Chakraborty", aliasCount = 6, documentCount = 2487,
        lastSeen = "2026-06-07T10:00:00Z", interactionScoreRecent = 0.15,
        sourceIds = listOf("gmail:a", "files:b", "notes:c", "events:d", "messages:e"),
    ),
)

private val previewIconFor: (String) -> SourceIconModel = { id -> SourceIconModel(fallbackInitial = id.take(1).uppercase()) }

private fun sampleStats() = PeopleStats(pendingMergeCandidates = 133, mergeRules = 415)

@Preview(name = "People · content · dark")
@Composable
private fun PeoplePreviewDark() {
    OmnesisTheme(darkTheme = true) {
        PeopleContent(
            state = PeopleViewModel.State(people = Loadable.Content(samplePeople()), stats = sampleStats()),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> }, iconFor = previewIconFor,
        )
    }
}

@Preview(name = "People · content · light")
@Composable
private fun PeoplePreviewLight() {
    OmnesisTheme(darkTheme = false) {
        PeopleContent(
            state = PeopleViewModel.State(people = Loadable.Content(samplePeople()), stats = sampleStats()),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> }, iconFor = previewIconFor,
        )
    }
}

@Preview(name = "People · merge shortcut pills · dark")
@Composable
private fun MergeShortcutPillsPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        Column(Modifier.background(OmTheme.colors.bgPrimary)) {
            // Count edge cases that change copy/layout: typical, singular, zero, very large.
            MergeShortcuts(PeopleStats(pendingMergeCandidates = 133, mergeRules = 415), {}, {})
            MergeShortcuts(PeopleStats(pendingMergeCandidates = 1, mergeRules = 0), {}, {})
            MergeShortcuts(PeopleStats(pendingMergeCandidates = 0, mergeRules = 1), {}, {})
            MergeShortcuts(PeopleStats(pendingMergeCandidates = 12048, mergeRules = 9999), {}, {})
        }
    }
}

@Preview(name = "People · empty · dark")
@Composable
private fun PeopleEmptyPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        PeopleContent(
            state = PeopleViewModel.State(people = Loadable.Content(emptyList())),
            onOpenMenu = {}, onQueryChange = {}, onRetry = {}, onOpenPerson = { _, _ -> }, iconFor = previewIconFor,
        )
    }
}
