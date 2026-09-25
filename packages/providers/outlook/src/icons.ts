// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Hot-linked at runtime — Microsoft's FY26 Outlook product icon, served
 * by Microsoft's Scene7 CDN as referenced from the official Microsoft 365
 * Outlook product page. Permissive CORS, scalable SVG. See `TRADEMARKS.md`.
 */
export const outlookIconUrl =
  "https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/Outlook-Icon-FY26?resMode=sharp2&op_usm=1.5,0.65,15,0&wid=128&hei=128&qlt=100&fmt=png-alpha&fit=constrain";

/**
 * Hot-linked at runtime — Microsoft's OneDrive product icon, served by
 * Microsoft's Scene7 CDN as referenced from the official Microsoft 365 OneDrive
 * product page. Permissive CORS, scalable. See `TRADEMARKS.md`.
 */
export const oneDriveIconUrl =
  "https://cdn-dynmedia-1.microsoft.com/is/content/microsoftcorp/OneDrive-Icon-FY26?resMode=sharp2&op_usm=1.5,0.65,15,0&wid=128&hei=128&qlt=100&fmt=png-alpha&fit=constrain";

/**
 * Outlook Calendar has no distinct hosted product icon: Microsoft's FY26
 * branding folds mail and calendar into the single Outlook icon, so the
 * Scene7 CDN serves only `Outlook-Icon-FY26` for both. Reusing it would make
 * the calendar source visually indistinguishable from the email source, so
 * this package owns a calendar glyph instead — a generic Lucide `calendar`
 * (MIT-licensed, see `TRADEMARKS.md`) tinted to the Outlook brand blue and
 * embedded as a data URI so the manifest stays self-contained.
 */
const CALENDAR_LUCIDE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>`;

export const outlookCalendarIconDataUri = `data:image/svg+xml;base64,${Buffer.from(
  CALENDAR_LUCIDE_SVG.replace(/stroke="currentColor"/g, `stroke="#0078D4"`),
).toString("base64")}`;
