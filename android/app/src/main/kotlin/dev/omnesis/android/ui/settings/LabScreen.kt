// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.settings

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.caverock.androidsvg.SVG
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.OmnesisCard
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.LabFeature
import dev.omnesis.android.transport.dto.LabSnapshot
import javax.inject.Inject
import java.util.Locale
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The server owns both the catalogue and the persisted feature switches. */
data class LabUiState(
    val snapshot: LabSnapshot? = null,
    val loading: Boolean = true,
    val saving: String? = null,
    val error: String? = null,
)

@HiltViewModel
class LabViewModel @Inject constructor(private val session: SessionManager) : ViewModel() {
    private val _state = MutableStateFlow(LabUiState())
    val state = _state.asStateFlow()

    fun load() {
        if (_state.value.saving != null) return
        val current = session.session ?: return
        _state.value = _state.value.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                val snapshot = current.admin.lab()
                if (session.session === current) _state.value = LabUiState(snapshot, loading = false)
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (session.session === current) _state.value = _state.value.copy(loading = false, error = "Couldn't load Omnesis Lab. Try again.")
            }
        }
    }

    fun setEnabled(id: String, enabled: Boolean) {
        if (_state.value.saving != null || _state.value.loading) return
        val current = session.session ?: return
        _state.value = _state.value.copy(saving = id, error = null)
        viewModelScope.launch {
            try {
                val snapshot = current.admin.setLabFeature(id, enabled)
                if (session.session !== current) return@launch
                _state.value = LabUiState(snapshot, loading = false)
                session.refreshStatus()
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (session.session === current) _state.value = _state.value.copy(saving = null, error = "Couldn't save this change. Try again.")
            }
        }
    }
}

@Composable
fun LabScreen(onBack: () -> Unit, vm: LabViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) { vm.load() }
    LabContent(state, onBack, vm::load, vm::setEnabled)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LabContent(state: LabUiState, onBack: () -> Unit, onRetry: () -> Unit, onToggle: (String, Boolean) -> Unit) {
    val c = OmTheme.colors
    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Omnesis Lab", style = MaterialTheme.typography.titleMedium) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back to Settings") } },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(containerColor = c.bgPrimary),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(OmSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.lg),
        ) {
            Text("Try features still taking shape. Enable only what you want to explore; you can turn them off at any time.", style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
            if (state.loading) OmSpinner(Modifier.size(24.dp))
            state.error?.let {
                Text(it, color = c.textSecondary)
                TextButton(onClick = onRetry) { Text("Retry") }
            }
            state.snapshot?.features?.forEach { feature ->
                OmnesisCard(padding = OmSpacing.lg) {
                    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.md)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                            LabIcon(feature.iconSvg, Modifier.size(48.dp))
                            Switch(
                                checked = feature.enabled,
                                onCheckedChange = { onToggle(feature.id, it) },
                                enabled = !state.loading && state.saving == null,
                                modifier = Modifier.semantics { contentDescription = "Enable ${feature.name}" },
                            )
                        }
                        Text(feature.name, style = MaterialTheme.typography.titleLarge, color = c.textPrimary)
                        Text(feature.description, style = MaterialTheme.typography.bodyMedium, color = c.textSecondary)
                    }
                }
            }
        }
    }
}

/** Render the gateway's shared vector synchronously, including in screenshot tests. */
@Composable
private fun LabIcon(svg: String, modifier: Modifier) {
    val color = "#%06X".format(Locale.ROOT, OmTheme.colors.textPrimary.toArgb() and 0xFFFFFF)
    val picture = remember(svg, color) { runCatching { SVG.getFromString(svg.replace("currentColor", color)).renderToPicture() }.getOrNull() }
    Canvas(modifier) {
        if (picture != null) drawIntoCanvas { canvas ->
            canvas.nativeCanvas.drawPicture(picture, android.graphics.RectF(0f, 0f, size.width, size.height))
        }
    }
}

@Preview(name = "Omnesis Lab · loading")
@Composable
private fun LabPreview() {
    OmnesisTheme { LabContent(LabUiState(), {}, {}, { _, _ -> }) }
}

@Preview(name = "Omnesis Lab · error", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable
private fun LabErrorPreview() {
    OmnesisTheme(darkTheme = true) {
        LabContent(LabUiState(loading = false, error = "Couldn't load Omnesis Lab. Try again."), {}, {}, { _, _ -> })
    }
}
