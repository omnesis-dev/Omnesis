// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SourceSyncMeta } from "@omnesis/source-sdk";
import type { RegisteredSource } from "./sync-engine-types.js";

/**
 * What the gateway is told about how to display a source.
 *
 * Two callers push this — the boot-time refresh and every sync cycle — and
 * they were separate transcriptions of the same field list, which is how one
 * of them can quietly stop carrying a field the other does.
 *
 * The label and icon here are the source's *own*: a per-instance override
 * wins, so a source that resolves its display name mid-lifetime (an account
 * nickname fetched during sync, a connection named after its institution)
 * propagates it on the next cycle. `family` is the definition's own name and
 * icon, unoverridden — the identity a client shows when it groups by type
 * rather than by account, and the one thing here that cannot be recovered from
 * any single account.
 */
export function sourceDisplayMeta(
  source: RegisteredSource,
): Omit<SourceSyncMeta, "contentRetention"> {
  return {
    account: source.account,
    icon: source.icon?.url ?? source.icon?.imageDataUri,
    label: source.instance.label ?? source.name,
    urlPatterns: source.urlPatterns,
    bgColor: source.icon?.bgColor,
    accentColor: source.icon?.color,
    family: {
      icon: source.family.icon?.url ?? source.family.icon?.imageDataUri,
      label: source.family.name,
      bgColor: source.family.icon?.bgColor,
      accentColor: source.family.icon?.color,
    },
  };
}
