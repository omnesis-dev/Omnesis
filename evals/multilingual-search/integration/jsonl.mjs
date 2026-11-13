// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** JSON Lines delimit records with LF; U+2028/U+2029 inside strings are data. */
export async function* jsonlRecords(stream) {
  stream.setEncoding("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += chunk;
    let offset;
    while ((offset = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, offset);
      pending = pending.slice(offset + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (pending.trim()) yield JSON.parse(pending);
}
