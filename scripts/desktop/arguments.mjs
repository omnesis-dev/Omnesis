// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Strict named arguments keep a misspelled output or architecture from silently defaulting. */
export function parseArguments(argv, { values, booleans = [], required = [] }) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) throw new Error(`Expected a named flag: ${flag}`);
    const name = flag.slice(2);
    if (result.has(name)) throw new Error(`Repeated --${name}`);
    if (booleans.includes(name)) result.set(name, true);
    else if (values.includes(name)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
      result.set(name, value);
    } else throw new Error(`Unknown --${name}`);
  }
  for (const name of required) if (!result.has(name)) throw new Error(`Missing --${name}`);
  return result;
}
