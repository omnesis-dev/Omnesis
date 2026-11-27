// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Generic Lucide `message-square` and `phone-call` glyphs (ISC-licensed, see
 * `TRADEMARKS.md`), not Omamobile's or omatel's own marks. Tinted a neutral
 * teal; bg is a dimmed wash of the same hue for dark-mode surfaces. The SF
 * Symbol is iOS's instant-render fallback.
 */
const MESSAGE_SQUARE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0D9488" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/></svg>`;

const PHONE_CALL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0D9488" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2a9 9 0 0 1 9 9"/><path d="M13 6a5 5 0 0 1 5 5"/><path d="M14.05 2a13 13 0 0 1 8 8"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

const dataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

export const omatelMessagesIcon: SourceIcon = {
  sfSymbol: "message.fill",
  color: "#0D9488",
  bgColor: "#0F2A28",
  imageDataUri: dataUri(MESSAGE_SQUARE_SVG),
};

export const omatelCallsIcon: SourceIcon = {
  sfSymbol: "phone.fill",
  color: "#0D9488",
  bgColor: "#0F2A28",
  imageDataUri: dataUri(PHONE_CALL_SVG),
};
