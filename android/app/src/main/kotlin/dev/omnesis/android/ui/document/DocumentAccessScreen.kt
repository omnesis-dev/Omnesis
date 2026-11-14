// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.dto.AccessCapability
import dev.omnesis.android.transport.dto.AuditLevel
import dev.omnesis.android.transport.dto.AuditVerdict
import dev.omnesis.android.transport.dto.DocumentAccessAudit
import dev.omnesis.android.ui.access.AccessAccountLine
import dev.omnesis.android.ui.access.AccessAccountName
import dev.omnesis.android.ui.access.AccessCapabilityPill
import dev.omnesis.android.ui.access.AccessConnectionName
import dev.omnesis.android.ui.access.AccessGap
import dev.omnesis.android.ui.access.AccessProgressLine
import dev.omnesis.android.ui.access.AccessQuestionHeader
import dev.omnesis.android.ui.access.AccessRow
import dev.omnesis.android.ui.access.AccessSectionHeading
import dev.omnesis.android.ui.access.AccessTextAction
import dev.omnesis.android.ui.access.AccessTopBar
import dev.omnesis.android.ui.access.AccessType
import dev.omnesis.android.ui.access.AccessUi
import dev.omnesis.android.ui.access.accessManagementError
import dev.omnesis.android.ui.access.title
import dev.omnesis.android.ui.common.Loadable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/** The name of the page, and of the entry to it from a document's details. */
internal const val WHO_CAN_READ_TITLE = "Who can read this?"

/** What a level without connected agents says where its agents would be listed. */
internal const val NO_CONNECTIONS = "No connections"

/** What the page says when it could not be read. */
private const val UNREADABLE_MESSAGE = "This page could not be loaded. Try again."

/** The verdict code of a capability the level does not grant, whose pill is then drawn muted. */
private const val PERMISSION_NOT_GRANTED = "permission-not-granted"

/** Backs [DocumentAccessScreen]: the owner's `GET /admin/documents/:id/access`, and the icon of the document's source. */
@HiltViewModel
class DocumentAccessViewModel @Inject constructor(
    private val session: SessionManager,
    private val catalog: SourceCatalog,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val documentId: String = checkNotNull(savedStateHandle["id"]) { "missing document id" }
    private val _state = MutableStateFlow<Loadable<DocumentAccessAudit>>(Loadable.Loading)
    val state = _state.asStateFlow()
    private var generation = 0L

    init {
        load()
    }

    fun load() {
        val requestGeneration = ++generation
        _state.value = Loadable.Loading
        viewModelScope.launch {
            val result = runCatching { session.requireSession().admin.documentAccess(documentId) }
            if (requestGeneration != generation) return@launch
            _state.value = result.fold({ Loadable.Content(it) }, { Loadable.Error(it) })
        }
    }

    fun iconFor(sourceId: String): SourceIconModel = catalog.iconModel(sourceId)
}

/** "Who can read this?" for one document: every access level, with whether its Answer and Direct can read it, and why. */
@Composable
fun DocumentAccessScreen(onBack: () -> Unit, vm: DocumentAccessViewModel = hiltViewModel()) {
    val state by vm.state.collectAsStateWithLifecycle()
    DocumentAccessContent(state, iconFor = vm::iconFor, onBack = onBack, onRetry = vm::load)
}

/**
 * The page itself, stateless: the question, the document and its source, the gateway's two notes, then one section per
 * access level in the gateway's order, each naming its agents and giving one verdict row for Answer and one for Direct.
 */
@Composable
fun DocumentAccessContent(
    state: Loadable<DocumentAccessAudit>,
    iconFor: (String) -> SourceIconModel,
    onBack: () -> Unit,
    onRetry: () -> Unit,
) {
    val colors = AccessUi.colors
    Column(Modifier.fillMaxSize().background(colors.background)) {
        AccessTopBar("", "Back", onBack)
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = AccessUi.Inset).padding(top = 12.dp, bottom = 24.dp).navigationBarsPadding(),
        ) {
            val audit = (state as? Loadable.Content)?.value
            AccessQuestionHeader(
                WHO_CAN_READ_TITLE,
                subtitle = audit?.title,
                account = audit?.let { { AccessAccountLine(auditAccountName(it.sourceName, it.sourceId), iconFor(it.sourceId)) } },
            )
            AccessGap(AccessUi.ContentGap)
            when (state) {
                Loadable.Loading -> AccessProgressLine("Checking each access level…")
                is Loadable.Error -> {
                    // A gateway refusal says what to do; anything else is a page that could not be read.
                    val failure = state.throwable
                    Text(if (failure is GatewayException) accessManagementError(failure, reading = true) else UNREADABLE_MESSAGE, style = AccessType.Subtitle, color = colors.secondary)
                    AccessTextAction("Try again", onClick = onRetry)
                }
                is Loadable.Content -> AuditBody(state.value)
            }
        }
    }
}

@Composable
private fun AuditBody(audit: DocumentAccessAudit) {
    val colors = AccessUi.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(audit.notes.answer, style = AccessType.Small, color = colors.secondary)
        Text(audit.notes.owner, style = AccessType.Small, color = colors.secondary)
    }
    if (audit.levels.isEmpty()) {
        AccessGap(AccessUi.SectionGap)
        Text("There are no access levels yet.", style = AccessType.Subtitle, color = colors.secondary)
    }
    audit.levels.forEach { level ->
        AccessGap(AccessUi.SectionGap)
        AuditLevelSection(level)
    }
}

/** One access level: its name, the agents on it, and its Answer and Direct verdicts. */
@Composable
private fun AuditLevelSection(level: AuditLevel) {
    val colors = AccessUi.colors
    AccessSectionHeading(level.name)
    AccessGap(10.dp)
    if (level.agents.isEmpty()) Text(NO_CONNECTIONS, style = AccessType.RowSecondary, color = colors.muted)
    else Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        level.agents.forEach { AccessConnectionName(it.name, integration = it.integration) }
    }
    AccessGap(6.dp)
    AuditVerdictRow(AccessCapability.ANSWER, level.answer, last = false)
    AuditVerdictRow(AccessCapability.DIRECT, level.direct, last = true)
}

/**
 * One capability's verdict: its pill (muted only when the level does not grant it), then "Can read" with a tick or
 * "Can't read" with a cross, and the gateway's reason in grey underneath. Readability is in the mark and its words.
 */
@Composable
private fun AuditVerdictRow(capability: AccessCapability, verdict: AuditVerdict, last: Boolean) {
    val colors = AccessUi.colors
    val mark = if (verdict.readable) "Can read" else "Can’t read"
    AccessRow(Modifier.clearAndSetSemantics { contentDescription = "${capability.title}: $mark. ${verdict.text}" }, last = last, alignment = Alignment.Top) {
        Box(Modifier.width(76.dp).padding(top = 1.dp)) { AccessCapabilityPill(capability, held = verdict.code != PERMISSION_NOT_GRANTED) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(if (verdict.readable) Icons.Filled.Check else Icons.Filled.Close, contentDescription = null,
                    tint = if (verdict.readable) colors.success else colors.secondary, modifier = Modifier.size(16.dp))
                Text(mark, style = AccessType.RowSecondary.copy(fontWeight = FontWeight.SemiBold), color = if (verdict.readable) colors.success else colors.primary)
            }
            Text(verdict.text, style = AccessType.RowSecondary, color = colors.secondary)
        }
    }
}

/** The audit's account line: the source's name, then the account its id names, as the other clients show it. */
internal fun auditAccountName(sourceName: String, sourceId: String): AccessAccountName =
    AccessAccountName(sourceName, sourceId.substringAfter(':', "").ifBlank { null })
