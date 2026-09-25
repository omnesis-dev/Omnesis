// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Source icon for Local Files. No vendor exists, so there is no brand to
// hotlink — the glyph is Lucide `folders` (ISC-licensed,
// https://lucide.dev/icons/folders) tinted to the source slate, embedded as
// a data URI so clients render without a network fetch.

const FOLDERS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.5a1.5 1.5 0 0 1 1.2.6l.6.8a1.5 1.5 0 0 0 1.2.6z"/><path d="M3 8.268a2 2 0 0 0-1 1.738V19a2 2 0 0 0 2 2h11a2 2 0 0 0 1.732-1"/></svg>`;

export const localFilesIconDataUri = `data:image/svg+xml;base64,${Buffer.from(FOLDERS_SVG).toString("base64")}`;
