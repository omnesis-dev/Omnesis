// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export const SOURCE_ICON_MAX_BYTES = 1 * 1024 * 1024;

// Base64 expands bytes by 4/3; the small allowance covers the data-URI header.
export const SOURCE_ICON_MAX_INPUT_CHARS = Math.ceil((SOURCE_ICON_MAX_BYTES * 4) / 3) + 128;
