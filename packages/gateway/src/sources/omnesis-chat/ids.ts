// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The omnesis-chat source's identity, split out from `source-meta.ts` so a
 * consumer can name the source without pulling that module's brand-asset
 * pipeline (`node:fs`, `node:path`, the icon normalizer's worker) behind it.
 *
 * The cognition-authored registry needs exactly these two strings, and it is
 * read on the retrieval hot path — so it depends on this leaf, not on the
 * display metadata that happens to live beside it.
 */

export const OMNESIS_CHAT_SOURCE_ID = "omnesis-chat";
export const OMNESIS_CHAT_PROVIDER_ID = "system";
