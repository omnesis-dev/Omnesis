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
      dependencies: { "@openai/codex": "0.171.0" },
    },
    "node_modules/@openai/codex": {
      version: "0.171.0",
      resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.171.0.tgz",
      integrity:
        "sha512-1IOFzL2Xg86tLdw6kDo3GoKbkQENgQi7TI6rlEvN132R7ngSw7SNOIQoTcnKzSZZ8kf9N9GynCweSoaFbqk2Eg==",
      license: "Apache-2.0",
      bin: { codex: "bin/codex.js" },
      engines: { node: ">=16" },
      optionalDependencies: {
        "@openai/codex-darwin-arm64": "npm:@openai/codex@0.171.0-darwin-arm64",
        "@openai/codex-darwin-x64": "npm:@openai/codex@0.171.0-darwin-x64",
        "@openai/codex-linux-arm64": "npm:@openai/codex@0.171.0-linux-arm64",
        "@openai/codex-linux-x64": "npm:@openai/codex@0.171.0-linux-x64",
        "@openai/codex-win32-arm64": "npm:@openai/codex@0.171.0-win32-arm64",
        "@openai/codex-win32-x64": "npm:@openai/codex@0.171.0-win32-x64",
      },
    },
    "node_modules/@openai/codex-darwin-arm64": platform(
      "0.171.0-darwin-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.171.0-darwin-arm64.tgz",
      "sha512-hIYTkRUpuYpkVfTq4cpby0PXqhAVcIgE7f6FoyY1lt2RyARj3GXS1Can/dIYUBItVhXzhb98HYHZNzCX74QRlQ==",
      "darwin",
      "arm64",
    ),
    "node_modules/@openai/codex-darwin-x64": platform(
      "0.171.0-darwin-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.171.0-darwin-x64.tgz",
      "sha512-pwN5uNEKx/mZjwBEf/6CKq6SJMfJS5kruV3sJQAk7ebIPvC58Ote3CicIxETDZtjLj35rNv3PLPd7mHCg6hGPw==",
      "darwin",
      "x64",
    ),
    "node_modules/@openai/codex-linux-arm64": platform(
      "0.171.0-linux-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.171.0-linux-arm64.tgz",
      "sha512-9z17t4bbUJ9UCIb49O4PoA+ki+45q3rd8nZ8PeH6sYnlKkBld/Xpo/OS3h3Ti954+foshX4o7k5TCU8N7zzqQA==",
      "linux",
      "arm64",
    ),
    "node_modules/@openai/codex-linux-x64": platform(
      "0.171.0-linux-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.171.0-linux-x64.tgz",
      "sha512-l66NZkQgdk2C3pbcfULDz42yEUB581MVA6I+Y43Wp4OIqEy73HCdmZ0GTjeAHY2ycuH4N00d9VsLrwT1jxshTw==",
      "linux",
      "x64",
    ),
    "node_modules/@openai/codex-win32-arm64": platform(
      "0.171.0-win32-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.171.0-win32-arm64.tgz",
      "sha512-kkavDHtAkkNaYtO7eBw4IdBbE/PsWP+Ezp9JXcr/mBu/Cc7EevzFVIVC3sZYvWsF9xuvyjIUv9CKeN0LU0+N9Q==",
      "win32",
      "arm64",
    ),
    "node_modules/@openai/codex-win32-x64": platform(
      "0.171.0-win32-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.171.0-win32-x64.tgz",
      "sha512-HKWBK25tLQxdEg6svw0CrBf+v0bQhRyF8EBVdNqeRxErqpfFa/dfSar6r3sJt6tyPqozOtgz2BH8B2G3n/+gnQ==",
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
