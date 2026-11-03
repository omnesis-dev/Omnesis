// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Release-pinned npm lock data for the Codex component runtime. `npm ci`
 * verifies these SRI digests before Omnesis executes either the wrapper or its
 * platform payload. Keep this in lockstep with CODEX_RUNTIME_COMPAT.
 */
export const CODEX_RUNTIME_LOCK = {
  name: "omnesis-codex-runtime",
  version: "0.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "omnesis-codex-runtime",
      version: "0.0.0",
      dependencies: { "@openai/codex": "0.166.0" },
    },
    "node_modules/@openai/codex": {
      version: "0.166.0",
      resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0.tgz",
      integrity:
        "sha512-2Szlp1l1cz5TX1ccpX4Zok3DZrot9xeZe0km+6/1v8JmqxADwyJxKBJah4dBymkwtS25j/u6dipJusTOI97Z8Q==",
      license: "Apache-2.0",
      bin: { codex: "bin/codex.js" },
      engines: { node: ">=16" },
      optionalDependencies: {
        "@openai/codex-darwin-arm64": "npm:@openai/codex@0.166.0-darwin-arm64",
        "@openai/codex-darwin-x64": "npm:@openai/codex@0.166.0-darwin-x64",
        "@openai/codex-linux-arm64": "npm:@openai/codex@0.166.0-linux-arm64",
        "@openai/codex-linux-x64": "npm:@openai/codex@0.166.0-linux-x64",
        "@openai/codex-win32-arm64": "npm:@openai/codex@0.166.0-win32-arm64",
        "@openai/codex-win32-x64": "npm:@openai/codex@0.166.0-win32-x64",
      },
    },
    "node_modules/@openai/codex-darwin-arm64": platform(
      "0.166.0-darwin-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-darwin-arm64.tgz",
      "sha512-5fWH6qqUInACcRADIewjlnRxDb4QLe0uriwehiZz0+viuAAB8I+WWefqw4xwHvyKaxeiGX4uK56+vrgfvFk3FQ==",
      "darwin",
      "arm64",
    ),
    "node_modules/@openai/codex-darwin-x64": platform(
      "0.166.0-darwin-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-darwin-x64.tgz",
      "sha512-Vj5wXJPizKmrzNtnRNQf9PP6FJkG3iJU/UO3NE4WvkENZGoQfmImdwf4MVRI5NgwjSuC6LT0HbBRHPVVnwGHuw==",
      "darwin",
      "x64",
    ),
    "node_modules/@openai/codex-linux-arm64": platform(
      "0.166.0-linux-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-linux-arm64.tgz",
      "sha512-w0ScAsBr9aZKtIFrh6HN6KU2yjKKeSCzYfbb7DB0Ccj4BYPzeZtUeQprbycLCwuX3AFQdbdjapmLho2iot74jQ==",
      "linux",
      "arm64",
    ),
    "node_modules/@openai/codex-linux-x64": platform(
      "0.166.0-linux-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-linux-x64.tgz",
      "sha512-CxDm3+D1cpbGJeHrdzINoG+3wn9BVncP4qpZaaNYkxe8iPtRJOYyCJnnPoVjWRIBvI9vPKbRoifsMSA5xDaUpw==",
      "linux",
      "x64",
    ),
    "node_modules/@openai/codex-win32-arm64": platform(
      "0.166.0-win32-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-win32-arm64.tgz",
      "sha512-LWO1cyGlxbKgeUM7QJ1a6QMSsJi++3PqgIi6BmIUBoj/kzZqRIR69UDMQgeU/9izzJFYMSbwt++lHnUFyjQXlA==",
      "win32",
      "arm64",
    ),
    "node_modules/@openai/codex-win32-x64": platform(
      "0.166.0-win32-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.166.0-win32-x64.tgz",
      "sha512-NS8Ps5oG5r19pCrMCUXwUqOui6odnUIoBlQkrjCJ+h1k6KiwCzC/+mI9d3nSZCqFoVONPBTmqyq8NYq3YaFGyA==",
      "win32",
      "x64",
    ),
  },
} as const;

function platform(version: string, resolved: string, integrity: string, os: string, cpu: string) {
  return {
    name: "@openai/codex",
    version,
    resolved,
    integrity,
    cpu: [cpu],
    license: "Apache-2.0",
    optional: true,
    os: [os],
    engines: { node: ">=16" },
  };
}
