// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Button
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.PrivacySubscriptionApprovalDetail
import dev.omnesis.android.transport.dto.PrivacySubscriptionDetail
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.TimeFormat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PrivacySubscriptionApprovalUiState(
    val loading: Boolean = true,
    val resolving: Boolean = false,
    val resolved: Boolean = false,
    val detail: PrivacySubscriptionApprovalDetail? = null,
    val error: Throwable? = null,
)

internal sealed interface PrivacySubscriptionResolutionOutcome {
    data object Accepted : PrivacySubscriptionResolutionOutcome

    data class Reconciled(
        val detail: PrivacySubscriptionApprovalDetail,
    ) : PrivacySubscriptionResolutionOutcome

    data class Failed(
        val error: Throwable,
        val latest: PrivacySubscriptionApprovalDetail?,
    ) : PrivacySubscriptionResolutionOutcome
}

/**
 * A lost HTTP response does not prove that the gateway rejected the decision. Re-read the
 * approval before offering another attempt so an already-committed decision is never presented
 * as pending.
 */
internal suspend fun resolveSubscriptionApprovalAndReconcile(
    resolve: suspend () -> Unit,
    reload: suspend () -> PrivacySubscriptionApprovalDetail,
): PrivacySubscriptionResolutionOutcome {
    try {
        resolve()
        return PrivacySubscriptionResolutionOutcome.Accepted
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        val latest = try {
            reload()
        } catch (reloadCancellation: CancellationException) {
            throw reloadCancellation
        } catch (_: Throwable) {
            null
        }
        return if (latest != null && latest.status != "pending") {
            PrivacySubscriptionResolutionOutcome.Reconciled(latest)
        } else {
            PrivacySubscriptionResolutionOutcome.Failed(error, latest)
        }
    }
}

internal sealed interface PrivacySubscriptionRevokeOutcome {
    data class Accepted(val detail: PrivacySubscriptionDetail) : PrivacySubscriptionRevokeOutcome

    data class Reconciled(val detail: PrivacySubscriptionDetail) : PrivacySubscriptionRevokeOutcome

    data class Failed(
        val error: Throwable,
        val latest: PrivacySubscriptionDetail?,
    ) : PrivacySubscriptionRevokeOutcome
}

internal suspend fun revokeSubscriptionAndReconcile(
    revoke: suspend () -> PrivacySubscriptionDetail,
    reload: suspend () -> PrivacySubscriptionDetail,
): PrivacySubscriptionRevokeOutcome {
    try {
        return PrivacySubscriptionRevokeOutcome.Accepted(revoke())
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        val latest = try {
            reload()
        } catch (reloadCancellation: CancellationException) {
            throw reloadCancellation
        } catch (_: Throwable) {
            null
        }
        return if (latest?.status in setOf("revoked", "expired")) {
            PrivacySubscriptionRevokeOutcome.Reconciled(requireNotNull(latest))
        } else {
            PrivacySubscriptionRevokeOutcome.Failed(error, latest)
        }
    }
}

@HiltViewModel
class PrivacySubscriptionApprovalViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val session: SessionManager,
    private val resolutionBus: PrivacySubscriptionResolutionBus,
) : ViewModel() {
    private val approvalId: String = checkNotNull(savedStateHandle["subscriptionApprovalId"])
    private val _state = MutableStateFlow(PrivacySubscriptionApprovalUiState())
    val state = _state.asStateFlow()
    private var generation = 0L

    init {
        load()
    }

    fun load() {
        val request = ++generation
        _state.value = _state.value.copy(loading = true, error = null)
        viewModelScope.launch {
            runCatching { session.requireSession().admin.privacySubscriptionApproval(approvalId) }
                .fold(
                    onSuccess = {
                        if (request == generation) {
                            _state.value = PrivacySubscriptionApprovalUiState(
                                loading = false,
                                detail = it,
                            )
                        }
                    },
                    onFailure = {
                        if (request == generation) {
                            _state.value = _state.value.copy(loading = false, error = it)
                        }
                    },
                )
        }
    }

    fun resolve(approve: Boolean) {
        if (_state.value.resolving || _state.value.detail?.status != "pending") return
        val request = ++generation
        _state.value = _state.value.copy(resolving = true, error = null)
        viewModelScope.launch {
            val outcome = resolveSubscriptionApprovalAndReconcile(
                resolve = {
                    val admin = session.requireSession().admin
                    if (approve) {
                        admin.approvePrivacySubscription(approvalId)
                    } else {
                        admin.denyPrivacySubscription(approvalId)
                    }
                },
                reload = {
                    session.requireSession().admin.privacySubscriptionApproval(approvalId)
                },
            )
            if (request != generation) return@launch
            when (outcome) {
                PrivacySubscriptionResolutionOutcome.Accepted -> {
                    resolutionBus.notifyChanged()
                    _state.value = _state.value.copy(resolving = false, resolved = true)
                }

                is PrivacySubscriptionResolutionOutcome.Reconciled -> {
                    resolutionBus.notifyChanged()
                    _state.value = _state.value.copy(
                        resolving = false,
                        resolved = true,
                        detail = outcome.detail,
                    )
                }

                is PrivacySubscriptionResolutionOutcome.Failed -> {
                    _state.value = _state.value.copy(
                        resolving = false,
                        detail = outcome.latest ?: _state.value.detail,
                        error = outcome.error,
                    )
                }
            }
        }
    }
}

@Composable
fun PrivacySubscriptionApprovalScreen(
    onBack: () -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: PrivacySubscriptionApprovalViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(state.resolved) {
        if (state.resolved) onBack()
    }
    PrivacySubscriptionApprovalContent(
        state = state,
        onBack = onBack,
        onRetry = vm::load,
        onApprove = { vm.resolve(true) },
        onDeny = { vm.resolve(false) },
        onOpenSettings = onOpenSettings,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrivacySubscriptionApprovalContent(
    state: PrivacySubscriptionApprovalUiState,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onOpenSettings: () -> Unit = {},
) {
    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Text(
                        if ((state.detail?.revision ?: 1) > 1) {
                            "Watch revision ${state.detail?.revision}"
                        } else {
                            "Watch request"
                        },
                    )
                },
            )
        },
    ) { padding ->
        when {
            state.loading -> LoadingView(Modifier.padding(padding))
            state.error != null && state.detail == null -> GatewayErrorView(
                context = "load the watch request",
                error = state.error,
                onRetry = onRetry,
                onOpenSettings = onOpenSettings,
                modifier = Modifier.padding(padding),
            )
            state.detail != null -> SubscriptionApprovalBody(
                detail = state.detail,
                resolving = state.resolving,
                error = state.error,
                onApprove = onApprove,
                onDeny = onDeny,
                modifier = Modifier.padding(padding),
            )
        }
    }
}

@Composable
private fun SubscriptionApprovalBody(
    detail: PrivacySubscriptionApprovalDetail,
    resolving: Boolean,
    error: Throwable?,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    LazyColumn(
        modifier.fillMaxSize().background(c.bgPrimary),
        contentPadding = PaddingValues(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(c.warning.copy(alpha = 0.12f), RoundedCornerShape(OmRadius.medium))
                    .padding(OmSpacing.md),
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            ) {
                Icon(Icons.Outlined.Shield, contentDescription = null, tint = c.warning)
                Text(
                    "Your privacy policy requires approval before this integration can learn that the condition occurred. Documents, titles, people, content, and private evidence stay inside Omnesis.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        item { TrustedTextCard("What to watch for", detail.condition.description) }
        item {
            TrustedTextCard(
                "What the agent says it will do",
                detail.reaction.instruction,
                "Exact subscriber-authored text. Omnesis never adds private data to this instruction.",
            )
        }
        item {
            TrustedTextCard(
                "Private data categories",
                detail.categories.joinToString(", ", transform = ::privacyCategoryLabel),
                "The firing reveals only that a match exists in these categories.",
            )
        }
        item {
            MetadataCard(
                listOf(
                    "Owner" to detail.integration.displayName,
                    "Owner device" to detail.integrationDevice.name,
                    "Workflow" to detail.workflow.name,
                    "Workflow purpose" to detail.workflow.purpose,
                    "Workflow handle" to shortSubscriptionId(detail.workflowHandle),
                    "Disclosure" to subscriptionDisclosureLabel(detail.interpretedCondition.pushDetail),
                    "Expires" to if (detail.expiresAt > 0) TimeFormat.dateTime(detail.expiresAt) else "Never",
                    "Revision" to detail.revision.toString(),
                    "Policy" to shortSubscriptionId(detail.policyRevision),
                ),
            )
        }
        error?.let {
            item {
                Text(
                    "The request could not be resolved. Refresh and try again.",
                    color = c.warning,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        if (detail.status == "pending") {
            item {
                Button(
                    onClick = onApprove,
                    enabled = !resolving,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (resolving) OmSpinner()
                    Text("Approve watch")
                }
            }
            item {
                OutlinedButton(
                    onClick = onDeny,
                    enabled = !resolving,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Don’t allow")
                }
            }
        }
    }
}

internal fun canRevokePrivacySubscription(status: String): Boolean =
    status == "pending_approval" || status == "active" || status == "paused"

@Composable
private fun TrustedTextCard(title: String, text: String, footnote: String? = null) {
    val c = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        Text(title, style = MaterialTheme.typography.titleSmall, color = c.textPrimary)
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = c.textPrimary,
            modifier = Modifier
                .fillMaxWidth()
                .background(c.bgSecondary, RoundedCornerShape(OmRadius.medium))
                .padding(OmSpacing.md),
        )
        footnote?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
        }
    }
}

@Composable
private fun MetadataCard(rows: List<Pair<String, String>>) {
    val c = OmTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .background(c.bgSecondary, RoundedCornerShape(OmRadius.medium))
            .padding(OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
    ) {
        rows.forEach { (label, value) ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(label, style = MaterialTheme.typography.bodySmall, color = c.textSecondary)
                Text(
                    value,
                    style = MaterialTheme.typography.bodySmall,
                    color = c.textPrimary,
                    modifier = Modifier.padding(start = OmSpacing.md),
                )
            }
        }
    }
}

private fun shortSubscriptionId(value: String): String =
    if (value.length <= 18) value else "${value.take(8)}…${value.takeLast(6)}"
