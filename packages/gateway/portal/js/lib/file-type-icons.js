// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";

/**
 * File-type icons. Lucide-style glyphs (ISC-licensed visual language)
 * inlined here so the portal stays dependency-free. Colours follow the
 * conventional cues users already recognise (red PDF, green sheet, blue
 * doc, orange slide deck) without using any vendor-specific logo art —
 * we get the instant-recognition benefit while staying clear of
 * Adobe / Microsoft / Google trademark concerns.
 *
 * Resolution is `mimeType` first, then filename extension. Search-result
 * rows fall back on the extension because the search response does not
 * currently project metadata.extra.mimeType; document-detail surfaces
 * pass both, so we lock in the precise mime kind.
 */

const KIND = {
  pdf: "pdf",
  doc: "doc",
  sheet: "sheet",
  slide: "slide",
  image: "image",
  archive: "archive",
  calendar: "calendar",
  email: "email",
  code: "code",
  audio: "audio",
  video: "video",
  text: "text",
  file: "file",
};

const MIME_TO_KIND = {
  "application/pdf": KIND.pdf,

  "application/msword": KIND.doc,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": KIND.doc,
  "application/vnd.oasis.opendocument.text": KIND.doc,
  "application/rtf": KIND.doc,
  "application/vnd.google-apps.document": KIND.doc,

  "application/vnd.ms-excel": KIND.sheet,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": KIND.sheet,
  "application/vnd.oasis.opendocument.spreadsheet": KIND.sheet,
  "application/vnd.google-apps.spreadsheet": KIND.sheet,
  "text/csv": KIND.sheet,
  "text/tab-separated-values": KIND.sheet,

  "application/vnd.ms-powerpoint": KIND.slide,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": KIND.slide,
  "application/vnd.oasis.opendocument.presentation": KIND.slide,
  "application/vnd.google-apps.presentation": KIND.slide,

  "application/zip": KIND.archive,
  "application/x-zip-compressed": KIND.archive,
  "application/x-tar": KIND.archive,
  "application/x-rar-compressed": KIND.archive,
  "application/vnd.rar": KIND.archive,
  "application/x-7z-compressed": KIND.archive,
  "application/gzip": KIND.archive,
  "application/x-gzip": KIND.archive,
  "application/x-bzip2": KIND.archive,

  "text/calendar": KIND.calendar,
  "application/ics": KIND.calendar,

  "message/rfc822": KIND.email,
  "application/vnd.ms-outlook": KIND.email,

  "application/json": KIND.code,
  "application/xml": KIND.code,
  "text/xml": KIND.code,
  "application/javascript": KIND.code,
  "text/javascript": KIND.code,
  "application/typescript": KIND.code,
  "application/x-typescript": KIND.code,
  "text/x-shellscript": KIND.code,
  "application/x-sh": KIND.code,
  "application/x-yaml": KIND.code,
  "text/yaml": KIND.code,
  "text/x-yaml": KIND.code,
  "text/html": KIND.code,
  "text/css": KIND.code,

  "text/markdown": KIND.text,
  "text/plain": KIND.text,
};

const EXT_TO_KIND = {
  pdf: KIND.pdf,

  doc: KIND.doc,
  docx: KIND.doc,
  rtf: KIND.doc,
  odt: KIND.doc,
  pages: KIND.doc,

  xls: KIND.sheet,
  xlsx: KIND.sheet,
  csv: KIND.sheet,
  tsv: KIND.sheet,
  ods: KIND.sheet,
  numbers: KIND.sheet,

  ppt: KIND.slide,
  pptx: KIND.slide,
  odp: KIND.slide,
  key: KIND.slide,

  png: KIND.image,
  jpg: KIND.image,
  jpeg: KIND.image,
  gif: KIND.image,
  webp: KIND.image,
  bmp: KIND.image,
  tiff: KIND.image,
  tif: KIND.image,
  svg: KIND.image,
  heic: KIND.image,
  heif: KIND.image,
  ico: KIND.image,
  avif: KIND.image,

  zip: KIND.archive,
  tar: KIND.archive,
  gz: KIND.archive,
  tgz: KIND.archive,
  rar: KIND.archive,
  "7z": KIND.archive,
  bz2: KIND.archive,
  xz: KIND.archive,

  ics: KIND.calendar,
  ical: KIND.calendar,

  eml: KIND.email,
  msg: KIND.email,
  mbox: KIND.email,

  json: KIND.code,
  xml: KIND.code,
  yaml: KIND.code,
  yml: KIND.code,
  js: KIND.code,
  mjs: KIND.code,
  cjs: KIND.code,
  ts: KIND.code,
  tsx: KIND.code,
  jsx: KIND.code,
  py: KIND.code,
  rb: KIND.code,
  go: KIND.code,
  rs: KIND.code,
  java: KIND.code,
  c: KIND.code,
  cpp: KIND.code,
  h: KIND.code,
  hpp: KIND.code,
  sh: KIND.code,
  zsh: KIND.code,
  bash: KIND.code,
  sql: KIND.code,
  toml: KIND.code,
  ini: KIND.code,
  conf: KIND.code,
  cfg: KIND.code,
  html: KIND.code,
  htm: KIND.code,
  css: KIND.code,
  scss: KIND.code,

  mp3: KIND.audio,
  m4a: KIND.audio,
  wav: KIND.audio,
  flac: KIND.audio,
  ogg: KIND.audio,
  aac: KIND.audio,
  opus: KIND.audio,

  mp4: KIND.video,
  mov: KIND.video,
  webm: KIND.video,
  mkv: KIND.video,
  avi: KIND.video,

  txt: KIND.text,
  md: KIND.text,
  markdown: KIND.text,
  log: KIND.text,
};

/**
 * Lucide-style icon definitions (viewBox 0 0 24, stroke-width 2).
 * `inner` is inserted via dangerouslySetInnerHTML — keeps the icon set
 * declarative without pulling in lucide-react/preact.
 */
const ICONS = {
  pdf: {
    label: "PDF",
    color: "#dc2626",
    inner: `
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M10 9H8"/>
      <path d="M16 13H8"/>
      <path d="M16 17H8"/>
    `,
  },
  doc: {
    label: "Document",
    color: "#2563eb",
    inner: `
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M10 9H8"/>
      <path d="M16 13H8"/>
      <path d="M16 17H8"/>
    `,
  },
  sheet: {
    label: "Spreadsheet",
    color: "#16a34a",
    inner: `
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M8 13h2"/>
      <path d="M14 13h2"/>
      <path d="M8 17h2"/>
      <path d="M14 17h2"/>
    `,
  },
  slide: {
    label: "Presentation",
    color: "#ea580c",
    inner: `
      <path d="M2 3h20"/>
      <path d="M21 3v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3"/>
      <path d="m7 21 5-5 5 5"/>
    `,
  },
  image: {
    label: "Image",
    color: "#a855f7",
    inner: `
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <circle cx="10" cy="13" r="2"/>
      <path d="m20 17-1.296-1.296a2.41 2.41 0 0 0-3.408 0L9 22"/>
    `,
  },
  archive: {
    label: "Archive",
    color: "#ca8a04",
    inner: `
      <rect width="20" height="5" x="2" y="3" rx="1"/>
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/>
      <path d="M10 12h4"/>
    `,
  },
  calendar: {
    label: "Calendar",
    color: "#0891b2",
    inner: `
      <path d="M8 2v4"/>
      <path d="M16 2v4"/>
      <rect width="18" height="18" x="3" y="4" rx="2"/>
      <path d="M3 10h18"/>
    `,
  },
  email: {
    label: "Email",
    color: "#64748b",
    inner: `
      <rect width="20" height="16" x="2" y="4" rx="2"/>
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
    `,
  },
  code: {
    label: "Code",
    color: "#64748b",
    inner: `
      <path d="M10 12.5 8 15l2 2.5"/>
      <path d="m14 12.5 2 2.5-2 2.5"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
    `,
  },
  audio: {
    label: "Audio",
    color: "#db2777",
    inner: `
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    `,
  },
  video: {
    label: "Video",
    color: "#db2777",
    inner: `
      <path d="m10 11 5 3-5 3v-6Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
    `,
  },
  text: {
    label: "Text",
    color: "#64748b",
    inner: `
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
      <path d="M10 9H8"/>
      <path d="M16 13H8"/>
      <path d="M16 17H8"/>
    `,
  },
  file: {
    label: "File",
    color: "#94a3b8",
    inner: `
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/>
      <path d="M14 2v4a2 2 0 0 0 2 2h4"/>
    `,
  },
};

export function fileTypeKindFromMime(mimeType) {
  if (!mimeType) return null;
  const lower = mimeType.toLowerCase().trim();
  if (MIME_TO_KIND[lower]) return MIME_TO_KIND[lower];
  if (lower.startsWith("image/")) return KIND.image;
  if (lower.startsWith("audio/")) return KIND.audio;
  if (lower.startsWith("video/")) return KIND.video;
  if (lower.startsWith("text/")) return KIND.text;
  return null;
}

export function fileTypeKindFromFilename(filename) {
  if (!filename) return null;
  const cleaned = String(filename).split(/[?#]/)[0];
  const idx = cleaned.lastIndexOf(".");
  if (idx < 0 || idx === cleaned.length - 1) return null;
  const ext = cleaned.slice(idx + 1).toLowerCase();
  return EXT_TO_KIND[ext] ?? null;
}

export function fileTypeKind({ mimeType, filename } = {}) {
  return fileTypeKindFromMime(mimeType) ?? fileTypeKindFromFilename(filename);
}

/**
 * Short uppercase label. Prefers the filename extension ("DOCX" wins
 * over the kind-level "DOCUMENT") when available, so users see the
 * exact format. Falls back to the mime kind, then "FILE".
 */
export function fileTypeLabel({ mimeType, filename } = {}) {
  if (filename) {
    const cleaned = String(filename).split(/[?#]/)[0];
    const idx = cleaned.lastIndexOf(".");
    if (idx >= 0 && idx < cleaned.length - 1) {
      const ext = cleaned.slice(idx + 1).toUpperCase();
      if (ext.length > 0 && ext.length <= 5) return ext;
    }
  }
  const kind = fileTypeKindFromMime(mimeType);
  return kind ? ICONS[kind].label.toUpperCase() : "FILE";
}

export function FileTypeIcon({ mimeType, filename, size = 16, title }) {
  const kind = fileTypeKind({ mimeType, filename }) ?? KIND.file;
  const icon = ICONS[kind];
  const tip = title ?? icon.label;
  return html`<svg
    class="file-type-icon"
    viewBox="0 0 24 24"
    width=${size}
    height=${size}
    fill="none"
    stroke=${icon.color}
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    role="img"
    aria-label=${tip}
    dangerouslySetInnerHTML=${{ __html: `<title>${escapeXml(tip)}</title>${icon.inner}` }}
  />`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
