// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import android.widget.Toast
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmTheme
import kotlinx.coroutines.delay

/** Keep inline controls inside Text's layout so styled text and links wrap together. */
@Composable
internal fun MarkdownInlineText(
    text: AnnotatedString,
    copyableCode: Boolean,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
) {
    val values = if (copyableCode) text.getStringAnnotations(CopyCodeAnnotation, 0, text.length) else emptyList()
    val rendered = remember(text, copyableCode) { inlineCopyText(text, copyableCode) }
    val content = values.mapIndexed { index, value ->
        "copy-$index" to InlineTextContent(Placeholder(40.sp, 32.sp, PlaceholderVerticalAlign.TextCenter)) {
            CopyMarkdownButton(value.item)
        }
    }.toMap()
    Text(text = rendered, style = style, color = color, modifier = modifier, inlineContent = content)
}

/** The display omits a fence's terminal newline; copying retains its entire literal body. */
internal fun copyValueText(value: String): AnnotatedString = buildAnnotatedString {
    pushStringAnnotation(CopyCodeAnnotation, value)
    append(value.trimEnd('\n'))
    pop()
}

/** Annotated subsequences preserve link and style ranges around inserted controls. */
internal fun inlineCopyText(text: AnnotatedString, enabled: Boolean): AnnotatedString {
    if (!enabled) return text
    val values = text.getStringAnnotations(CopyCodeAnnotation, 0, text.length)
    return buildAnnotatedString {
        var cursor = 0
        values.forEachIndexed { index, value ->
            append(text.subSequence(cursor, value.end))
            appendInlineContent("copy-$index", "\uFFFC")
            cursor = value.end
        }
        append(text.subSequence(cursor, text.length))
    }
}

@Suppress("DEPRECATION") // LocalClipboardManager is supported on the app's Compose baseline.
@Composable
internal fun CopyMarkdownButton(value: String, modifier: Modifier = Modifier, label: String = "value: $value") {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    var copied by remember(value) { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) { delay(1800); copied = false }
    }
    IconButton(
        onClick = {
            try {
                clipboard.setText(AnnotatedString(value))
                copied = true
            } catch (_: Exception) {
                copied = false
                Toast.makeText(context, "Could not copy. Try selecting the text.", Toast.LENGTH_SHORT).show()
            }
        },
        modifier = modifier.size(40.dp),
    ) {
        Icon(
            imageVector = if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy,
            contentDescription = if (copied) "Copied $label" else "Copy $label",
            tint = OmTheme.colors.textSecondary,
            modifier = Modifier.size(16.dp),
        )
    }
}
