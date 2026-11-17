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
      dependencies: { "@openai/codex": "0.169.0" },
    },
    "node_modules/@openai/codex": {
      version: "0.169.0",
      resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0.tgz",
      integrity:
        "sha512-KhzYlkKPxoNssR8CEm45IjqnFWn7UtlF4CiD3tOJPea51xBs7MaHy0UQG9GSbCqk6Lrjn5QdJDV0QD1/FgWlGw==",
      license: "Apache-2.0",
      bin: { codex: "bin/codex.js" },
      engines: { node: ">=16" },
      optionalDependencies: {
        "@openai/codex-darwin-arm64": "npm:@openai/codex@0.169.0-darwin-arm64",
        "@openai/codex-darwin-x64": "npm:@openai/codex@0.169.0-darwin-x64",
        "@openai/codex-linux-arm64": "npm:@openai/codex@0.169.0-linux-arm64",
        "@openai/codex-linux-x64": "npm:@openai/codex@0.169.0-linux-x64",
        "@openai/codex-win32-arm64": "npm:@openai/codex@0.169.0-win32-arm64",
        "@openai/codex-win32-x64": "npm:@openai/codex@0.169.0-win32-x64",
      },
    },
    "node_modules/@openai/codex-darwin-arm64": platform(
      "0.169.0-darwin-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-darwin-arm64.tgz",
      "sha512-5WsWFBbVP78D+6FvNo1MMVxLPZdmcoQlqVJFrF4qx/TmvneLnMQKtLyXkUo54XOTDfoYKpNouTJ/F7gTVA8FnQ==",
      "darwin",
      "arm64",
    ),
    "node_modules/@openai/codex-darwin-x64": platform(
      "0.169.0-darwin-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-darwin-x64.tgz",
      "sha512-K1FKSsSLl9v3z5TeagBQXyQRDBIGB5Jncy5dxsRxwT3aaTqN3AI8VrCfoxBxKMOOU9O2QX1vg7WkBwNVth/s9A==",
      "darwin",
      "x64",
    ),
    "node_modules/@openai/codex-linux-arm64": platform(
      "0.169.0-linux-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-linux-arm64.tgz",
      "sha512-NZ/DaQUpcQmxmqee7Z9uC1rzw3GhSbooawcaTe1LN5Yk+WlinUKGdTXJgClRT/9ogQEEM9TWxYzvxPfj5G/xFg==",
      "linux",
      "arm64",
    ),
    "node_modules/@openai/codex-linux-x64": platform(
      "0.169.0-linux-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-linux-x64.tgz",
      "sha512-o05NyAOCDygSPRo1yinzxvkRSdmsZyBD9E7mbpmjRanSfM8lypqWtQgEo4XfNkwhuCR2aFu8mlGOsQGFXVbVww==",
      "linux",
      "x64",
    ),
    "node_modules/@openai/codex-win32-arm64": platform(
      "0.169.0-win32-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-win32-arm64.tgz",
      "sha512-nTN9SpkacGohq60+I80R3t0R8Mhbnlt3OVYNahgAv1Gu77KFwhPc0vz9Ou/DAGDtYhKVWA/jiYXJXnlzkwb/JA==",
      "win32",
      "arm64",
    ),
    "node_modules/@openai/codex-win32-x64": platform(
      "0.169.0-win32-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.169.0-win32-x64.tgz",
      "sha512-nC+McFU8xRNL9tk3IhxcKdhcyOElwF/HhPO+gzSQCY7yjh3XdzSajX+MYWcHUVHWRHajfwn3/WgJYJK2wS+XWg==",
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
