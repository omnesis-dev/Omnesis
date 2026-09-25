// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Command-line parsing for the install/update lane's scripts.
 *
 * Each script declares, per subcommand, the flags it takes: `values` carry a
 * string, `numbers` a finite number, `booleans` nothing. Anything else is
 * refused, so a misspelt flag fails loudly instead of quietly falling back to
 * a default; a flag named in `required` must be given.
 */

/**
 * @param {string[]} argv the arguments after the script path
 * @param {Record<string, {values?: string[], numbers?: string[], booleans?: string[], required?: string[]}>} spec
 * @returns {{command: string, flags: Record<string, string | number | boolean>}}
 */
export function parseCommand(argv, spec) {
  const [command, ...rest] = argv;
  const accepts = Object.hasOwn(spec, command ?? "") ? spec[command] : undefined;
  if (!accepts) throw new Error(`usage: <${Object.keys(spec).join("|")}> [flags]`);
  const values = new Set(accepts.values ?? []);
  const numbers = new Set(accepts.numbers ?? []);
  const booleans = new Set(accepts.booleans ?? []);
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`${command}: unexpected argument ${arg}`);
    const key = arg.slice(2);
    if (booleans.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!values.has(key) && !numbers.has(key)) throw new Error(`${command}: unknown flag ${arg}`);
    const value = rest[++i];
    if (value === undefined) throw new Error(`${command}: ${arg} needs a value`);
    if (numbers.has(key)) {
      const n = Number(value);
      if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
        throw new Error(`${command}: ${arg} needs a non-negative number, got ${value}`);
      }
      flags[key] = n;
    } else {
      flags[key] = value;
    }
  }
  for (const key of accepts.required ?? []) {
    if (!(key in flags)) throw new Error(`${command}: --${key} is required`);
  }
  return { command, flags };
}
