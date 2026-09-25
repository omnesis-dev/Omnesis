// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceIcon } from "@omnesis/source-sdk";

/**
 * Descriptor-level icon for the Lunch Flow source. The SF Symbol is the
 * instant-render fallback — a bank building reads "bank connection" at a
 * glance; the gateway's icon normalizer hot-links Lunch Flow's favicon (via
 * Google's public favicon service, so no asset ships in the repo) when it can.
 * Brand wash is a neutral green.
 */
export const lunchflowIcon: SourceIcon = {
  sfSymbol: "building.columns.fill",
  color: "#1B7A4B",
  bgColor: "#13351F",
  url: "https://www.google.com/s2/favicons?domain=lunchflow.app&sz=128",
};
