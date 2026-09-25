// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// File-type icons mirroring the portal's `packages/gateway/portal/js/lib/file-type-icons.js`.
/// We resolve the kind from MIME type first, then filename extension, then
/// fall back to a generic file icon. Each kind has a recognisable colour
/// (red PDF, blue doc, green sheet, orange slides, purple image, …) and an
/// SF Symbol that visually echoes the Lucide glyph the portal uses.
///
/// The portal also exposes a short label ("PDF", "DOCX", …) — `FileTypePill`
/// renders the icon + that label as a compact chip, matching the
/// `.file-type-pill` element on the web.
enum FileTypeKind: String, Hashable {
    case pdf, doc, sheet, slide, image, archive, calendar, email, code, audio, video, text, file

    /// SF Symbol that visually echoes the portal's Lucide-style glyph for
    /// this kind.
    var systemImage: String {
        switch self {
        case .pdf: "doc.richtext.fill"
        case .doc: "doc.text.fill"
        case .sheet: "tablecells.fill"
        case .slide: "rectangle.on.rectangle.fill"
        case .image: "photo.fill"
        case .archive: "archivebox.fill"
        case .calendar: "calendar"
        case .email: "envelope.fill"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .audio: "music.note"
        case .video: "play.rectangle.fill"
        case .text: "doc.plaintext.fill"
        case .file: "doc.fill"
        }
    }

    /// Hex colour mirrored from the portal palette so the two surfaces
    /// share the instant-recognition language.
    var color: Color {
        switch self {
        case .pdf: Color(hex: 0xDC2626)
        case .doc: Color(hex: 0x2563EB)
        case .sheet: Color(hex: 0x16A34A)
        case .slide: Color(hex: 0xEA580C)
        case .image: Color(hex: 0xA855F7)
        case .archive: Color(hex: 0xCA8A04)
        case .calendar: Color(hex: 0x0891B2)
        case .email: Color(hex: 0x64748B)
        case .code: Color(hex: 0x64748B)
        case .audio: Color(hex: 0xDB2777)
        case .video: Color(hex: 0xDB2777)
        case .text: Color(hex: 0x64748B)
        case .file: Color(hex: 0x94A3B8)
        }
    }

    /// Long-form kind label used as a fallback when the filename has no
    /// extension. Matches the portal's `ICONS[kind].label`.
    var label: String {
        switch self {
        case .pdf: "PDF"
        case .doc: "Document"
        case .sheet: "Spreadsheet"
        case .slide: "Presentation"
        case .image: "Image"
        case .archive: "Archive"
        case .calendar: "Calendar"
        case .email: "Email"
        case .code: "Code"
        case .audio: "Audio"
        case .video: "Video"
        case .text: "Text"
        case .file: "File"
        }
    }
}

enum FileTypeIcons {
    /// MIME → kind. Mirrors `MIME_TO_KIND` in the portal helper.
    private static let mimeToKind: [String: FileTypeKind] = [
        "application/pdf": .pdf,

        "application/msword": .doc,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": .doc,
        "application/vnd.oasis.opendocument.text": .doc,
        "application/rtf": .doc,
        "application/vnd.google-apps.document": .doc,

        "application/vnd.ms-excel": .sheet,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": .sheet,
        "application/vnd.oasis.opendocument.spreadsheet": .sheet,
        "application/vnd.google-apps.spreadsheet": .sheet,
        "text/csv": .sheet,
        "text/tab-separated-values": .sheet,

        "application/vnd.ms-powerpoint": .slide,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": .slide,
        "application/vnd.oasis.opendocument.presentation": .slide,
        "application/vnd.google-apps.presentation": .slide,

        "application/zip": .archive,
        "application/x-zip-compressed": .archive,
        "application/x-tar": .archive,
        "application/x-rar-compressed": .archive,
        "application/vnd.rar": .archive,
        "application/x-7z-compressed": .archive,
        "application/gzip": .archive,
        "application/x-gzip": .archive,
        "application/x-bzip2": .archive,

        "text/calendar": .calendar,
        "application/ics": .calendar,

        "message/rfc822": .email,
        "application/vnd.ms-outlook": .email,

        "application/json": .code,
        "application/xml": .code,
        "text/xml": .code,
        "application/javascript": .code,
        "text/javascript": .code,
        "application/typescript": .code,
        "application/x-typescript": .code,
        "text/x-shellscript": .code,
        "application/x-sh": .code,
        "application/x-yaml": .code,
        "text/yaml": .code,
        "text/x-yaml": .code,
        "text/html": .code,
        "text/css": .code,

        "text/markdown": .text,
        "text/plain": .text,
    ]

    /// Filename extension → kind. Mirrors `EXT_TO_KIND` in the portal helper.
    private static let extToKind: [String: FileTypeKind] = [
        "pdf": .pdf,

        "doc": .doc, "docx": .doc, "rtf": .doc, "odt": .doc, "pages": .doc,

        "xls": .sheet, "xlsx": .sheet, "csv": .sheet, "tsv": .sheet,
        "ods": .sheet, "numbers": .sheet,

        "ppt": .slide, "pptx": .slide, "odp": .slide, "key": .slide,

        "png": .image, "jpg": .image, "jpeg": .image, "gif": .image,
        "webp": .image, "bmp": .image, "tiff": .image, "tif": .image,
        "svg": .image, "heic": .image, "heif": .image, "ico": .image, "avif": .image,

        "zip": .archive, "tar": .archive, "gz": .archive, "tgz": .archive,
        "rar": .archive, "7z": .archive, "bz2": .archive, "xz": .archive,

        "ics": .calendar, "ical": .calendar,

        "eml": .email, "msg": .email, "mbox": .email,

        "json": .code, "xml": .code, "yaml": .code, "yml": .code,
        "js": .code, "mjs": .code, "cjs": .code,
        "ts": .code, "tsx": .code, "jsx": .code,
        "py": .code, "rb": .code, "go": .code, "rs": .code, "java": .code,
        "c": .code, "cpp": .code, "h": .code, "hpp": .code,
        "sh": .code, "zsh": .code, "bash": .code,
        "sql": .code, "toml": .code, "ini": .code, "conf": .code, "cfg": .code,
        "html": .code, "htm": .code, "css": .code, "scss": .code,

        "mp3": .audio, "m4a": .audio, "wav": .audio, "flac": .audio,
        "ogg": .audio, "aac": .audio, "opus": .audio,

        "mp4": .video, "mov": .video, "webm": .video, "mkv": .video, "avi": .video,

        "txt": .text, "md": .text, "markdown": .text, "log": .text,
    ]

    /// Resolve a kind from a MIME type. `image/*`, `audio/*`, `video/*`,
    /// and `text/*` fall through to the catch-all branch so an
    /// unspecified `image/heic-sequence` still gets the image icon.
    static func kind(fromMime mime: String?) -> FileTypeKind? {
        guard let mime, !mime.isEmpty else { return nil }
        let lower = mime.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let direct = mimeToKind[lower] { return direct }
        if lower.hasPrefix("image/") { return .image }
        if lower.hasPrefix("audio/") { return .audio }
        if lower.hasPrefix("video/") { return .video }
        if lower.hasPrefix("text/") { return .text }
        return nil
    }

    /// Resolve a kind from a filename's extension.
    static func kind(fromFilename filename: String?) -> FileTypeKind? {
        guard let filename, !filename.isEmpty else { return nil }
        // Strip query / fragment in case the "filename" is actually a URL.
        let trimmed = filename.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? filename
        guard let dot = trimmed.lastIndex(of: "."), dot < trimmed.index(before: trimmed.endIndex) else {
            return nil
        }
        let ext = trimmed[trimmed.index(after: dot)...].lowercased()
        return extToKind[String(ext)]
    }

    /// Resolve a kind from `(mimeType, filename)` — MIME wins, extension
    /// is the fallback. Returns nil only if neither resolves.
    static func kind(mimeType: String?, filename: String?) -> FileTypeKind? {
        kind(fromMime: mimeType) ?? kind(fromFilename: filename)
    }

    /// Short uppercase label. Prefers the filename extension ("DOCX" wins
    /// over the kind-level "DOCUMENT") when available — matches the
    /// portal so users see the exact format. Falls back to the MIME
    /// kind's label, then "FILE".
    static func label(mimeType: String?, filename: String?) -> String {
        if let filename {
            let trimmed = filename.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? filename
            if let dot = trimmed.lastIndex(of: "."), dot < trimmed.index(before: trimmed.endIndex) {
                let ext = trimmed[trimmed.index(after: dot)...].uppercased()
                if !ext.isEmpty, ext.count <= 5 { return String(ext) }
            }
        }
        if let k = kind(fromMime: mimeType) { return k.label.uppercased() }
        return "FILE"
    }
}

/// Small coloured SF Symbol matching the portal's `FileTypeIcon` glyph.
/// Default size mirrors the portal's 16pt default; callers pass 14 or
/// 18 where they need denser / heavier presentation.
@available(iOS 17.0, *)
struct FileTypeIcon: View {
    let mimeType: String?
    let filename: String?
    var size: CGFloat = 16

    private var resolved: FileTypeKind {
        FileTypeIcons.kind(mimeType: mimeType, filename: filename) ?? .file
    }

    var body: some View {
        Image(systemName: resolved.systemImage)
            .font(.system(size: size))
            .foregroundStyle(resolved.color)
            .frame(width: size + 2, height: size + 2)
            .accessibilityLabel(resolved.label)
    }
}

/// The portal's `.file-type-pill` rendered as a SwiftUI chip — coloured
/// icon + short uppercase label ("PDF", "DOCX", "ICS", …). Used in
/// search-result rows and document detail headers wherever the
/// document type is "attachment" / "file".
@available(iOS 17.0, *)
struct FileTypePill: View {
    let mimeType: String?
    let filename: String?
    var iconSize: CGFloat = 12

    private var kind: FileTypeKind {
        FileTypeIcons.kind(mimeType: mimeType, filename: filename) ?? .file
    }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: kind.systemImage)
                .font(.system(size: iconSize))
                .foregroundStyle(kind.color)
            Text(FileTypeIcons.label(mimeType: mimeType, filename: filename))
                .font(.system(size: 10, weight: .semibold))
                .tracking(0.3)
                .foregroundStyle(Theme.textSecondary)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Theme.bgTertiary)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("File-type icons + pills") {
    let samples: [(mime: String?, filename: String?)] = [
        ("application/pdf", "report.pdf"),
        ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "notes.docx"),
        ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "budget.xlsx"),
        ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "deck.pptx"),
        ("image/png", "screenshot.png"),
        ("application/zip", "archive.zip"),
        ("text/calendar", "invite.ics"),
        ("message/rfc822", "thread.eml"),
        ("application/json", "config.json"),
        ("audio/mpeg", "song.mp3"),
        ("video/mp4", "clip.mp4"),
        ("text/plain", "note.txt"),
        (nil, "unknown.xyz"),
    ]
    return ScrollView {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(samples.enumerated()), id: \.offset) { _, sample in
                HStack(spacing: 12) {
                    FileTypeIcon(mimeType: sample.mime, filename: sample.filename, size: 18)
                    Text(sample.filename ?? "—")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textPrimary)
                    Spacer()
                    FileTypePill(mimeType: sample.mime, filename: sample.filename)
                }
                .padding(.horizontal, Theme.Spacing.md)
                .padding(.vertical, 4)
            }
        }
        .padding(.vertical, Theme.Spacing.lg)
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}
#endif
#endif
