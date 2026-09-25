// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import dev.omnesis.android.designsystem.components.SourceIconModel
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.Annotation
import dev.omnesis.android.transport.dto.AnnotationDependent
import dev.omnesis.android.transport.dto.DocumentAttachment
import dev.omnesis.android.transport.dto.DocumentDetail
import dev.omnesis.android.transport.dto.DocumentEventTrail
import dev.omnesis.android.transport.dto.DocumentNearDupes
import dev.omnesis.android.transport.dto.InboundRef
import dev.omnesis.android.transport.dto.OutboundRef
import dev.omnesis.android.transport.dto.PersonMention
import dev.omnesis.android.ui.common.Loadable
import dev.omnesis.android.ui.common.AnnotationDependentsUi
import dev.omnesis.android.ui.common.annotationsSectionItems
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.document.DocumentDetailContent
import dev.omnesis.android.ui.document.DocumentDetailViewModel.DocumentBundle
import dev.omnesis.android.ui.document.DocumentDetailViewModel.SourceDisplay
import dev.omnesis.android.ui.document.DocumentDetailViewModel.SourceDisplayLookup
import dev.omnesis.android.ui.document.InspectorContent
import dev.omnesis.android.ui.document.InspectorTab
import dev.omnesis.android.ui.document.sampleMetadata
import dev.omnesis.android.ui.document.sampleNearDupes
import dev.omnesis.android.ui.document.sampleTrailEvents
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import java.time.temporal.ChronoUnit
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the document detail screen + the three-tab inspector (Metadata / Omnesis graph /
 * Timeline) to PNGs (Robolectric + Roborazzi) so the layout can be reviewed against the iOS
 * reference fixtures (30-document-detail, 31-inspector-metadata-tab, 31b/31c graph,
 * 31d/31e timeline, 32-markdown). All sample data is invented (privacy rule).
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DocumentInspectorParityScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    // --- Source display lookup shared by the fixtures (invented sources) ---

    private val display = SourceDisplayLookup(
        mapOf(
            "gmail:user@example.com" to SourceDisplay("Gmail", SourceIconModel(fallbackInitial = "G"), accent = androidx.compose.ui.graphics.Color(0xFFEA4335)),
            "notes:local" to SourceDisplay("Apple Notes", SourceIconModel(fallbackInitial = "N"), accent = androidx.compose.ui.graphics.Color(0xFFF7B500)),
            "whatsapp:demo" to SourceDisplay("WhatsApp", SourceIconModel(fallbackInitial = "W"), accent = androidx.compose.ui.graphics.Color(0xFF25D366)),
            "google-drive:user@example.com" to SourceDisplay("Google Drive", SourceIconModel(fallbackInitial = "D"), accent = androidx.compose.ui.graphics.Color(0xFF4285F4)),
        ),
    )

    private fun emailDoc(content: String) = DocumentDetail(
        id = "abc-123",
        providerId = "google:user@example.com",
        sourceId = "gmail:user@example.com",
        externalId = "ext-1",
        title = "Re: Northwind invoice for March",
        content = content,
        contentHash = "sha256:abc",
        metadata = sampleMetadata(
            documentType = "email",
            sourceUrl = "https://mail.example.com/u/0/#inbox/abc",
        ),
        sourceCreatedAt = "2026-04-12T10:14:00Z",
        sourceUpdatedAt = "2026-04-12T10:14:00Z",
        ingestedAt = "2026-04-12T10:15:00Z",
    )

    private val bodyText =
        "Hi Jamie,\n\nYour invoice for the period of Mar 1–31 is now available.\n\n" +
            "Total: \$124.00\nDue: Apr 15, 2026\n\nPay before the due date to avoid late fees."

    private val markdownKitchenSink = """
        # Top-level heading

        A paragraph with **bold**, *italic*, and `inline code`. Also a [link](https://example.com).

        ## Lists

        - First item
        - Second **bold** item
        - Third with `code`

        1. Ordered one
        2. Ordered two

        ## Quote

        > A wise person once said something quotable.

        ## Code

        ```
        let x = 42
        print(x)
        ```

        End paragraph.
    """.trimIndent()

    // Invented document-grounded observations (privacy rule) — one with an evidence quote
    // plus the claim-basis chip + verification marker, one ungrounded legacy row (neither)
    // — surfaced under "Enriched by Omnesis" in the Metadata tab. The verification
    // timestamp is relative to now so the "· Nd ago" recency stays stable.
    private fun sampleAnnotations() = listOf(
        Annotation(
            id = "an-1", claimType = "topic",
            claimText = "Invoice covers the March billing period for Northwind.",
            evidenceQuote = "Your invoice for the period of Mar 1–31 is now available.",
            confidence = 0.88,
            claimBasis = "quoted",
            verificationState = "verified",
            lastVerifiedAt = Instant.now().minus(2, ChronoUnit.DAYS).toString(),
        ),
        Annotation(
            id = "an-2", claimType = "amount",
            claimText = "Total due is \$124.00 by April 15.",
            confidence = 0.79,
        ),
    )

    private fun fullBundle(
        doc: DocumentDetail,
        nearDupes: DocumentNearDupes? = null,
        annotations: List<Annotation> = emptyList(),
    ) = DocumentBundle(
        doc = doc,
        annotations = annotations,
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
        refs = dev.omnesis.android.transport.dto.DocumentRefs(
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
        nearDupes = nearDupes,
        sourceDisplay = display,
    )

    // --- Document detail screen ---

    @Test
    fun document_detail_dark() = capture("document_detail_dark", dark = true) {
        DocumentDetailContent(state = Loadable.Content(fullBundle(emailDoc(bodyText))), onBack = {}, onRetry = {})
    }

    @Test
    fun document_detail_light() = capture("document_detail_light", dark = false) {
        DocumentDetailContent(state = Loadable.Content(fullBundle(emailDoc(bodyText))), onBack = {}, onRetry = {})
    }

    @Test
    fun document_markdown_kitchen_sink_dark() = capture("document_markdown_kitchen_sink_dark", dark = true) {
        DocumentDetailContent(state = Loadable.Content(fullBundle(emailDoc(markdownKitchenSink))), onBack = {}, onRetry = {})
    }

    @Test
    fun document_markdown_kitchen_sink_light() = capture("document_markdown_kitchen_sink_light", dark = false) {
        DocumentDetailContent(state = Loadable.Content(fullBundle(emailDoc(markdownKitchenSink))), onBack = {}, onRetry = {})
    }

    // --- Inspector: Metadata tab ---

    @Test
    fun inspector_metadata_dark() = capture("inspector_metadata_dark", dark = true) {
        Sheet { InspectorContent(bundle = fullBundle(emailDoc(bodyText)), onDone = {}, initialTab = InspectorTab.Metadata) }
    }

    @Test
    fun inspector_metadata_light() = capture("inspector_metadata_light", dark = false) {
        Sheet { InspectorContent(bundle = fullBundle(emailDoc(bodyText)), onDone = {}, initialTab = InspectorTab.Metadata) }
    }

    // Metadata tab with the "Enriched by Omnesis" annotations panel populated.
    @Test
    fun inspector_metadata_annotations_dark() = capture("inspector_metadata_annotations_dark", dark = true) {
        Sheet { InspectorContent(bundle = fullBundle(emailDoc(bodyText), annotations = sampleAnnotations()), onDone = {}, initialTab = InspectorTab.Metadata) }
    }

    @Test
    fun inspector_metadata_annotations_light() = capture("inspector_metadata_annotations_light", dark = false) {
        Sheet { InspectorContent(bundle = fullBundle(emailDoc(bodyText), annotations = sampleAnnotations()), onDone = {}, initialTab = InspectorTab.Metadata) }
    }

    private fun pagedAnnotations(): @Composable () -> Unit = {
        val listState = androidx.compose.foundation.lazy.rememberLazyListState()
        androidx.compose.foundation.lazy.LazyColumn(
            state = listState,
            modifier = Modifier.padding(16.dp),
        ) {
            annotationsSectionItems(
                listState = listState,
                keyPrefix = "snapshot-annotations",
                title = "Enriched by Omnesis",
                annotations = listOf(sampleAnnotations().first().copy(dependentCount = 2)),
                paging = CursorPagingState(nextCursor = "annotations-next"),
                dependents = mapOf(
                    "an-1" to AnnotationDependentsUi(
                        expanded = true,
                        items = listOf(
                            AnnotationDependent(
                                kind = "brief",
                                id = "brief-example",
                                title = "Fictional project brief",
                            ),
                        ),
                        paging = CursorPagingState(nextCursor = "dependents-next"),
                    ),
                ),
            )
        }
    }

    @Test
    fun inspector_annotation_paging_dark() = capture("inspector_annotation_paging_dark", dark = true) {
        Sheet(content = pagedAnnotations())
    }

    @Test
    fun inspector_annotation_paging_light() = capture("inspector_annotation_paging_light", dark = false) {
        Sheet(content = pagedAnnotations())
    }

    private fun failedDependentAnnotations(): @Composable () -> Unit = {
        val listState = androidx.compose.foundation.lazy.rememberLazyListState()
        androidx.compose.foundation.lazy.LazyColumn(
            state = listState,
            modifier = Modifier.padding(16.dp),
        ) {
            annotationsSectionItems(
                listState = listState,
                keyPrefix = "snapshot-annotations",
                title = "Enriched by Omnesis",
                annotations = listOf(sampleAnnotations().first().copy(dependentCount = 2)),
                dependents = mapOf(
                    "an-1" to AnnotationDependentsUi(
                        expanded = true,
                        paging = CursorPagingState(
                            paginationError = IllegalStateException("offline"),
                        ),
                    ),
                ),
            )
        }
    }

    @Test
    fun inspector_annotation_dependents_error_dark() =
        capture("inspector_annotation_dependents_error_dark", dark = true) {
            Sheet(content = failedDependentAnnotations())
        }

    @Test
    fun inspector_annotation_dependents_error_light() =
        capture("inspector_annotation_dependents_error_light", dark = false) {
            Sheet(content = failedDependentAnnotations())
        }

    // --- Inspector: Omnesis graph tab (with + without near-dupes) ---

    @Test
    fun inspector_graph_dark() = capture("inspector_graph_dark", dark = true) {
        Sheet { InspectorContent(bundle = fullBundle(emailDoc(bodyText)), onDone = {}, initialTab = InspectorTab.Graph) }
    }

    @Test
    fun inspector_graph_near_dupes_dark() = capture("inspector_graph_near_dupes_dark", dark = true) {
        Sheet { InspectorContent(bundle = fullBundle(emailDoc(bodyText), sampleNearDupes()), onDone = {}, initialTab = InspectorTab.Graph) }
    }

    @Test
    fun inspector_graph_near_dupes_light() = capture("inspector_graph_near_dupes_light", dark = false) {
        Sheet { InspectorContent(bundle = fullBundle(emailDoc(bodyText), sampleNearDupes()), onDone = {}, initialTab = InspectorTab.Graph) }
    }

    private fun pagedGraphBundle() = fullBundle(emailDoc(bodyText), sampleNearDupes()).copy(
        refs = fullBundle(emailDoc(bodyText)).refs?.copy(
            outbound = fullBundle(emailDoc(bodyText)).refs?.outbound.orEmpty().take(1),
            inbound = fullBundle(emailDoc(bodyText)).refs?.inbound.orEmpty().take(1),
        ),
        nearDupes = sampleNearDupes().copy(edges = sampleNearDupes().edges.take(1)),
        outboundRefsPaging = CursorPagingState(nextCursor = "outbound-next"),
        inboundRefsPaging = CursorPagingState(nextCursor = "inbound-next"),
        nearDupesPaging = CursorPagingState(nextCursor = "similar-next"),
    )

    @Test
    fun inspector_graph_paging_dark() = capture("inspector_graph_paging_dark", dark = true) {
        Sheet { InspectorContent(bundle = pagedGraphBundle(), onDone = {}, initialTab = InspectorTab.Graph) }
    }

    @Test
    fun inspector_graph_paging_light() = capture("inspector_graph_paging_light", dark = false) {
        Sheet { InspectorContent(bundle = pagedGraphBundle(), onDone = {}, initialTab = InspectorTab.Graph) }
    }

    @Test
    fun inspector_graph_empty_dark() = capture("inspector_graph_empty_dark", dark = true) {
        val bare = DocumentBundle(doc = emailDoc(bodyText), sourceDisplay = display)
        Sheet { InspectorContent(bundle = bare, onDone = {}, initialTab = InspectorTab.Graph) }
    }

    private fun emptyGraphPagingErrorBundle() = DocumentBundle(
        doc = emailDoc(bodyText),
        outboundRefsPaging = CursorPagingState(
            nextCursor = "outbound-next",
            paginationError = IllegalStateException("fictional page failure"),
        ),
        inboundRefsPaging = CursorPagingState(stoppedBeforeEnd = true),
        sourceDisplay = display,
    )

    @Test
    fun inspector_graph_empty_paging_error_dark() =
        capture("inspector_graph_empty_paging_error_dark", dark = true) {
            Sheet {
                InspectorContent(
                    bundle = emptyGraphPagingErrorBundle(),
                    onDone = {},
                    initialTab = InspectorTab.Graph,
                )
            }
        }

    @Test
    fun inspector_graph_empty_paging_error_light() =
        capture("inspector_graph_empty_paging_error_light", dark = false) {
            Sheet {
                InspectorContent(
                    bundle = emptyGraphPagingErrorBundle(),
                    onDone = {},
                    initialTab = InspectorTab.Graph,
                )
            }
        }

    // --- Inspector: Timeline tab (loading / empty / populated) ---

    @Test
    fun inspector_timeline_loading_dark() = capture("inspector_timeline_loading_dark", dark = true) {
        Sheet {
            InspectorContent(
                bundle = fullBundle(emailDoc(bodyText)),
                onDone = {},
                initialTab = InspectorTab.Timeline,
                trailOverride = Loadable.Loading,
            )
        }
    }

    @Test
    fun inspector_timeline_empty_dark() = capture("inspector_timeline_empty_dark", dark = true) {
        Sheet {
            InspectorContent(
                bundle = fullBundle(emailDoc(bodyText)),
                onDone = {},
                initialTab = InspectorTab.Timeline,
                trailOverride = Loadable.Content(DocumentEventTrail()),
            )
        }
    }

    @Test
    fun inspector_timeline_populated_dark() = capture("inspector_timeline_populated_dark", dark = true) {
        Sheet {
            InspectorContent(
                bundle = fullBundle(emailDoc(bodyText)),
                onDone = {},
                initialTab = InspectorTab.Timeline,
                trailOverride = Loadable.Content(DocumentEventTrail(events = sampleTrailEvents())),
            )
        }
    }

    @Test
    fun inspector_timeline_populated_light() = capture("inspector_timeline_populated_light", dark = false) {
        Sheet {
            InspectorContent(
                bundle = fullBundle(emailDoc(bodyText)),
                onDone = {},
                initialTab = InspectorTab.Timeline,
                trailOverride = Loadable.Content(DocumentEventTrail(events = sampleTrailEvents())),
            )
        }
    }

    /** Wraps inspector content on the sheet's bgPrimary surface so the capture reads like the half-sheet. */
    @Composable
    private fun Sheet(content: @Composable () -> Unit) {
        androidx.compose.foundation.layout.Box(
            Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary),
        ) { content() }
    }
}
