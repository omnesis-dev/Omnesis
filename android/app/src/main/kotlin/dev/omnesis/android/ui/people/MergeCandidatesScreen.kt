// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.MergeCandidate
import dev.omnesis.android.transport.dto.MergeCandidateCounts
import dev.omnesis.android.transport.dto.MergeCandidatesResponse
import dev.omnesis.android.transport.dto.MergeRulePerson
import dev.omnesis.android.transport.dto.MergeRuleSide
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.isReloading
import dev.omnesis.android.ui.common.PullToRefresh
import kotlinx.coroutines.launch

/**
 * Merge-candidate triage — Android counterpart of the iOS `MergeCandidatesView`
 * and a port of the portal's Candidates tab.
 *
 * Members are checked by default; untick any that aren't the same person, then
 * **Merge** unifies the rest (`POST /people/merge-candidates/merge-cluster`)
 * and **Dismiss** denies the grouping (`POST /people/merge-candidates/:id/deny`).
 * A `Pending` / `Denied` segmented filter sits at the top, and each member shows
 * its identifying attributes as calm, borderless tokens (a small uppercase type
 * label + a mono value) instead of bordered pills. Applied merges live in the
 * Merge rules tab, so there is no "Accepted" filter here.
 */
enum class MergeCandidateStatus(val label: String, val wire: String) {
    PENDING("Pending", "pending"),
    DENIED("Denied", "denied"),
}

@Composable
fun MergeCandidatesScreen(
    onBack: () -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: MergeCandidatesViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val status by vm.status.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val paging by vm.paging.collectAsStateWithLifecycle()
    MergeCandidatesContent(
        state = state,
        status = status,
        onStatusChange = vm::setStatus,
        onBack = onBack,
        onRetry = vm::load,
        onRefresh = vm::load,
        onOpenSettings = onOpenSettings,
        iconFor = vm::iconFor,
        onMerge = vm::merge,
        onDismiss = vm::dismiss,
        query = query,
        onQueryChange = vm::onQueryChange,
        paging = paging,
        onLoadMore = vm::loadMore,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MergeCandidatesContent(
    state: Loadable<MergeCandidatesResponse>,
    status: MergeCandidateStatus = MergeCandidateStatus.PENDING,
    onStatusChange: (MergeCandidateStatus) -> Unit = {},
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onRefresh: () -> Unit = onRetry,
    onOpenSettings: () -> Unit = {},
    iconFor: (String) -> SourceIconModel = { SourceIconModel() },
    /** Returns the number of rules created; throws to surface a failure banner. */
    onMerge: suspend (List<String>) -> Int = { 0 },
    onDismiss: suspend (List<String>) -> Unit = {},
    query: String = "",
    onQueryChange: (String) -> Unit = {},
    paging: CursorPagingState = CursorPagingState(),
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
                    Text("Candidates", style = MaterialTheme.typography.titleMedium, color = c.textPrimary)
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
                    context = "load merge candidates",
                    error = state.throwable,
                    onRetry = onRetry,
                    onOpenSettings = onOpenSettings,
                )
                is Loadable.Content -> {
                    PullToRefresh(refreshing = state.isReloading, onRefresh = onRefresh) {
                        MergeCandidatesList(
                            page = state.value,
                            status = status,
                            onStatusChange = onStatusChange,
                            iconFor = iconFor,
                            onMerge = onMerge,
                            onDismiss = onDismiss,
                            query = query,
                            onQueryChange = onQueryChange,
                            paging = paging,
                            onLoadMore = onLoadMore,
                        )
                    }
                }
            }
        }
    }
}

private data class Notice(val ok: Boolean, val text: String)

@Composable
private fun MergeCandidatesList(
    page: MergeCandidatesResponse,
    status: MergeCandidateStatus,
    onStatusChange: (MergeCandidateStatus) -> Unit,
    iconFor: (String) -> SourceIconModel,
    onMerge: suspend (List<String>) -> Int,
    onDismiss: suspend (List<String>) -> Unit,
    query: String,
    onQueryChange: (String) -> Unit,
    paging: CursorPagingState,
    onLoadMore: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val isPending = status == MergeCandidateStatus.PENDING
    // Per-cluster set of deselected member ids (absence = checked).
    val deselected = remember { mutableStateMapOf<String, Set<String>>() }
    val busy = remember { mutableStateMapOf<String, Boolean>() }
    // Cluster ids merged/dismissed this session — dropped optimistically since
    // the merge is eventually consistent and lingers until the gateway
    // materializes it.
    val resolved = remember { mutableStateListOf<String>() }
    val collapsed = remember { mutableStateOf(setOf<String>()) }
    val attrExpanded = remember { mutableStateOf(setOf<String>()) }
    var notice by remember { mutableStateOf<Notice?>(null) }
    val listState = rememberLazyListState()

    val q = query.trim().lowercase()
    val clusters = MergeCandidateCluster.build(page.items, dropSingletons = isPending)
        .filterNot { it.id in resolved }
        .filter { cluster ->
            if (q.isEmpty()) {
                true
            } else {
                (listOf(cluster.title) + cluster.members.map { it.canonicalName } +
                    cluster.members.flatMap { m -> m.aliases.orEmpty().map { it.alias } })
                    .joinToString(" ").lowercase().contains(q)
            }
        }

    fun checkedIds(cluster: MergeCandidateCluster): List<String> {
        val off = deselected[cluster.id].orEmpty()
        return cluster.members.map { it.id }.filterNot { it in off }
    }

    fun toggle(clusterId: String, personId: String) {
        val cur = deselected[clusterId].orEmpty()
        deselected[clusterId] = if (personId in cur) cur - personId else cur + personId
    }

    fun toggleAll(cluster: MergeCandidateCluster, allChecked: Boolean) {
        deselected[cluster.id] = if (allChecked) cluster.members.map { it.id }.toSet() else emptySet()
    }

    fun runMerge(cluster: MergeCandidateCluster) {
        val ids = checkedIds(cluster)
        if (ids.size < 2) {
            notice = Notice(false, "Select at least two identities to merge.")
            return
        }
        busy[cluster.id] = true
        notice = null
        scope.launch {
            try {
                val rules = onMerge(ids)
                deselected.remove(cluster.id)
                resolved.add(cluster.id)
                notice = Notice(true, "Merged ${ids.size} identities — $rules rule(s) created.")
            } catch (e: Exception) {
                notice = Notice(false, "Merge failed: ${e.message ?: "unknown error"}")
            } finally {
                busy[cluster.id] = false
            }
        }
    }

    fun runDismiss(cluster: MergeCandidateCluster) {
        busy[cluster.id] = true
        notice = null
        scope.launch {
            try {
                onDismiss(cluster.candidateIds)
                deselected.remove(cluster.id)
                resolved.add(cluster.id)
                notice = Notice(true, "Dismissed — won't be re-proposed.")
            } catch (e: Exception) {
                notice = Notice(false, "Dismiss failed: ${e.message ?: "unknown error"}")
            } finally {
                busy[cluster.id] = false
            }
        }
    }

    LazyColumn(
        Modifier.fillMaxWidth(),
        state = listState,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item("stats") { CandidatesStatsBar(page.counts) }
        item("hint") { CandidatesHint() }
        item("search") { MergeSearchField(query, onQueryChange, "Search clusters or identifiers") }
        item("filter") {
            MergeSegmented(
                options = MergeCandidateStatus.entries.map { it.label },
                selectedIndex = status.ordinal,
                onSelect = { onStatusChange(MergeCandidateStatus.entries[it]) },
            )
        }
        notice?.let { n -> item("notice") { NoticeBanner(n) } }
        if (clusters.isEmpty()) {
            item("empty") { CandidatesEmpty(status, query.isNotEmpty()) }
        } else {
            items(clusters, key = { it.id }) { cluster ->
                ClusterCard(
                    cluster = cluster,
                    isPending = isPending,
                    checkedCount = checkedIds(cluster).size,
                    busy = busy[cluster.id] == true,
                    expanded = cluster.id !in collapsed.value,
                    isChecked = { pid -> pid !in deselected[cluster.id].orEmpty() },
                    attrExpanded = attrExpanded.value,
                    onToggleAttrs = { key ->
                        attrExpanded.value = if (key in attrExpanded.value) attrExpanded.value - key else attrExpanded.value + key
                    },
                    onToggle = { pid -> toggle(cluster.id, pid) },
                    onToggleAll = { allChecked -> toggleAll(cluster, allChecked) },
                    onToggleCollapse = {
                        collapsed.value = if (cluster.id in collapsed.value) collapsed.value - cluster.id else collapsed.value + cluster.id
                    },
                    onMerge = { runMerge(cluster) },
                    onDismiss = { runDismiss(cluster) },
                )
            }
        }
        item("paging") {
            ListPagingFooter(
                listState = listState,
                boundaryKey = "paging",
                paging = paging,
                onLoadMore = onLoadMore,
                loadAction = "more merge candidates",
            )
        }
    }
}

@Composable
private fun CandidatesStatsBar(counts: MergeCandidateCounts) {
    val c = OmTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
        StatChip(counts.pending, "pending", valueColor = c.warning)
        StatChip(counts.denied, "denied")
    }
}

@Composable
private fun CandidatesHint() {
    Text(
        "Probable duplicates, grouped into clusters. Members are checked by default — untick any " +
            "that aren't the same person, then Merge to unify the rest. Dismiss never re-proposes a grouping.",
        fontSize = 12.sp,
        color = OmTheme.colors.textSecondary,
    )
}

@Composable
private fun NoticeBanner(notice: Notice) {
    val c = OmTheme.colors
    val tint = if (notice.ok) c.success else c.danger
    Text(
        notice.text,
        fontSize = 12.sp,
        color = tint,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(tint.copy(alpha = 0.10f))
            .border(1.dp, tint.copy(alpha = 0.4f), RoundedCornerShape(OmRadius.medium))
            .padding(OmSpacing.sm),
    )
}

@Composable
private fun ClusterCard(
    cluster: MergeCandidateCluster,
    isPending: Boolean,
    checkedCount: Int,
    busy: Boolean,
    expanded: Boolean,
    isChecked: (String) -> Boolean,
    attrExpanded: Set<String>,
    onToggleAttrs: (String) -> Unit,
    onToggle: (String) -> Unit,
    onToggleAll: (Boolean) -> Unit,
    onToggleCollapse: () -> Unit,
    onMerge: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = OmTheme.colors
    val allChecked = checkedCount == cluster.members.size
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.large))
            .background(c.bgSecondary)
            .border(1.dp, c.border, RoundedCornerShape(OmRadius.large))
            .alpha(if (busy) 0.6f else 1f),
    ) {
        // Header
        Row(
            Modifier.fillMaxWidth().padding(OmSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            PeopleAvatar(name = cluster.title, isSelf = false, size = 28.dp)
            Column(Modifier.weight(1f)) {
                Text(
                    cluster.title,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        "${cluster.members.size} ${if (cluster.members.size == 1) "entity" else "entities"}",
                        fontSize = 11.sp,
                        color = c.textMuted,
                    )
                    if (isPending) {
                        Text("$checkedCount of ${cluster.members.size} selected", fontSize = 11.sp, color = c.accent)
                    }
                }
            }
            if (isPending) {
                Text(
                    if (allChecked) "Uncheck all" else "Check all",
                    fontSize = 11.5.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textSecondary,
                    modifier = Modifier.clickable(enabled = !busy) { onToggleAll(allChecked) },
                )
            }
            Icon(
                if (expanded) Icons.Outlined.ExpandMore else Icons.Outlined.ExpandLess,
                contentDescription = null,
                tint = c.textMuted,
                modifier = Modifier.size(18.dp).clickable(onClick = onToggleCollapse),
            )
        }
        if (expanded) {
            HorizontalDivider(color = c.borderLight)
            cluster.members.forEachIndexed { index, member ->
                if (index > 0) HorizontalDivider(color = c.borderLight)
                MemberRow(
                    cluster = cluster,
                    member = member,
                    isPending = isPending,
                    checked = isChecked(member.id),
                    enabled = !busy,
                    attrExpanded = attrExpanded,
                    onToggleAttrs = onToggleAttrs,
                    onToggle = { onToggle(member.id) },
                )
            }
            if (isPending) {
                Box(Modifier.padding(OmSpacing.md)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm), modifier = Modifier.fillMaxWidth()) {
                        Button(
                            onClick = onMerge,
                            enabled = !busy && checkedCount >= 2,
                            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = Color.White),
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Merge $checkedCount", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                        }
                        OutlinedButton(
                            onClick = onDismiss,
                            enabled = !busy,
                            modifier = Modifier.weight(1f),
                        ) {
                            Text("Dismiss", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = c.danger)
                        }
                    }
                    if (busy) {
                        OmSpinner(
                            color = c.accent,
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(20.dp).align(Alignment.Center),
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MemberRow(
    cluster: MergeCandidateCluster,
    member: MergeRulePerson,
    isPending: Boolean,
    checked: Boolean,
    enabled: Boolean,
    attrExpanded: Set<String>,
    onToggleAttrs: (String) -> Unit,
    onToggle: () -> Unit,
) {
    val c = OmTheme.colors
    val name = member.canonicalName.ifBlank { "(unnamed)" }
    val attrs = sortedAliases(member)
    val key = "${cluster.id}:${member.id}"
    val expanded = key in attrExpanded
    val shown = if (expanded) attrs else attrs.take(ATTR_LIMIT)
    val hidden = attrs.size - shown.size
    Row(
        Modifier.fillMaxWidth().padding(OmSpacing.md),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        if (isPending) {
            Checkbox(
                checked = checked,
                onCheckedChange = { onToggle() },
                enabled = enabled,
                colors = CheckboxDefaults.colors(checkedColor = c.accent, uncheckedColor = c.textMuted),
                modifier = Modifier.size(20.dp),
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(
                name,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                color = if (checked) c.textPrimary else c.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                shown.forEach { AttrToken(it) }
                if (attrs.size > ATTR_LIMIT) {
                    Text(
                        if (expanded) "show less" else "+$hidden more",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = c.accent,
                        modifier = Modifier.clickable { onToggleAttrs(key) },
                    )
                }
            }
        }
    }
}

@Composable
private fun AttrToken(attr: MergeRuleSide) {
    val c = OmTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Text(
            attr.aliasType.uppercase(),
            fontSize = 9.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.5.sp,
            color = c.textMuted,
        )
        Text(attr.alias, fontSize = 11.sp, fontFamily = FontFamily.Monospace, color = c.textSecondary)
    }
}

private const val ATTR_LIMIT = 4

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

/** A member's aliases, strongest first (email > phone > lid > name). */
private fun sortedAliases(member: MergeRulePerson): List<MergeRuleSide> {
    val rank = mapOf("email" to 0, "phone" to 1, "lid" to 2, "name" to 3)
    return member.aliases.orEmpty().sortedWith(compareBy({ rank[it.aliasType] ?: 9 }, { it.alias }))
}

@Composable
private fun CandidatesEmpty(status: MergeCandidateStatus, searching: Boolean) {
    val c = OmTheme.colors
    val icon = when (status) {
        MergeCandidateStatus.PENDING -> Icons.Outlined.CheckCircle
        MergeCandidateStatus.DENIED -> Icons.Outlined.Block
    }
    val title = when {
        searching -> "No matching clusters"
        status == MergeCandidateStatus.PENDING -> "No pending candidates"
        else -> "Nothing dismissed yet"
    }
    val body = when {
        searching -> "No clusters match your search."
        status == MergeCandidateStatus.PENDING -> "The fuzzy detector hasn't found any probable duplicates you haven't already decided on."
        else -> "Clusters you dismiss won't be re-proposed, and are listed here."
    }
    Column(
        Modifier.fillMaxWidth().padding(vertical = 32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(36.dp))
        Spacer(Modifier.height(10.dp))
        Text(title, style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
        Spacer(Modifier.height(4.dp))
        Text(body, style = MaterialTheme.typography.bodySmall, color = c.textSecondary, textAlign = TextAlign.Center)
    }
}

// --- Cluster model ---------------------------------------------------------

/**
 * A connected-component cluster of candidate pairs: its de-duplicated member
 * people plus the candidate ids that bridge them (needed to deny the whole
 * grouping). Built from the flat candidate list, preserving API order.
 */
data class MergeCandidateCluster(
    val id: String,
    val members: List<MergeRulePerson>,
    val candidateIds: List<String>,
) {
    /** A name-like member's name for the card title; falls back to any member. */
    val title: String
        get() {
            val named = members.firstOrNull { it.canonicalName.contains(" ") && !it.canonicalName.contains("@") }
            return named?.canonicalName ?: members.firstOrNull()?.canonicalName?.ifBlank { null } ?: "Unknown"
        }

    companion object {
        fun build(candidates: List<MergeCandidate>, dropSingletons: Boolean = true): List<MergeCandidateCluster> {
            val order = mutableListOf<String>()
            val memberOrder = mutableMapOf<String, MutableList<String>>()
            val members = mutableMapOf<String, MutableMap<String, MergeRulePerson>>()
            val candidateIds = mutableMapOf<String, MutableList<String>>()
            for (cand in candidates) {
                val cid = cand.clusterId ?: cand.id
                if (cid !in members) {
                    order.add(cid)
                    memberOrder[cid] = mutableListOf()
                    members[cid] = mutableMapOf()
                    candidateIds[cid] = mutableListOf()
                }
                candidateIds[cid]!!.add(cand.id)
                for (p in cand.resolvedSideA + cand.resolvedSideB) {
                    if (p.id !in members[cid]!!) {
                        memberOrder[cid]!!.add(p.id)
                        members[cid]!![p.id] = p
                    }
                }
            }
            return order.map { cid ->
                MergeCandidateCluster(
                    id = cid,
                    members = memberOrder[cid]!!.mapNotNull { members[cid]!![it] },
                    candidateIds = candidateIds[cid]!!,
                )
                // In the pending queue a single-identity cluster has nothing to
                // merge (both sides resolved to the same person, e.g. already
                // merged) — drop it. The accepted/denied views are read-only
                // audits, so they keep the collapsed singletons.
            }.filter { if (dropSingletons) it.members.size >= 2 else it.members.isNotEmpty() }
        }
    }
}

// --- Previews --------------------------------------------------------------

private val previewIconFor: (String) -> SourceIconModel = { id -> SourceIconModel(fallbackInitial = id.take(1).uppercase()) }

private fun sampleCandidates() = listOf(
    MergeCandidate(
        id = "cand-1",
        clusterId = "cl-maya",
        resolvedSideA = listOf(
            MergeRulePerson(
                "p-maya", "Maya Reeves",
                aliases = listOf(
                    MergeRuleSide("email", "maya.reeves@example.com"),
                    MergeRuleSide("phone", "+1 (555) 010-0142"),
                    MergeRuleSide("name", "Maya Reeves"),
                ),
                sourceIds = listOf("gmail:a", "notes:c"),
            ),
        ),
        resolvedSideB = listOf(
            MergeRulePerson(
                "p-maya-chat", "Maya",
                aliases = listOf(
                    MergeRuleSide("email", "maya.r.chat@example.com"),
                    MergeRuleSide("phone", "+1 (555) 010-0143"),
                    MergeRuleSide("lid", "88120104412233"),
                    MergeRuleSide("lid", "77001920104998"),
                    MergeRuleSide("name", "Maya"),
                ),
                sourceIds = listOf("messages:e"),
            ),
        ),
    ),
    MergeCandidate(
        id = "cand-2",
        clusterId = "cl-david",
        resolvedSideA = listOf(
            MergeRulePerson(
                "p-david", "David Lin",
                aliases = listOf(MergeRuleSide("email", "david.lin@example.com"), MergeRuleSide("name", "David Lin")),
                sourceIds = listOf("gmail:a"),
            ),
        ),
        resolvedSideB = listOf(
            MergeRulePerson(
                "p-david-work", "d.lin",
                aliases = listOf(MergeRuleSide("email", "d.lin@stellarsound.example.com"), MergeRuleSide("name", "d.lin")),
                sourceIds = listOf("imap:w"),
            ),
        ),
    ),
)

private fun samplePage() = MergeCandidatesResponse(
    items = sampleCandidates(),
    counts = MergeCandidateCounts(pending = 14, accepted = 12, denied = 4),
)

@Preview(name = "Merge candidates · content · dark")
@Composable
private fun MergeCandidatesPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        MergeCandidatesContent(state = Loadable.Content(samplePage()), onBack = {}, onRetry = {}, iconFor = previewIconFor)
    }
}

@Preview(name = "Merge candidates · content · light")
@Composable
private fun MergeCandidatesPreviewLight() {
    OmnesisTheme(darkTheme = false) {
        MergeCandidatesContent(state = Loadable.Content(samplePage()), onBack = {}, onRetry = {}, iconFor = previewIconFor)
    }
}

@Preview(name = "Merge candidates · empty · dark")
@Composable
private fun MergeCandidatesEmptyPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        MergeCandidatesContent(
            state = Loadable.Content(MergeCandidatesResponse(counts = MergeCandidateCounts(pending = 0, accepted = 12, denied = 4))),
            onBack = {}, onRetry = {}, iconFor = previewIconFor,
        )
    }
}
