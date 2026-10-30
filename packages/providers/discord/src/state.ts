// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the Discord source persists between runs.
 *
 * The cursor is a per-channel watermark plus the queue of channels a cycle
 * has still to visit. Version 1: there is no earlier shape to migrate from.
 *
 * `rebootstrap` is the right answer to a value this build cannot read.
 * Discord keeps every message until someone deletes it, and a channel is
 * re-walked under its own ids, so a discarded cursor costs requests and
 * re-renders the same documents rather than losing any.
 */

import { isDiscordCursor } from "./types.js";
import type { SourceStateSpec } from "@omnesis/source-sdk";
import type { DiscordCursor } from "./types.js";

export const discordStateSpec: SourceStateSpec<DiscordCursor> = {
  version: 1,
  decode: (value) => (isDiscordCursor(value) ? value : null),
  onUnreadable: "rebootstrap",
};
