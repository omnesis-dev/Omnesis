// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.search

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.SourceIcon
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.SearchProvenance

@Composable
internal fun SearchGraphContext(
    provenance: SearchProvenance?,
    rootId: String,
    catalog: SourceCatalog,
    onOpenDocument: (String) -> Unit,
) {
    val facts = searchGraphFacts(provenance, rootId)
    if (facts.isEmpty()) return
    val colors = OmTheme.colors
    Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        facts.forEach { fact ->
            val icons = mutableMapOf<String, InlineTextContent>()
            val text = buildAnnotatedString {
                fact.forEachIndexed { index, part ->
                    val document = part.document
                    if (document == null) append(part.text) else {
                        val key = "doc-$index"
                        icons[key] = InlineTextContent(Placeholder(14.sp, 14.sp, PlaceholderVerticalAlign.TextCenter)) {
                            SourceIcon(model = catalog.iconModel(document.sourceId), size = 14.dp)
                        }
                        withLink(LinkAnnotation.Clickable(document.documentId, TextLinkStyles(SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline))) {
                            onOpenDocument(document.documentId)
                        }) {
                            appendInlineContent(key, "\uFFFC")
                            append("\u00A0")
                            append(part.text)
                        }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("•", fontSize = 12.sp, lineHeight = 18.sp, color = colors.textMuted)
                Text(text, inlineContent = icons, fontSize = 12.sp, lineHeight = 18.sp, color = colors.textSecondary, modifier = Modifier.weight(1f))
            }
        }
    }
}
