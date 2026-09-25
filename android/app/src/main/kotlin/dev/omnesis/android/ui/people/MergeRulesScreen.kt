// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.CallMerge
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
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
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.MergeRule
import dev.omnesis.android.transport.dto.MergeRuleGroup
import dev.omnesis.android.transport.dto.MergeRulePerson
import dev.omnesis.android.transport.dto.MergeRuleSide
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.isReloading
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.PullToRefresh

/**
 * Read-only merge-rules audit — Android counterpart of the iOS `MergeRulesView`
 * and a port of the portal's Merge rules tab.
 *
 * Each row is a *merged identity* (the surviving canonical person); expanding it
 * reveals the source aliases that were merged into it — the aliases that
 * triggered each merge. A `User` / `System` segmented filter sits at the top
 * (the per-row trigger badge is gone), alongside a search field. Delete / undo
 * stay in the portal.
 */
@Composable
fun MergeRulesScreen(
    onBack: () -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: MergeRulesViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val paging by vm.paging.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val filter by vm.filter.collectAsStateWithLifecycle()
    MergeRulesContent(
        state = state,
        paging = paging,
        query = query,
        filter = filter,
        onQueryChange = vm::onQueryChange,
        onFilterChange = vm::onFilterChange,
        onLoadMore = vm::loadMore,
        onBack = onBack,
        onRetry = vm::load,
        onRefresh = vm::load,
        onOpenSettings = onOpenSettings,
        iconFor = vm::iconFor,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MergeRulesContent(
    state: Loadable<List<MergeIdentity>>,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onRefresh: () -> Unit = onRetry,
    onOpenSettings: () -> Unit = {},
    iconFor: (String) -> SourceIconModel = { SourceIconModel() },
    paging: CursorPagingState = CursorPagingState(),
    query: String = "",
    filter: MergeTriggerFilter = MergeTriggerFilter.ALL,
    onQueryChange: (String) -> Unit = {},
    onFilterChange: (MergeTriggerFilter) -> Unit = {},
    onLoadMore: () -> Unit = {},
) {
    val c = OmTheme.colors
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back", tint = c.textPrimary)
                    }
                },
                title = {
                    Text("Merge rules", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = c.bgPrimary,
                    scrolledContainerColor = c.bgPrimary,
                ),
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize().background(c.bgPrimary)) {
            when (state) {
                Loadable.Loading -> LoadingView()
                is Loadable.Error -> GatewayErrorView(
                    context = "load merge rules",
                    error = state.throwable,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                is Loadable.Content -> {
                    if (
                        state.value.isEmpty() &&
                        query.isBlank() &&
                        filter == MergeTriggerFilter.ALL
                    ) {
                        MergeRulesEmpty()
                    } else {
                        PullToRefresh(refreshing = state.isReloading, onRefresh = onRefresh) {
                            MergeRulesList(
                                identities = state.value,
                                iconFor = iconFor,
                                query = query,
                                filter = filter,
                                paging = paging,
                                onQueryChange = onQueryChange,
                                onFilterChange = onFilterChange,
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
private fun MergeRulesList(
    identities: List<MergeIdentity>,
    iconFor: (String) -> SourceIconModel,
    query: String,
    filter: MergeTriggerFilter,
    paging: CursorPagingState,
    onQueryChange: (String) -> Unit,
    onFilterChange: (MergeTriggerFilter) -> Unit,
    onLoadMore: () -> Unit,
) {
    val collapsed = remember { mutableStateOf(setOf<String>()) }
    val listState = rememberLazyListState()

    LazyColumn(
        Modifier.fillMaxWidth(),
        state = listState,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item("stats") { MergeRulesStatsBar(identities, paging.countIsPartial) }
        item("search") { MergeSearchField(query, onQueryChange, "Search people or emails") }
        item("filter") {
            MergeSegmented(
                options = MergeTriggerFilter.entries.map { it.label },
                selectedIndex = filter.ordinal,
                onSelect = { onFilterChange(MergeTriggerFilter.entries[it]) },
            )
        }
        if (identities.isEmpty()) {
            item("nomatch") { NoMatchRow() }
        } else {
            items(identities, key = { it.id }) { identity ->
                MergeIdentityCard(
                    identity = identity,
                    expanded = identity.id !in collapsed.value,
                    onToggle = {
                        collapsed.value = if (identity.id in collapsed.value) {
                            collapsed.value - identity.id
                        } else {
                            collapsed.value + identity.id
                        }
                    },
                    iconFor = iconFor,
                )
            }
        }
        item("paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "paging",
                paging = paging,
                onLoadMore = onLoadMore,
                loadAction = "more merge rules",
            )
        }
    }
}

@Composable
private fun NoMatchRow() {
    Text(
        "No merge rules match the current search or filter.",
        fontSize = 12.sp,
        color = OmTheme.colors.textMuted,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().padding(vertical = OmSpacing.xl),
    )
}

@Composable
private fun MergeRulesStatsBar(identities: List<MergeIdentity>, partial: Boolean) {
    val summary = mergeRulesSummary(identities, partial)
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.xs)) {
        // Partiality is its own caption rather than a suffix on each noun, so the chips keep
        // reading as bare counts however many pages have loaded.
        if (summary.partial) {
            Text(
                "LOADED RESULTS",
                fontSize = 9.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.5.sp,
                color = OmTheme.colors.textMuted,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
            StatChip(summary.groupCount, countLabel(summary.groupCount, "group"))
            StatChip(summary.ruleCount, countLabel(summary.ruleCount, "rule"))
            StatChip(summary.userCount, "user")
            StatChip(summary.systemCount, "system")
        }
    }
}

internal data class MergeRulesSummary(
    val groupCount: Int,
    val ruleCount: Int,
    val userCount: Int,
    val systemCount: Int,
    val partial: Boolean,
)

/**
 * The gateway returns no aggregate totals for `/people/merge-rule-groups`, so every count is
 * derived from the groups loaded so far. [userCount] and [systemCount] count *groups* carrying
 * that trigger kind, and a group holding both a user-issued and a system-inferred rule counts in
 * both — so they need not sum to [groupCount], nor relate to [ruleCount].
 */
internal fun mergeRulesSummary(
    identities: List<MergeIdentity>,
    partial: Boolean,
): MergeRulesSummary = MergeRulesSummary(
    groupCount = identities.size,
    ruleCount = identities.sumOf { it.sources.size },
    userCount = identities.count { MergeTriggerFilter.USER.kind in it.kinds },
    systemCount = identities.count { MergeTriggerFilter.SYSTEM.kind in it.kinds },
    partial = partial,
)

private fun countLabel(count: Int, noun: String): String = if (count == 1) noun else "${noun}s"

@Composable
private fun StatChip(value: Int, label: String, valueColor: Color = OmTheme.colors.textPrimary) {
    val c = OmTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            value.toString(),
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            color = valueColor,
            style = TextStyle(fontFeatureSettings = "tnum"),
        )
        Text(label, fontSize = 12.sp, color = c.textMuted)
    }
}

// --- Trigger filter --------------------------------------------------------

enum class MergeTriggerFilter(val label: String, val kind: String?) {
    ALL("All", null),
    USER("User", "user"),
    SYSTEM("System", "system"),
}

// --- Merged-identity model -------------------------------------------------

/**
 * A surviving canonical identity and the source aliases merged into it. Built
 * from the flat rule list (filtered by trigger + search), grouping every rule
 * by its winner person — mirrors the portal's `buildIdentities`.
 */
data class MergeIdentity(
    val id: String,
    val person: MergeRulePerson?,
    val name: String,
    val canonicalEmail: String?,
    val latest: String?,
    val kinds: Set<String>,
    val sources: List<Source>,
) {
    data class Source(
        val ruleId: String,
        val alias: String,
        val aliasType: String,
        val name: String?,
        val sourceIds: List<String>,
        /**
         * Why the rule exists — user-entered, or the system tier's
         * (auto-approval / background-agent adjudication) rationale.
         */
        val reason: String?,
    )

    companion object {
        operator fun invoke(group: MergeRuleGroup): MergeIdentity = MergeIdentity(
            id = group.key,
            person = group.person,
            name = group.name,
            canonicalEmail = group.canonicalEmail,
            latest = group.latest,
            kinds = group.kinds.toSet(),
            sources = group.sources.map {
                Source(
                    ruleId = it.ruleId,
                    alias = it.alias,
                    aliasType = it.aliasType,
                    name = it.name,
                    sourceIds = it.sourceIds,
                    reason = it.reason,
                )
            },
        )

        private fun bestEmail(person: MergeRulePerson?): String? =
            person?.aliases?.firstOrNull { it.aliasType == "email" }?.alias

        fun build(rules: List<MergeRule>, filter: MergeTriggerFilter, query: String): List<MergeIdentity> {
            val q = query.trim().lowercase()
            data class Acc(
                var person: MergeRulePerson?,
                var name: String,
                var canonicalEmail: String?,
                var latest: String?,
                val kinds: MutableSet<String>,
                val sources: MutableList<Source>,
            )
            val order = mutableListOf<String>()
            val byKey = mutableMapOf<String, Acc>()

            for (rule in rules) {
                if (filter.kind != null && rule.kind != filter.kind) continue

                val winnerIsA = rule.winnerSide == "a"
                val winner = (if (winnerIsA) rule.resolvedSideA else rule.resolvedSideB)?.firstOrNull()
                val loser = (if (winnerIsA) rule.resolvedSideB else rule.resolvedSideA)?.firstOrNull()
                val winnerSide = if (winnerIsA) rule.sideA else rule.sideB
                val loserSide = if (winnerIsA) rule.sideB else rule.sideA

                // Skip a rule already collapsed onto a single identity.
                if (winner != null && loser != null && winner.id == loser.id) continue

                if (q.isNotEmpty()) {
                    val hay = listOfNotNull(
                        winner?.canonicalName, loser?.canonicalName,
                        bestEmail(winner), loserSide.alias, winnerSide.alias,
                    ).joinToString(" ").lowercase()
                    if (!hay.contains(q)) continue
                }

                val key = winner?.id ?: "${winnerSide.aliasType}=${winnerSide.alias}"
                val displayName = winner?.canonicalName?.ifBlank { null }
                    ?: "${winnerSide.aliasType}=${winnerSide.alias}"
                val source = Source(
                    ruleId = rule.id,
                    alias = loserSide.alias,
                    aliasType = loserSide.aliasType,
                    name = loser?.canonicalName?.ifBlank { null },
                    sourceIds = loser?.sourceIds.orEmpty(),
                    reason = rule.reason?.ifBlank { null },
                )

                val acc = byKey[key]
                if (acc == null) {
                    order.add(key)
                    byKey[key] = Acc(
                        person = winner,
                        name = displayName,
                        canonicalEmail = bestEmail(winner),
                        latest = rule.createdAt,
                        kinds = mutableSetOf(rule.kind),
                        sources = mutableListOf(source),
                    )
                } else {
                    acc.sources.add(source)
                    acc.kinds.add(rule.kind)
                    val created = rule.createdAt
                    if (created != null && (acc.latest ?: "") < created) acc.latest = created
                }
                if (byKey[key]?.canonicalEmail == null && loserSide.aliasType == "email") {
                    byKey[key]?.canonicalEmail = loserSide.alias
                }
            }

            return order.mapNotNull { key ->
                byKey[key]?.let { acc ->
                    MergeIdentity(
                        key,
                        acc.person,
                        acc.name,
                        acc.canonicalEmail,
                        acc.latest,
                        acc.kinds,
                        acc.sources,
                    )
                }
            }
        }
    }
}

// --- Identity card ---------------------------------------------------------

@Composable
private fun MergeIdentityCard(
    identity: MergeIdentity,
    expanded: Boolean,
    onToggle: () -> Unit,
    iconFor: (String) -> SourceIconModel,
) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.large))
            .background(c.bgSecondary)
            .border(1.dp, c.border, RoundedCornerShape(OmRadius.large)),
    ) {
        // Header
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggle)
                .padding(OmSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            Icon(
                if (expanded) Icons.Outlined.ExpandMore else Icons.Outlined.ExpandLess,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(16.dp),
            )
            PeopleAvatar(name = identity.name, isSelf = false, size = 28.dp)
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        identity.name,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (identity.person == null) c.textSecondary else c.accent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Text(
                        "${identity.sources.size} ${if (identity.sources.size == 1) "rule" else "rules"}",
                        fontSize = 10.5.sp,
                        color = c.textMuted,
                    )
                }
                identity.canonicalEmail?.let { email ->
                    Text(
                        email,
                        fontSize = 11.sp,
                        fontFamily = FontFamily.Monospace,
                        color = c.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            identity.latest?.let { personRelativeTime(it) }?.let { ago ->
                Text(ago, fontSize = 11.sp, color = c.textMuted)
            }
        }
        if (expanded) {
            identity.sources.forEach { source ->
                HorizontalDivider(color = c.borderLight)
                SourceRow(source, iconFor)
            }
        }
    }
}

@Composable
private fun SourceRow(source: MergeIdentity.Source, iconFor: (String) -> SourceIconModel) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = OmSpacing.lg, end = OmSpacing.md, top = OmSpacing.sm, bottom = OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        Text("↳", fontSize = 12.sp, color = c.textMuted)
        Column(Modifier.weight(1f)) {
            Text(
                source.alias,
                fontSize = 11.5.sp,
                fontFamily = FontFamily.Monospace,
                color = c.textSecondary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            source.name?.let {
                Text(it, fontSize = 10.5.sp, color = c.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            source.reason?.let {
                Text(
                    it,
                    fontSize = 10.5.sp,
                    color = c.textMuted,
                    fontStyle = FontStyle.Italic,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        source.sourceIds.takeIf { it.isNotEmpty() }?.let { ids ->
            PersonSourceStrip(sourceIds = ids, iconFor = iconFor, max = 4, size = 13.dp)
        }
    }
}

// --- Shared toolbar widgets ------------------------------------------------

/** Search field styled to the portal's `.search-input`. Shared with Candidates. */
@Composable
internal fun MergeSearchField(query: String, onQueryChange: (String) -> Unit, placeholder: String) {
    val c = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(c.bgTertiary)
            .border(1.dp, c.border, RoundedCornerShape(OmRadius.medium))
            .padding(horizontal = 10.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Outlined.Search, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(15.dp))
        Box(Modifier.weight(1f)) {
            if (query.isEmpty()) {
                Text(placeholder, fontSize = 14.sp, color = c.textMuted)
            }
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                textStyle = TextStyle(color = c.textPrimary, fontSize = 14.sp),
                cursorBrush = SolidColor(c.accent),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** Segmented control matching the iOS native picker look (active segment = bgPrimary). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MergeSegmented(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    val c = OmTheme.colors
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        options.forEachIndexed { i, label ->
            SegmentedButton(
                selected = i == selectedIndex,
                onClick = { onSelect(i) },
                shape = SegmentedButtonDefaults.itemShape(i, options.size),
                icon = {},
                colors = SegmentedButtonDefaults.colors(
                    activeContainerColor = c.bgPrimary,
                    activeContentColor = c.textPrimary,
                    activeBorderColor = c.border,
                    inactiveContainerColor = Color.Transparent,
                    inactiveContentColor = c.textSecondary,
                    inactiveBorderColor = c.border,
                ),
            ) {
                Text(label, fontSize = 13.sp, fontWeight = FontWeight.Medium)
            }
        }
    }
}

@Composable
private fun MergeRulesEmpty() {
    val c = OmTheme.colors
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(Icons.Outlined.CallMerge, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(36.dp))
        Spacer(Modifier.height(10.dp))
        Text("No merge rules", style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
        Spacer(Modifier.height(4.dp))
        Text(
            "Your people graph has no applied merges yet. Auto-detected duplicates and operator-issued merges show up here.",
            style = MaterialTheme.typography.bodySmall,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
        )
    }
}

// --- Previews --------------------------------------------------------------

private val previewIconFor: (String) -> SourceIconModel = { id -> SourceIconModel(fallbackInitial = id.take(1).uppercase()) }

private fun sampleRules(): List<MergeRule> = listOf(
    MergeRule(
        id = "r-user",
        kind = "user",
        sideA = MergeRuleSide("email", "maya.reeves@example.com"),
        sideB = MergeRuleSide("phone", "+1 (555) 010-0042"),
        winnerSide = "a",
        reason = "same person, work + mobile",
        resolvedSideA = listOf(
            MergeRulePerson("p-maya", "Maya Reeves", aliases = listOf(MergeRuleSide("email", "maya.reeves@example.com")), sourceIds = listOf("gmail:a", "notes:c")),
        ),
        resolvedSideB = listOf(
            MergeRulePerson("p-maya-ph", "Maya (mobile)", sourceIds = listOf("messages:e"), mergedIntoCanonicalName = "Maya Reeves"),
        ),
    ),
    MergeRule(
        id = "r-system",
        kind = "system",
        sideA = MergeRuleSide("name", "Jamie Lopez"),
        sideB = MergeRuleSide("email", "jamie.lopez@example.org"),
        winnerSide = "b",
        reason = "exact-name auto-detect",
        resolvedSideA = listOf(
            MergeRulePerson("p-jamie-n", "Jamie Lopez", sourceIds = listOf("files:b"), mergedIntoCanonicalName = "jamie.lopez@example.org"),
        ),
        resolvedSideB = listOf(
            MergeRulePerson("p-jamie", "Jamie Lopez", aliases = listOf(MergeRuleSide("email", "jamie.lopez@example.org")), sourceIds = listOf("gmail:a")),
        ),
    ),
    MergeRule(
        id = "c-a", kind = "user", groupId = "grp",
        sideA = MergeRuleSide("email", "david.lin@example.com"),
        sideB = MergeRuleSide("name", "David Lin"),
        winnerSide = "a",
        resolvedSideA = listOf(MergeRulePerson("p-david", "David Lin", aliases = listOf(MergeRuleSide("email", "david.lin@example.com")), sourceIds = listOf("gmail:a"))),
        resolvedSideB = listOf(MergeRulePerson("p-david-n", "d.lin", sourceIds = listOf("messages:e"), mergedIntoCanonicalName = "David Lin")),
    ),
    MergeRule(
        id = "c-b", kind = "user", groupId = "grp",
        sideA = MergeRuleSide("email", "david.lin@example.com"),
        sideB = MergeRuleSide("email", "d.lin@stellarsound.example.com"),
        winnerSide = "a",
        resolvedSideA = listOf(MergeRulePerson("p-david", "David Lin", aliases = listOf(MergeRuleSide("email", "david.lin@example.com")), sourceIds = listOf("gmail:a"))),
        resolvedSideB = listOf(MergeRulePerson("p-david-alt", "d.lin (work)", sourceIds = listOf("imap:w"), mergedIntoCanonicalName = "David Lin")),
    ),
)

@Preview(name = "Merge rules · content · dark")
@Composable
private fun MergeRulesPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        MergeRulesContent(
            state = Loadable.Content(MergeIdentity.build(sampleRules(), MergeTriggerFilter.ALL, "")),
            onBack = {}, onRetry = {}, iconFor = previewIconFor,
        )
    }
}

@Preview(name = "Merge rules · content · light")
@Composable
private fun MergeRulesPreviewLight() {
    OmnesisTheme(darkTheme = false) {
        MergeRulesContent(
            state = Loadable.Content(MergeIdentity.build(sampleRules(), MergeTriggerFilter.ALL, "")),
            onBack = {}, onRetry = {}, iconFor = previewIconFor,
        )
    }
}

@Preview(name = "Merge rules · empty · dark")
@Composable
private fun MergeRulesEmptyPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        MergeRulesContent(
            state = Loadable.Content(emptyList()),
            onBack = {}, onRetry = {}, iconFor = previewIconFor,
        )
    }
}
