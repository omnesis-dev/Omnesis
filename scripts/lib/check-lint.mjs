// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ESLint } from "eslint";

/** Discover the same configured file types as `eslint .`, including hidden files. */
export async function collectLintFiles(cwd) {
  // Let ESLint own directory ignores, file matching and symlink semantics.
  // Discovery uses an empty AST so it cannot load TypeScript programs or run
  // rules. Actual lint subprocesses use the untouched configuration below.
  const eslint = new ESLint({
    cwd,
    allowInlineConfig: false,
    ruleFilter: () => false,
    overrideConfig: {
      languageOptions: {
        parser: {
          parse: () => ({
            type: "Program",
            body: [],
            sourceType: "module",
            tokens: [],
            comments: [],
            range: [0, 0],
            loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } },
          }),
        },
      },
    },
  });
  const results = await eslint.lintFiles(["."]);
  const unreadable = results.find((result) => result.fatalErrorCount > 0);
  if (unreadable)
    throw new Error(
      `Cannot discover lint file ${unreadable.filePath}: ${unreadable.messages.map((message) => message.message).join("; ")}`,
    );
  return results.map((result) => result.filePath).sort();
}

/** Reset typed-rule caches between bounded subprocesses without changing rules. */
export async function runFullLint({ cwd, executable, env, run, batchSize = 500 }) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Invalid lint batch size");
  const files = await collectLintFiles(cwd);
  // Preserve ESLint's normal no-matching-files/configuration error behavior.
  if (files.length === 0) return run(process.execPath, [executable, "."], env);
  let result = 0;
  for (let start = 0; start < files.length; start += batchSize) {
    const batch = files.slice(start, start + batchSize);
    process.stderr.write(
      `[check] lint files ${start + 1}-${start + batch.length}/${files.length}\n`,
    );
    const code = await run(process.execPath, [executable, "--", ...batch], env);
    // Lint diagnostics should not hide diagnostics in subsequent batches. An
    // infrastructure/configuration failure cannot safely continue linting.
    if (code !== 0 && code !== 1) return code;
    result = Math.max(result, code);
  }
  return result;
}
