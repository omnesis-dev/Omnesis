// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Article
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.FolderZip
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.outlined.MusicNote
import androidx.compose.material.icons.outlined.PictureAsPdf
import androidx.compose.material.icons.outlined.Slideshow
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme

/**
 * File-type kinds mirroring the portal's `packages/gateway/portal/js/lib/file-type-icons.js`
 * and the iOS `FileTypeKind`. We resolve the kind from MIME type first, then filename
 * extension, then fall back to a generic file. Each kind has a recognisable colour (red PDF,
 * blue doc, green sheet, …) and a Material Outlined icon echoing the portal's Lucide glyph.
 */
enum class FileTypeKind {
    PDF, DOC, SHEET, SLIDE, IMAGE, ARCHIVE, CALENDAR, EMAIL, CODE, AUDIO, VIDEO, TEXT, FILE;

    /** Material Outlined icon echoing the portal's Lucide-style glyph for this kind. */
    val icon: ImageVector
        get() = when (this) {
            PDF -> Icons.Outlined.PictureAsPdf
            DOC -> Icons.Outlined.Description
            SHEET -> Icons.Outlined.TableChart
            SLIDE -> Icons.Outlined.Slideshow
            IMAGE -> Icons.Outlined.Image
            ARCHIVE -> Icons.Outlined.FolderZip
            CALENDAR -> Icons.Outlined.CalendarMonth
            EMAIL -> Icons.Outlined.Email
            CODE -> Icons.Outlined.Code
            AUDIO -> Icons.Outlined.MusicNote
            VIDEO -> Icons.Outlined.Movie
            TEXT -> Icons.Outlined.Article
            FILE -> Icons.Outlined.InsertDriveFile
        }

    /**
     * Fixed file-type palette mirrored from the portal — deliberately literal hex, NOT Primer
     * tokens, so the two surfaces share the instant-recognition language.
     */
    val color: Color
        get() = when (this) {
            PDF -> Color(0xFFDC2626)
            DOC -> Color(0xFF2563EB)
            SHEET -> Color(0xFF16A34A)
            SLIDE -> Color(0xFFEA580C)
            IMAGE -> Color(0xFFA855F7)
            ARCHIVE -> Color(0xFFCA8A04)
            CALENDAR -> Color(0xFF0891B2)
            EMAIL -> Color(0xFF64748B)
            CODE -> Color(0xFF64748B)
            AUDIO -> Color(0xFFDB2777)
            VIDEO -> Color(0xFFDB2777)
            TEXT -> Color(0xFF64748B)
            FILE -> Color(0xFF94A3B8)
        }

    /** Long-form kind label used as a fallback when the filename has no extension. */
    val label: String
        get() = when (this) {
            PDF -> "PDF"
            DOC -> "Document"
            SHEET -> "Spreadsheet"
            SLIDE -> "Presentation"
            IMAGE -> "Image"
            ARCHIVE -> "Archive"
            CALENDAR -> "Calendar"
            EMAIL -> "Email"
            CODE -> "Code"
            AUDIO -> "Audio"
            VIDEO -> "Video"
            TEXT -> "Text"
            FILE -> "File"
        }
}

object FileTypeIcons {
    /** MIME → kind. Mirrors `MIME_TO_KIND` in the portal helper. */
    private val MIME_TO_KIND: Map<String, FileTypeKind> = mapOf(
        "application/pdf" to FileTypeKind.PDF,

        "application/msword" to FileTypeKind.DOC,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to FileTypeKind.DOC,
        "application/vnd.oasis.opendocument.text" to FileTypeKind.DOC,
        "application/rtf" to FileTypeKind.DOC,
        "application/vnd.google-apps.document" to FileTypeKind.DOC,

        "application/vnd.ms-excel" to FileTypeKind.SHEET,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to FileTypeKind.SHEET,
        "application/vnd.oasis.opendocument.spreadsheet" to FileTypeKind.SHEET,
        "application/vnd.google-apps.spreadsheet" to FileTypeKind.SHEET,
        "text/csv" to FileTypeKind.SHEET,
        "text/tab-separated-values" to FileTypeKind.SHEET,

        "application/vnd.ms-powerpoint" to FileTypeKind.SLIDE,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" to FileTypeKind.SLIDE,
        "application/vnd.oasis.opendocument.presentation" to FileTypeKind.SLIDE,
        "application/vnd.google-apps.presentation" to FileTypeKind.SLIDE,

        "application/zip" to FileTypeKind.ARCHIVE,
        "application/x-zip-compressed" to FileTypeKind.ARCHIVE,
        "application/x-tar" to FileTypeKind.ARCHIVE,
        "application/x-rar-compressed" to FileTypeKind.ARCHIVE,
        "application/vnd.rar" to FileTypeKind.ARCHIVE,
        "application/x-7z-compressed" to FileTypeKind.ARCHIVE,
        "application/gzip" to FileTypeKind.ARCHIVE,
        "application/x-gzip" to FileTypeKind.ARCHIVE,
        "application/x-bzip2" to FileTypeKind.ARCHIVE,

        "text/calendar" to FileTypeKind.CALENDAR,
        "application/ics" to FileTypeKind.CALENDAR,

        "message/rfc822" to FileTypeKind.EMAIL,
        "application/vnd.ms-outlook" to FileTypeKind.EMAIL,

        "application/json" to FileTypeKind.CODE,
        "application/xml" to FileTypeKind.CODE,
        "text/xml" to FileTypeKind.CODE,
        "application/javascript" to FileTypeKind.CODE,
        "text/javascript" to FileTypeKind.CODE,
        "application/typescript" to FileTypeKind.CODE,
        "application/x-typescript" to FileTypeKind.CODE,
        "text/x-shellscript" to FileTypeKind.CODE,
        "application/x-sh" to FileTypeKind.CODE,
        "application/x-yaml" to FileTypeKind.CODE,
        "text/yaml" to FileTypeKind.CODE,
        "text/x-yaml" to FileTypeKind.CODE,
        "text/html" to FileTypeKind.CODE,
        "text/css" to FileTypeKind.CODE,

        "text/markdown" to FileTypeKind.TEXT,
        "text/plain" to FileTypeKind.TEXT,
    )

    /** Filename extension → kind. Mirrors `EXT_TO_KIND` in the portal helper. */
    private val EXT_TO_KIND: Map<String, FileTypeKind> = mapOf(
        "pdf" to FileTypeKind.PDF,

        "doc" to FileTypeKind.DOC, "docx" to FileTypeKind.DOC, "rtf" to FileTypeKind.DOC,
        "odt" to FileTypeKind.DOC, "pages" to FileTypeKind.DOC,

        "xls" to FileTypeKind.SHEET, "xlsx" to FileTypeKind.SHEET, "csv" to FileTypeKind.SHEET,
        "tsv" to FileTypeKind.SHEET, "ods" to FileTypeKind.SHEET, "numbers" to FileTypeKind.SHEET,

        "ppt" to FileTypeKind.SLIDE, "pptx" to FileTypeKind.SLIDE, "odp" to FileTypeKind.SLIDE,
        "key" to FileTypeKind.SLIDE,

        "png" to FileTypeKind.IMAGE, "jpg" to FileTypeKind.IMAGE, "jpeg" to FileTypeKind.IMAGE,
        "gif" to FileTypeKind.IMAGE, "webp" to FileTypeKind.IMAGE, "bmp" to FileTypeKind.IMAGE,
        "tiff" to FileTypeKind.IMAGE, "tif" to FileTypeKind.IMAGE, "svg" to FileTypeKind.IMAGE,
        "heic" to FileTypeKind.IMAGE, "heif" to FileTypeKind.IMAGE, "ico" to FileTypeKind.IMAGE,
        "avif" to FileTypeKind.IMAGE,

        "zip" to FileTypeKind.ARCHIVE, "tar" to FileTypeKind.ARCHIVE, "gz" to FileTypeKind.ARCHIVE,
        "tgz" to FileTypeKind.ARCHIVE, "rar" to FileTypeKind.ARCHIVE, "7z" to FileTypeKind.ARCHIVE,
        "bz2" to FileTypeKind.ARCHIVE, "xz" to FileTypeKind.ARCHIVE,

        "ics" to FileTypeKind.CALENDAR, "ical" to FileTypeKind.CALENDAR,

        "eml" to FileTypeKind.EMAIL, "msg" to FileTypeKind.EMAIL, "mbox" to FileTypeKind.EMAIL,

        "json" to FileTypeKind.CODE, "xml" to FileTypeKind.CODE, "yaml" to FileTypeKind.CODE,
        "yml" to FileTypeKind.CODE, "js" to FileTypeKind.CODE, "mjs" to FileTypeKind.CODE,
        "cjs" to FileTypeKind.CODE, "ts" to FileTypeKind.CODE, "tsx" to FileTypeKind.CODE,
        "jsx" to FileTypeKind.CODE, "py" to FileTypeKind.CODE, "rb" to FileTypeKind.CODE,
        "go" to FileTypeKind.CODE, "rs" to FileTypeKind.CODE, "java" to FileTypeKind.CODE,
        "c" to FileTypeKind.CODE, "cpp" to FileTypeKind.CODE, "h" to FileTypeKind.CODE,
        "hpp" to FileTypeKind.CODE, "sh" to FileTypeKind.CODE, "zsh" to FileTypeKind.CODE,
        "bash" to FileTypeKind.CODE, "sql" to FileTypeKind.CODE, "toml" to FileTypeKind.CODE,
        "ini" to FileTypeKind.CODE, "conf" to FileTypeKind.CODE, "cfg" to FileTypeKind.CODE,
        "html" to FileTypeKind.CODE, "htm" to FileTypeKind.CODE, "css" to FileTypeKind.CODE,
        "scss" to FileTypeKind.CODE,

        "mp3" to FileTypeKind.AUDIO, "m4a" to FileTypeKind.AUDIO, "wav" to FileTypeKind.AUDIO,
        "flac" to FileTypeKind.AUDIO, "ogg" to FileTypeKind.AUDIO, "aac" to FileTypeKind.AUDIO,
        "opus" to FileTypeKind.AUDIO,

        "mp4" to FileTypeKind.VIDEO, "mov" to FileTypeKind.VIDEO, "webm" to FileTypeKind.VIDEO,
        "mkv" to FileTypeKind.VIDEO, "avi" to FileTypeKind.VIDEO,

        "txt" to FileTypeKind.TEXT, "md" to FileTypeKind.TEXT, "markdown" to FileTypeKind.TEXT,
        "log" to FileTypeKind.TEXT,
    )

    /**
     * Resolve a kind from a MIME type. The `image`, `audio`, `video`, and `text` top-level
     * types fall through to the catch-all branch so an unspecified `image/heic-sequence` still
     * gets the image icon.
     */
    fun kindFromMime(mime: String?): FileTypeKind? {
        if (mime.isNullOrEmpty()) return null
        val lower = mime.trim().lowercase()
        MIME_TO_KIND[lower]?.let { return it }
        if (lower.startsWith("image/")) return FileTypeKind.IMAGE
        if (lower.startsWith("audio/")) return FileTypeKind.AUDIO
        if (lower.startsWith("video/")) return FileTypeKind.VIDEO
        if (lower.startsWith("text/")) return FileTypeKind.TEXT
        return null
    }

    /** Resolve a kind from a filename's extension. */
    fun kindFromFilename(filename: String?): FileTypeKind? {
        if (filename.isNullOrEmpty()) return null
        // Strip query / fragment in case the "filename" is actually a URL.
        val trimmed = filename.split('?', '#').firstOrNull() ?: filename
        val dot = trimmed.lastIndexOf('.')
        if (dot < 0 || dot >= trimmed.length - 1) return null
        val ext = trimmed.substring(dot + 1).lowercase()
        return EXT_TO_KIND[ext]
    }

    /**
     * Resolve a kind from `(mimeType, filename)` — MIME wins, extension is the fallback.
     * Returns null only if neither resolves.
     */
    fun kind(mimeType: String?, filename: String?): FileTypeKind? =
        kindFromMime(mimeType) ?: kindFromFilename(filename)

    /**
     * Short uppercase label. Prefers the filename extension ("DOCX" wins over the kind-level
     * "DOCUMENT") when available — matches the portal so users see the exact format. Falls
     * back to the MIME kind's label, then "FILE".
     */
    fun label(mimeType: String?, filename: String?): String {
        if (filename != null) {
            val trimmed = filename.split('?', '#').firstOrNull() ?: filename
            val dot = trimmed.lastIndexOf('.')
            if (dot >= 0 && dot < trimmed.length - 1) {
                val ext = trimmed.substring(dot + 1).uppercase()
                if (ext.isNotEmpty() && ext.length <= 5) return ext
            }
        }
        kindFromMime(mimeType)?.let { return it.label.uppercase() }
        return "FILE"
    }
}

/**
 * Small coloured icon for an attachment/file. Ported from the iOS `FileTypeIcon`. Default
 * size mirrors the portal's 16dp default; callers pass 14 or 18 where they need denser /
 * heavier presentation. Drawn in the kind's colour inside a `size+2` frame.
 */
@Composable
fun FileTypeIcon(
    mimeType: String?,
    filename: String?,
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
) {
    val kind = FileTypeIcons.kind(mimeType, filename) ?: FileTypeKind.FILE
    Icon(
        imageVector = kind.icon,
        contentDescription = kind.label,
        tint = kind.color,
        modifier = modifier.size(size + 2.dp),
    )
}

/**
 * The portal's `.file-type-pill` rendered as a Compose chip — coloured icon + short uppercase
 * label ("PDF", "DOCX", "ICS", …). Ported from the iOS `FileTypePill`. Used in search-result
 * rows and document-detail headers wherever the document type is "attachment" / "file".
 */
@Composable
fun FileTypePill(
    mimeType: String?,
    filename: String?,
    modifier: Modifier = Modifier,
    iconSize: Dp = 12.dp,
) {
    val kind = FileTypeIcons.kind(mimeType, filename) ?: FileTypeKind.FILE
    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(OmTheme.colors.bgTertiary)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    ) {
        Icon(
            imageVector = kind.icon,
            contentDescription = null,
            tint = kind.color,
            modifier = Modifier.size(iconSize),
        )
        Text(
            text = FileTypeIcons.label(mimeType, filename),
            style = MaterialTheme.typography.labelSmall.copy(
                fontSize = 10.sp,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.3.sp,
            ),
            color = OmTheme.colors.textSecondary,
        )
    }
}

// MARK: - Previews

private val FILE_SAMPLES: List<Pair<String?, String?>> = listOf(
    "application/pdf" to "report.pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to "notes.docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" to "budget.xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation" to "deck.pptx",
    "image/png" to "screenshot.png",
    "application/zip" to "archive.zip",
    "text/calendar" to "invite.ics",
    "message/rfc822" to "thread.eml",
    "application/json" to "config.json",
    "audio/mpeg" to "song.mp3",
    "video/mp4" to "clip.mp4",
    "text/plain" to "note.txt",
    null to "unknown.xyz",
)

@Composable
private fun FileTypeGallery() {
    val c = OmTheme.colors
    Column(
        modifier = Modifier.background(c.bgPrimary).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FILE_SAMPLES.forEach { (mime, name) ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FileTypeIcon(mimeType = mime, filename = name, size = 18.dp)
                Text(name ?: "—", color = c.textPrimary)
                FileTypePill(mimeType = mime, filename = name)
            }
        }
    }
}

@Preview(name = "FileType — dark")
@Composable
private fun FileTypePreviewDark() {
    OmnesisTheme(darkTheme = true) { FileTypeGallery() }
}

@Preview(name = "FileType — light")
@Composable
private fun FileTypePreviewLight() {
    OmnesisTheme(darkTheme = false) { FileTypeGallery() }
}
