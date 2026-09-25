// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.PrivacyPolicyFamilySummary
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.PullToRefresh
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Locale
import javax.inject.Inject

/** The characters of a revision digest a row shows: enough to tell two apart, not the digest. */
private const val SHORT_REVISION_LENGTH = 12

/** One live policy family, as the list presents it. [name] is null for a family with no name. */
data class PolicyFamilyRow(
    val id: String,
    val name: String?,
    val shortRevision: String,
    val grantCount: Int,
    val isDefault: Boolean,
) {
    val title: String get() = name ?: "Policy"
}

/**
 * [loading] is a read with nothing cached to show meanwhile; [refreshing] is a pull with
 * cached rows underneath. An [error] beside cached rows is a failed refresh: the rows stay
 * and the failure is a banner, not a blank page.
 */
data class PoliciesListUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val policies: List<PolicyFamilyRow> = emptyList(),
    val error: Throwable? = null,
)

/**
 * The rows for the families the gateway listed. Archived families and families with no id
 * are left out, a repeated id keeps its first summary, the default comes first, and the
 * rest follow by name in a locale-independent order with the id as the tiebreak.
 */
internal fun policyFamilyRows(
    families: List<PrivacyPolicyFamilySummary>,
    defaultFamilyId: String?,
): List<PolicyFamilyRow> {
    val defaultId = defaultFamilyId?.trim()?.takeIf { it.isNotEmpty() }
    return families
        .filter { it.archivedAt == null }
        .mapNotNull { family ->
            val id = family.id.trim().takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            PolicyFamilyRow(
                id = id,
                name = family.name.trim().takeIf { it.isNotEmpty() },
                shortRevision = family.currentRevision.trim().take(SHORT_REVISION_LENGTH),
                grantCount = family.affectedGrantIds.size,
                isDefault = id == defaultId,
            )
        }
        .distinctBy { it.id }
        .sortedWith(
            compareBy<PolicyFamilyRow> { !it.isDefault }
                .thenBy { it.title.lowercase(Locale.ROOT) }
                .thenBy { it.id },
        )
}

/**
 * Which family the list marks as the default after a read of the access overview. A read
 * that succeeded is the truth, including one that names no default; a read that failed
 * leaves the last known marker in place, so a flaky overview does not make the mark flicker.
 */
internal fun defaultFamilyMarker(previous: String?, overview: Result<String?>): String? =
    overview.fold(onSuccess = { it }, onFailure = { previous })

internal fun grantsGovernedLabel(count: Int): String = when (count) {
    0 -> "governs no grant yet"
    1 -> "governs 1 grant"
    else -> "governs $count grants"
}

/** The revision in force and the grants it governs; a family with no revision yet names only the grants. */
internal fun policyRowCaption(policy: PolicyFamilyRow): String = listOfNotNull(
    policy.shortRevision.takeIf { it.isNotBlank() }?.let { "Revision $it" },
    grantsGovernedLabel(policy.grantCount),
).joinToString(" · ")

@HiltViewModel
class PoliciesListViewModel @Inject constructor(
    private val session: SessionManager,
) : ViewModel() {
    private val _state = MutableStateFlow(PoliciesListUiState())
    val state = _state.asStateFlow()
    private var generation = 0L
    private var families: List<PrivacyPolicyFamilySummary> = emptyList()
    private var defaultFamilyId: String? = null

    /** A read the screen asks for on its own — on resume — which shows nothing over cached rows. */
    fun reload() = load(userInitiated = false)

    /** A read the operator asked for, shown as a refresh over the cached rows. */
    fun refresh() = load(userInitiated = true)

    private fun load(userInitiated: Boolean) {
        val request = ++generation
        val current = _state.value
        _state.value = current.copy(
            loading = current.policies.isEmpty(),
            refreshing = userInitiated && current.policies.isNotEmpty(),
            error = null,
        )
        viewModelScope.launch {
            val admin = runCatching { session.requireSession().admin }
            val (listed, overview) = admin.fold(
                onSuccess = { client ->
                    coroutineScope {
                        val listed = async { runCatching { client.privacyPolicyFamilies() } }
                        val overview = async { runCatching { client.accessOverview().defaultPolicyFamilyId } }
                        listed.await() to overview.await()
                    }
                },
                onFailure = { Result.failure<List<PrivacyPolicyFamilySummary>>(it) to Result.failure(it) },
            )
            if (request != generation) return@launch
            defaultFamilyId = defaultFamilyMarker(defaultFamilyId, overview)
            listed.fold(
                onSuccess = {
                    families = it
                    _state.value = PoliciesListUiState(
                        loading = false,
                        policies = policyFamilyRows(families, defaultFamilyId),
                    )
                },
                onFailure = {
                    _state.value = _state.value.copy(
                        loading = false,
                        refreshing = false,
                        policies = policyFamilyRows(families, defaultFamilyId),
                        error = it,
                    )
                },
            )
        }
    }
}

/**
 * Every live policy family, under Settings beside the grants that name them.
 * A policy is a rule an answer is judged by, not an event that happened, which
 * is why it is not on the Privacy feed. It is re-read each time the screen resumes,
 * since a policy edited on the portal while the phone was away would otherwise stay stale.
 */
@Composable
fun PoliciesListScreen(
    onBack: () -> Unit,
    onOpenPolicy: (familyId: String, name: String?) -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: PoliciesListViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    LifecycleResumeEffect(Unit) {
        vm.reload()
        onPauseOrDispose { }
    }
    PoliciesListContent(
        state = state,
        onBack = onBack,
        onOpenPolicy = onOpenPolicy,
        onRetry = vm::reload,
        onRefresh = vm::refresh,
        onOpenSettings = onOpenSettings,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PoliciesListContent(
    state: PoliciesListUiState,
    onBack: () -> Unit,
    onOpenPolicy: (familyId: String, name: String?) -> Unit = { _, _ -> },
    onRetry: () -> Unit = {},
    onRefresh: () -> Unit = onRetry,
    onOpenSettings: () -> Unit = {},
) {
    val c = OmTheme.colors
    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Outlined.ArrowBack,
                            contentDescription = "Back to Settings",
                            tint = c.accent,
                        )
                    }
                },
                title = { Text("Policies") },
            )
        },
    ) { padding ->
        when {
            state.loading && state.policies.isEmpty() -> LoadingView(Modifier.padding(padding))
            state.error != null && state.policies.isEmpty() -> GatewayErrorView(
                context = "load the privacy policies",
                error = state.error,
                onRetry = onRetry,
                onOpenSettings = onOpenSettings,
                modifier = Modifier.padding(padding),
            )
            else -> PullToRefresh(
                refreshing = state.refreshing,
                onRefresh = onRefresh,
                modifier = Modifier
                    .padding(padding)
                    .background(c.bgPrimary),
            ) {
                PoliciesListPane(
                    policies = state.policies,
                    staleMessage = state.error?.let { "Could not refresh the policies: ${privacyErrorMessage(it)}" },
                    onOpenPolicy = onOpenPolicy,
                )
            }
        }
    }
}

@Composable
private fun PoliciesListPane(
    policies: List<PolicyFamilyRow>,
    staleMessage: String?,
    onOpenPolicy: (familyId: String, name: String?) -> Unit,
) {
    val c = OmTheme.colors
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        staleMessage?.let { message ->
            item("stale") { PrivacyBanner(message, PrivacyBannerKind.ERROR) }
        }
        item("intro") {
            Text(
                "Each grant names the policy its answers are judged by. Policies can only be " +
                    "edited on the web portal.",
                style = MaterialTheme.typography.bodyMedium,
                color = c.textPrimary,
                modifier = Modifier.padding(bottom = OmSpacing.xs),
            )
        }
        if (policies.isEmpty()) {
            item("empty") {
                PrivacyEmptyState(
                    title = "No policies yet",
                    message = "A policy created on the web portal appears here.",
                )
            }
        }
        items(policies, key = { it.id }) { policy ->
            PolicyFamilyRowCard(policy, onClick = { onOpenPolicy(policy.id, policy.name) })
        }
    }
}

@Composable
private fun PolicyFamilyRowCard(policy: PolicyFamilyRow, onClick: () -> Unit) {
    val c = OmTheme.colors
    val shape = RoundedCornerShape(OmRadius.large)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.bgSecondary)
            .border(1.dp, c.border, shape)
            .clickable(onClick = onClick, role = Role.Button)
            .heightIn(min = 56.dp)
            .padding(horizontal = OmSpacing.md, vertical = OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                policy.title,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                color = c.textPrimary,
            )
            if (policy.isDefault) {
                Text(
                    "Default policy",
                    style = MaterialTheme.typography.labelSmall,
                    color = c.accent,
                )
            }
            Text(
                policyRowCaption(policy),
                style = MaterialTheme.typography.bodySmall,
                color = c.textSecondary,
            )
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = c.textMuted,
            modifier = Modifier.size(20.dp),
        )
    }
}
