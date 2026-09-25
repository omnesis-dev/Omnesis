// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.document

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.NorthEast
import androidx.compose.material.icons.outlined.SouthWest
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.Lifecycle
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.components.DeleteDocumentDialog
import dev.omnesis.android.designsystem.components.FileTypePill
import dev.omnesis.android.designsystem.components.LoadingView
import dev.omnesis.android.designsystem.components.MarkdownText
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.designsystem.theme.docTypeAccent
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.DocumentAttachment
import dev.omnesis.android.transport.dto.DocumentDetail
import dev.omnesis.android.transport.dto.DocumentEventTrail
import dev.omnesis.android.transport.dto.DocumentRefs
import dev.omnesis.android.transport.dto.InboundRef
import dev.omnesis.android.transport.dto.OutboundRef
import dev.omnesis.android.transport.dto.PersonMention
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.document.DocumentDetailViewModel.DocumentBundle
import dev.omnesis.android.ui.document.DocumentDetailViewModel.SourceDisplayLookup
import dev.omnesis.android.ui.sources.NOTES_SOURCE_ID
@Composable
fun DocumentDetailScreen(
    onBack: () -> Unit,
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (String) -> Unit = {},
    onOpenSettings: () -> Unit = {},
    vm: DocumentDetailViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val deleting by vm.deleting.collectAsStateWithLifecycle()
    val deleteError by vm.deleteError.collectAsStateWithLifecycle()
    val context = LocalContext.current
    DocumentDetailContent(
        state = state,
        onBack = onBack,
        onRetry = vm::load,
        loadTrail = vm::loadTrail,
        catalog = vm.catalog,
        onOpenDocument = onOpenDocument,
        onOpenPerson = onOpenPerson,
        onOpenSettings = onOpenSettings,
        onDelete = { keepCopy -> vm.delete(keepCopy, onBack) },
        manageNotesUrlFor = vm::manageNotesUrlFor,
        onManageNotes = { url ->
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        },
        deleting = deleting,
        deleteError = deleteError,
        onClearDeleteError = vm::clearDeleteError,
        onLoadMoreOutboundRefs = vm::loadMoreOutboundRefs,
        onLoadMoreInboundRefs = vm::loadMoreInboundRefs,
        onLoadMoreNearDupes = vm::loadMoreNearDupes,
        onLoadMoreAnnotations = vm::loadMoreAnnotations,
        onToggleAnnotationDependents = vm::toggleAnnotationDependents,
        onLoadMoreAnnotationDependents = vm::loadMoreAnnotationDependents,
        canOpenLink = context::canOpenLink,
        onOpenLinks = { urls -> context.openFirstLink(urls) },
    )
}

/**
 * Compatibility overload that adapts a bare [DocumentDetail] into a [DocumentBundle] (no
 * enriched people/refs/attachments panels). Lets call sites that only have the document —
 * the shared screenshot harness — render the lean body surface without rebuilding a bundle.
 */
@Composable
fun DocumentDetailContent(
    state: Loadable<DocumentDetail>,
    onBack: () -> Unit,
    onRetry: () -> Unit,
) {
    val mapped: Loadable<DocumentBundle> = when (state) {
        Loadable.Loading -> Loadable.Loading
        is Loadable.Error -> state
        is Loadable.Content -> Loadable.Content(
            DocumentBundle(
                doc = state.value,
                sourceDisplay = SourceDisplayLookup(
                    mapOf(
                        state.value.sourceId to DocumentDetailViewModel.SourceDisplay(
                            label = sourceTypeFromId(state.value.sourceId),
                            icon = SourceIconModel(fallbackInitial = sourceTypeFromId(state.value.sourceId).take(1)),
                        ),
                    ),
                ),
            ),
        )
    }
    DocumentDetailContent(state = mapped, onBack = onBack, onRetry = onRetry)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocumentDetailContent(
    state: Loadable<DocumentBundle>,
    onBack: () -> Unit,
    onRetry: () -> Unit,
    loadTrail: suspend () -> DocumentEventTrail = { DocumentEventTrail() },
    catalog: SourceCatalog = SourceCatalog(),
    onOpenDocument: (String) -> Unit = {},
    onOpenPerson: (String) -> Unit = {},
    onOpenSettings: () -> Unit = {},
    onDelete: (keepCopy: Boolean) -> Unit = {},
    manageNotesUrlFor: (DocumentDetail) -> String? = { null },
    onManageNotes: (String) -> Unit = {},
    deleting: Boolean = false,
    deleteError: String? = null,
    onClearDeleteError: () -> Unit = {},
    onLoadMoreOutboundRefs: () -> Unit = {},
    onLoadMoreInboundRefs: () -> Unit = {},
    onLoadMoreNearDupes: () -> Unit = {},
    onLoadMoreAnnotations: () -> Unit = {},
    onToggleAnnotationDependents: (dev.omnesis.android.transport.dto.Annotation) -> Unit = {},
    onLoadMoreAnnotationDependents: (dev.omnesis.android.transport.dto.Annotation) -> Unit = {},
    canOpenLink: (String) -> Boolean = { true },
    onOpenLinks: (List<String>) -> Unit = {},
) {
    val c = OmTheme.colors
    val bundle = (state as? Loadable.Content)?.value
    val doc = bundle?.doc
    val title = doc?.title?.takeIf { it.isNotBlank() } ?: "Document"
    // Re-checked on every resume, so installing the app that opens a link shows the action
    // when the user comes back.
    var resumes by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { resumes++ }
    val openUrls = remember(doc?.appUrl, doc?.sourceUrl, resumes) {
        doc?.let { openableDocUrls(it.appUrl, it.sourceUrl, canOpenLink) }.orEmpty()
    }
    var showInspector by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }

    Scaffold(
        containerColor = c.bgPrimary,
        topBar = {
            CenterAlignedTopAppBar(
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = c.bgPrimary,
                    titleContentColor = c.textPrimary,
                    navigationIconContentColor = c.textPrimary,
                    actionIconContentColor = c.accent,
                ),
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = c.textPrimary)
                    }
                },
                title = {
                    Text(
                        title,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                },
                actions = {
                    IconButton(onClick = { showInspector = true }, enabled = bundle != null) {
                        Icon(
                            Icons.Outlined.Info,
                            contentDescription = "Document info",
                            tint = if (bundle != null) c.accent else c.accent.copy(alpha = 0.4f),
                        )
                    }
                    if (openUrls.isNotEmpty()) {
                        IconButton(onClick = { onOpenLinks(openUrls) }) {
                            Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "Open in source", tint = c.accent)
                        }
                    }
                    // Destructive single-document privacy delete.
                    // Generated Notes day documents are read-only: Manage
                    // notes instead, and the gateway refuses deletion anyway.
                    // The button only renders when the URL resolves (Notes
                    // source + paired) — never a dead action. A non-Notes
                    // internal document gets no action at all.
                    val manageNotesUrl = doc?.let(manageNotesUrlFor)
                    if (manageNotesUrl != null) {
                        IconButton(
                            onClick = { onManageNotes(manageNotesUrl) },
                            enabled = bundle != null,
                        ) {
                            Icon(
                                Icons.Outlined.Edit,
                                contentDescription = "Manage notes",
                                tint = if (bundle != null) c.accent else c.accent.copy(alpha = 0.4f),
                            )
                        }
                    } else if (doc?.isInternal != true) {
                        IconButton(
                            onClick = { showDeleteConfirm = true },
                            enabled = bundle != null && !deleting,
                        ) {
                            Icon(
                                Icons.Outlined.Delete,
                                contentDescription = "Delete document",
                                tint = if (bundle != null && !deleting) c.danger else c.danger.copy(alpha = 0.4f),
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        when (state) {
            Loadable.Loading -> LoadingView(Modifier.padding(padding))
            is Loadable.Error -> GatewayErrorView(
                context = "load this document",
                error = state.throwable,
                onRetry = onRetry,
                onOpenSettings = onOpenSettings,
                modifier = Modifier.padding(padding),
            )
            is Loadable.Content -> DocumentBody(state.value, Modifier.padding(padding))
        }
    }

    if (showInspector && bundle != null) {
        DocumentInspectorSheet(
            bundle = bundle,
            onDismiss = { showInspector = false },
            loadTrail = loadTrail,
            catalog = catalog,
            onOpenDocument = onOpenDocument,
            onOpenPerson = onOpenPerson,
            onLoadMoreOutboundRefs = onLoadMoreOutboundRefs,
            onLoadMoreInboundRefs = onLoadMoreInboundRefs,
            onLoadMoreNearDupes = onLoadMoreNearDupes,
            onLoadMoreAnnotations = onLoadMoreAnnotations,
            onToggleAnnotationDependents = onToggleAnnotationDependents,
            onLoadMoreAnnotationDependents = onLoadMoreAnnotationDependents,
        )
    }

    // Only reachable for mutable sources: internal documents offer
    // Manage notes from the toolbar instead.
    if (showDeleteConfirm) {
        DeleteDocumentDialog(
            title = "Delete this document?",
            onDismiss = { showDeleteConfirm = false },
            onDelete = { keepCopy ->
                showDeleteConfirm = false
                onDelete(keepCopy)
            },
        )
    }

    if (deleteError != null) {
        AlertDialog(
            containerColor = c.bgSecondary,
            onDismissRequest = onClearDeleteError,
            title = { Text("Couldn't delete", color = c.textPrimary) },
            text = { Text(deleteError, color = c.textSecondary) },
            confirmButton = {
                TextButton(onClick = onClearDeleteError) {
                    Text("OK", color = c.accent)
                }
            },
        )
    }
}

@Composable
private fun DocumentBody(bundle: DocumentBundle, modifier: Modifier = Modifier) {
    val doc = bundle.doc
    Column(
        modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(OmSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(OmSpacing.md),
    ) {
        HeaderRow(doc, bundle.sourceDisplay)
        if (hasAnyFacts(bundle)) QuickFactsRow(bundle)
        if (doc.content.isNotBlank()) ContentSection(doc.content)
        Spacer(Modifier.height(40.dp))
    }
}

@Composable
private fun HeaderRow(doc: DocumentDetail, display: SourceDisplayLookup) {
    val c = OmTheme.colors
    Box(Modifier.height(IntrinsicSize.Min)) {
        Row(
            modifier = Modifier
                .padding(start = 13.dp)
                .padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            SourceIcon(model = display[doc.sourceId].icon, size = 32.dp, modifier = Modifier.padding(top = 2.dp))
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    doc.title.ifBlank { "(untitled)" },
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = c.textPrimary,
                    modifier = Modifier.fillMaxWidth(),
                )
                MetaLine(doc, display)
            }
        }
        // Doc-type accent stripe pinned to the start edge, full header height.
        Box(
            Modifier
                .align(Alignment.CenterStart)
                .width(3.dp)
                .fillMaxHeight()
                .clip(RoundedCornerShape(1.5.dp))
                .background(c.docTypeAccent(doc.documentType)),
        )
    }
}

@Composable
private fun MetaLine(doc: DocumentDetail, display: SourceDisplayLookup) {
    val c = OmTheme.colors
    val sourceName = display[doc.sourceId].label
    val timeAgo = formatTimeAgo(doc.sourceCreatedAt)
    if (isFileLike(doc.documentType)) {
        val trailing = listOfNotNull(sourceName.takeIf { it.isNotBlank() }, timeAgo).joinToString(" · ")
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            FileTypePill(mimeType = doc.metadataString("mimeType"), filename = doc.title)
            if (trailing.isNotBlank()) {
                Text(trailing, fontSize = 12.sp, color = c.textSecondary)
            }
        }
    } else {
        val parts = listOfNotNull(
            sourceName.takeIf { it.isNotBlank() },
            docTypeLabel(doc.documentType),
            timeAgo,
        )
        Text(parts.joinToString(" · "), fontSize = 12.sp, color = c.textSecondary)
    }
}

@Composable
private fun QuickFactsRow(bundle: DocumentBundle) {
    val people = bundle.people.size
    val attachments = bundle.attachments.size
    val outbound = bundle.refs?.outbound?.size ?: 0
    val inbound = bundle.refs?.inbound?.size ?: 0
    Row(
        horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (people > 0) QuickFact(Icons.Outlined.Group, people, if (people == 1) "person" else "people")
        if (attachments > 0) QuickFact(Icons.Outlined.AttachFile, attachments, if (attachments == 1) "attachment" else "attachments")
        if (outbound > 0) QuickFact(Icons.Outlined.NorthEast, outbound, "out")
        if (inbound > 0) QuickFact(Icons.Outlined.SouthWest, inbound, "in")
        Spacer(Modifier.weight(1f))
    }
}

@Composable
private fun QuickFact(icon: ImageVector, count: Int, label: String) {
    val c = OmTheme.colors
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Icon(icon, contentDescription = null, tint = c.accent, modifier = Modifier.size(9.dp))
        Text(
            "$count",
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
            style = androidx.compose.ui.text.TextStyle(fontFeatureSettings = "tnum"),
        )
        Text(label, fontSize = 11.sp, color = c.textMuted)
    }
}

@Composable
private fun ContentSection(content: String) {
    val c = OmTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(OmSpacing.sm)) {
        FlatSectionHeader(title = "Content")
        SelectionContainer {
            MarkdownText(
                markdown = content,
                color = c.textPrimary,
                style = androidx.compose.ui.text.TextStyle(fontSize = 14.sp),
            )
        }
    }
}

private fun hasAnyFacts(bundle: DocumentBundle): Boolean =
    bundle.people.isNotEmpty() ||
        bundle.attachments.isNotEmpty() ||
        (bundle.refs?.outbound?.isNotEmpty() == true) ||
        (bundle.refs?.inbound?.isNotEmpty() == true)

// MARK: - Previews / fixtures

private fun sampleEmailDoc() = DocumentDetail(
    id = "abc-123",
    providerId = "google:user@example.com",
    sourceId = "gmail:user@example.com",
    externalId = "ext-1",
    title = "Re: Northwind invoice for March",
    content = "Hi Jamie,\n\nYour invoice for the period of Mar 1–31 is now available.\n\n" +
        "Total: \$124.00\nDue: Apr 15, 2026\n\nPay before the due date to avoid late fees.",
    contentHash = "sha256:abc",
    metadata = sampleMetadata(documentType = "email", sourceUrl = "https://mail.example.com/u/0/#inbox/abc"),
    sourceCreatedAt = "2026-04-12T10:14:00Z",
    sourceUpdatedAt = "2026-04-12T10:14:00Z",
    ingestedAt = "2026-04-12T10:15:00Z",
)

private fun sampleBundle() = DocumentBundle(
    doc = sampleEmailDoc(),
    people = listOf(
        PersonMention(personId = "self", canonicalName = "You", role = "recipient", isSelf = true),
        PersonMention(personId = "p1", canonicalName = "billing@example.com", role = "sender"),
    ),
    attachments = listOf(
        DocumentAttachment(
            id = "att-1", externalId = "e-att-1", title = "invoice-march.pdf", attachmentId = "a1",
            mimeType = "application/pdf", sizeBytes = 135_168, pages = 2,
        ),
    ),
    refs = DocumentRefs(
        outbound = listOf(
            OutboundRef(linkType = "intra-source", targetDocId = "d-notes-1", targetTitle = "Standup notes — Mar 9", targetSourceId = "notes:local"),
            OutboundRef(linkType = "url", rawTarget = "https://example.com/invoices/in_1ABC", targetDocId = null),
            OutboundRef(linkType = "attachment", rawTarget = "inv.pdf", targetDocId = null),
        ),
        inbound = listOf(
            InboundRef(sourceDocId = "d-wa-1", sourceTitle = "Summer hike in the alps (group)", sourceSourceId = "whatsapp:demo", linkType = "url"),
            InboundRef(sourceDocId = "d-notes-2", sourceTitle = "Q1 finances", sourceSourceId = "notes:local", linkType = "url"),
        ),
    ),
    sourceDisplay = SourceDisplayLookup(
        mapOf(
            "gmail:user@example.com" to DocumentDetailViewModel.SourceDisplay("Gmail", SourceIconModel(fallbackInitial = "G")),
            "notes:local" to DocumentDetailViewModel.SourceDisplay("Apple Notes", SourceIconModel(fallbackInitial = "N")),
            "whatsapp:demo" to DocumentDetailViewModel.SourceDisplay("WhatsApp", SourceIconModel(fallbackInitial = "W")),
        ),
    ),
)

@Preview(name = "Document · content · dark")
@Composable
private fun DocumentPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        DocumentDetailContent(state = Loadable.Content(sampleBundle()), onBack = {}, onRetry = {})
    }
}

@Preview(name = "Document · content · light")
@Composable
private fun DocumentPreviewLight() {
    OmnesisTheme(darkTheme = false) {
        DocumentDetailContent(state = Loadable.Content(sampleBundle()), onBack = {}, onRetry = {})
    }
}

@Preview(name = "Document · loading · dark")
@Composable
private fun DocumentPreviewLoading() {
    val loading: Loadable<DocumentBundle> = Loadable.Loading
    OmnesisTheme(darkTheme = true) {
        DocumentDetailContent(state = loading, onBack = {}, onRetry = {})
    }
}

private fun sampleNotesDoc() = DocumentDetail(
    id = "notes-2026-03-01",
    providerId = "system",
    sourceId = NOTES_SOURCE_ID,
    isInternal = true,
    externalId = "2026-03-01",
    title = "Notes for March 1",
    content = "Tell the team the studio booking moved to Friday.",
    contentHash = "sha256:preview",
    sourceCreatedAt = "2026-03-01T10:00:00Z",
)

@Preview(name = "Document · notes internal · dark")
@Composable
private fun DocumentPreviewNotesInternal() {
    OmnesisTheme(darkTheme = true) {
        DocumentDetailContent(
            state = Loadable.Content(DocumentBundle(doc = sampleNotesDoc())),
            onBack = {}, onRetry = {},
            manageNotesUrlFor = { "https://gateway.example:7942/portal/capture?day=2026-03-01&token=preview" },
        )
    }
}
