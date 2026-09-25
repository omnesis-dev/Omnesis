// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const MAX_LCS_CELLS = 250_000;
const MAX_CHARACTER_CELLS = 40_000;

function commonEdges(before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;
  return { prefix, suffix };
}

function boundedLcs(before, after, maxCells) {
  if (before.length * after.length > maxCells) return null;
  const widths = after.length + 1;
  const table = new Uint32Array((before.length + 1) * widths);
  for (let left = before.length - 1; left >= 0; left--) {
    for (let right = after.length - 1; right >= 0; right--) {
      const offset = left * widths + right;
      table[offset] = before[left] === after[right]
        ? table[(left + 1) * widths + right + 1] + 1
        : Math.max(table[(left + 1) * widths + right], table[offset + 1]);
    }
  }
  const changes = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      changes.push({ kind: "same", value: before[left] });
      left++;
      right++;
    } else if (table[(left + 1) * widths + right] >= table[left * widths + right + 1]) {
      changes.push({ kind: "remove", value: before[left++] });
    } else {
      changes.push({ kind: "add", value: after[right++] });
    }
  }
  while (left < before.length) changes.push({ kind: "remove", value: before[left++] });
  while (right < after.length) changes.push({ kind: "add", value: after[right++] });
  return changes;
}

function fallbackChanges(before, after) {
  const { prefix, suffix } = commonEdges(before, after);
  return [
    ...before.slice(0, prefix).map((value) => ({ kind: "same", value })),
    ...before.slice(prefix, before.length - suffix).map((value) => ({ kind: "remove", value })),
    ...after.slice(prefix, after.length - suffix).map((value) => ({ kind: "add", value })),
    ...before.slice(before.length - suffix).map((value) => ({ kind: "same", value })),
  ];
}

function diffSequence(before, after, maxCells) {
  return boundedLcs(before, after, maxCells) ?? fallbackChanges(before, after);
}

export function characterDiff(before, after) {
  const beforeCharacters = [...before];
  const afterCharacters = [...after];
  const precise = boundedLcs(beforeCharacters, afterCharacters, MAX_CHARACTER_CELLS);
  if (precise) return precise;
  const { prefix, suffix } = commonEdges(beforeCharacters, afterCharacters);
  return [
    ...(prefix ? [{ kind: "same", value: beforeCharacters.slice(0, prefix).join("") }] : []),
    ...(beforeCharacters.length > prefix + suffix
      ? [{ kind: "remove", value: beforeCharacters.slice(prefix, beforeCharacters.length - suffix).join("") }]
      : []),
    ...(afterCharacters.length > prefix + suffix
      ? [{ kind: "add", value: afterCharacters.slice(prefix, afterCharacters.length - suffix).join("") }]
      : []),
    ...(suffix
      ? [{ kind: "same", value: beforeCharacters.slice(beforeCharacters.length - suffix).join("") }]
      : []),
  ];
}

export function policyDiff(before, after) {
  const changes = diffSequence(before.split("\n"), after.split("\n"), MAX_LCS_CELLS);
  const rows = [];
  let oldLine = 1;
  let newLine = 1;
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (change.kind === "same") {
      rows.push({ kind: "same", oldLine: oldLine++, newLine: newLine++, text: change.value });
      index++;
      continue;
    }
    const removed = [];
    const added = [];
    while (changes[index] && changes[index].kind !== "same") {
      if (changes[index].kind === "remove") removed.push(changes[index].value);
      else added.push(changes[index].value);
      index++;
    }
    const paired = Math.min(removed.length, added.length);
    for (let pair = 0; pair < paired; pair++) {
      const spans = characterDiff(removed[pair], added[pair]);
      rows.push({ kind: "remove", oldLine: oldLine++, newLine: null, text: removed[pair], spans });
      rows.push({ kind: "add", oldLine: null, newLine: newLine++, text: added[pair], spans });
    }
    for (let offset = paired; offset < removed.length; offset++) {
      rows.push({ kind: "remove", oldLine: oldLine++, newLine: null, text: removed[offset] });
    }
    for (let offset = paired; offset < added.length; offset++) {
      rows.push({ kind: "add", oldLine: null, newLine: newLine++, text: added[offset] });
    }
  }
  return rows;
}

/** Collapse only unchanged runs; every changed row remains reviewable. */
export function compactPolicyDiff(before, after, contextLines = 2) {
  const rows = policyDiff(before, after);
  const compact = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].kind !== "same") {
      compact.push(rows[index++]);
      continue;
    }
    const start = index;
    while (rows[index]?.kind === "same") index++;
    const run = rows.slice(start, index);
    if (run.length <= contextLines * 2 + 1) compact.push(...run);
    else compact.push(
      ...run.slice(0, contextLines),
      { kind: "omitted", count: run.length - contextLines * 2 },
      ...run.slice(-contextLines),
    );
  }
  return compact;
}

/** Page a potentially all-changed 64k document without hiding any changes. */
export function policyDiffPage(before, after, page = 0, pageSize = 1_000) {
  const rows = compactPolicyDiff(before, after);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  return {
    rows: rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize),
    page: currentPage,
    totalPages,
    totalRows: rows.length,
  };
}
