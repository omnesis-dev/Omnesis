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
      dependencies: { "@openai/codex": "0.167.0" },
    },
    "node_modules/@openai/codex": {
      version: "0.167.0",
      resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0.tgz",
      integrity:
        "sha512-1FSQgbTIKAdTub5Ln6z36NT4eXDmBRkinfigzycbgn9yLZdJ3UdkQZqr0N7jnl8/D1xxT/Pz3Fl2l7S2dmRaFA==",
      license: "Apache-2.0",
      bin: { codex: "bin/codex.js" },
      engines: { node: ">=16" },
      optionalDependencies: {
        "@openai/codex-darwin-arm64": "npm:@openai/codex@0.167.0-darwin-arm64",
        "@openai/codex-darwin-x64": "npm:@openai/codex@0.167.0-darwin-x64",
        "@openai/codex-linux-arm64": "npm:@openai/codex@0.167.0-linux-arm64",
        "@openai/codex-linux-x64": "npm:@openai/codex@0.167.0-linux-x64",
        "@openai/codex-win32-arm64": "npm:@openai/codex@0.167.0-win32-arm64",
        "@openai/codex-win32-x64": "npm:@openai/codex@0.167.0-win32-x64",
      },
    },
    "node_modules/@openai/codex-darwin-arm64": platform(
      "0.167.0-darwin-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-darwin-arm64.tgz",
      "sha512-7YtMDZX/jbWH9+fCVQg7BVsov8WvBzu4iuedXJEDlUdZxaTrYX2bEQwHIn3p0gxgSMfm30HGK9+bZm1aGSZaHw==",
      "darwin",
      "arm64",
    ),
    "node_modules/@openai/codex-darwin-x64": platform(
      "0.167.0-darwin-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-darwin-x64.tgz",
      "sha512-wKoBiI6SBSg8fqiEYEOJs/NM/ZzKaCgy1cseX9LJbuDq3GCCKkeW9BUGe1ZEkyhhZ5Yfj+HzdUfp698abP2tDA==",
      "darwin",
      "x64",
    ),
    "node_modules/@openai/codex-linux-arm64": platform(
      "0.167.0-linux-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-linux-arm64.tgz",
      "sha512-5cv+sybRWqpRJL6KCv3YSnIx1GHRmjek997C38n1Zfno4HomKDLkNSjWLDOOc2+ISlVNSRRnySWq4zKmzlY12g==",
      "linux",
      "arm64",
    ),
    "node_modules/@openai/codex-linux-x64": platform(
      "0.167.0-linux-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-linux-x64.tgz",
      "sha512-FNc7danfUng9Sp6w+Fh7kofNHHZpA6VMyNKWsWrS3OwHly69gywTWeiuwrUPXpJSho8Df4xqRsHfHRPzj7zYQg==",
      "linux",
      "x64",
    ),
    "node_modules/@openai/codex-win32-arm64": platform(
      "0.167.0-win32-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-win32-arm64.tgz",
      "sha512-dYeYQZ66LCNnFXyF5vHRsbJQLyfbY3G8vDyn6XG3NxcwMFz4stkgSdC94UPc1NhCxkhpufHlkAm1oe+Z28Pw5Q==",
      "win32",
      "arm64",
    ),
    "node_modules/@openai/codex-win32-x64": platform(
      "0.167.0-win32-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.167.0-win32-x64.tgz",
      "sha512-duPCBwflc8qhQdLekbL8fDYF646tW4gj0/l9BDnsVhEzoqm6OwxMAJXDFwSOLUUJPCmjBeM+eHYAx4fP/hwfjg==",
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
