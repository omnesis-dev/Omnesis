// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.privacy

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.MarkdownText
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.PrivacyPolicyDocument
import dev.omnesis.android.ui.common.GatewayErrorView
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PrivacyPolicyUiState(
    val loading: Boolean = true,
    /** The family's name as the caller knew it; the document route does not carry one. */
    val familyName: String? = null,
    val policy: PrivacyPolicyDocument? = null,
    val error: Throwable? = null,
)

/**
 * The `policies/{familyId}` route: one policy family's document, named by the route. A route
 * that names no family — a malformed link — reads as an error rather than a request.
 */
@HiltViewModel
class PrivacyPolicyViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val session: SessionManager,
) : ViewModel() {
    private val familyId: String? = savedStateHandle.get<String>("familyId")?.trim()?.takeIf { it.isNotEmpty() }
    private val _state = MutableStateFlow(
        PrivacyPolicyUiState(
            familyName = savedStateHandle.get<String>("name")?.trim()?.takeIf { it.isNotEmpty() },
        ),
    )
    val state = _state.asStateFlow()
    private var generation = 0L

    init {
        load()
    }

    fun load() {
        val request = ++generation
        val familyId = familyId
        if (familyId == null) {
            _state.value = _state.value.copy(loading = false, error = MissingPolicyFamilyException())
            return
        }
        _state.value = _state.value.copy(loading = true, error = null)
        viewModelScope.launch {
            runCatching { session.requireSession().admin.privacyPolicyFamily(familyId) }.fold(
                onSuccess = {
                    if (request == generation) {
                        _state.value = _state.value.copy(loading = false, policy = it)
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
}

/** The policy route was opened without a family id, so there is nothing to ask the gateway for. */
class MissingPolicyFamilyException : IllegalArgumentException("This link names no policy.")

/**
 * One policy family's document. Reached from the Policies list under Settings and from an
 * exchange that was reviewed under it, so its leading action goes back to wherever that was.
 */
@Composable
fun PrivacyPolicyScreen(
    onBack: () -> Unit,
    onOpenSettings: () -> Unit = {},
    vm: PrivacyPolicyViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    PrivacyPolicyContent(
        state = state,
        onBack = onBack,
        onRetry = vm::load,
        onOpenSettings = onOpenSettings,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PrivacyPolicyContent(
    state: PrivacyPolicyUiState,
    onBack: () -> Unit,
    onRetry: () -> Unit = {},
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
                            contentDescription = "Back",
                            tint = c.accent,
                        )
                    }
                },
                title = {
                    Text(
                        state.familyName ?: "Policy",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
            )
        },
    ) { padding ->
        when {
            state.loading -> LoadingView(Modifier.padding(padding))
            state.error != null && state.policy == null -> GatewayErrorView(
                context = "load the privacy policy",
                error = state.error,
                onRetry = onRetry,
                onOpenSettings = onOpenSettings,
                modifier = Modifier.padding(padding),
            )
            else -> PrivacyPolicyPane(
                policy = state.policy,
                modifier = Modifier
                    .padding(padding)
                    .background(c.bgPrimary),
            )
        }
    }
}

/** A readable mobile copy of one portal-authored policy document. */
@Composable
internal fun PrivacyPolicyPane(
    policy: PrivacyPolicyDocument?,
    modifier: Modifier = Modifier,
) {
    val c = OmTheme.colors
    LazyColumn(
        modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = OmSpacing.lg, vertical = OmSpacing.md),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        item("portal-only") {
            // A statement of where editing lives, not a problem to solve — so it reads as
            // ordinary text rather than as a warning the reader has to clear.
            Text(
                "The policy can only be edited on the web portal.",
                style = MaterialTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
        }
        item("policy") {
            Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
                PrivacySectionHeading("Privacy policy")
                MarkdownText(
                    markdown = policy?.policy.orEmpty(),
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(c.bgSecondary, RoundedCornerShape(OmRadius.large))
                        .padding(OmSpacing.md),
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.textSecondary,
                )
            }
        }
    }
}
