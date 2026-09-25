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
      dependencies: { "@openai/codex": "0.151.0" },
    },
    "node_modules/@openai/codex": {
      version: "0.151.0",
      resolved: "https://registry.npmjs.org/@openai/codex/-/codex-0.151.0.tgz",
      integrity:
        "sha512-mhtWmOZRdmWD1jPbLDnQb59BsaVP/V+lXe/OFNR9ZcLZU0UCiBwn98Fcav1ss7sDIlHkuqj6nWd44IPeXoOhJA==",
      license: "Apache-2.0",
      bin: { codex: "bin/codex.js" },
      engines: { node: ">=16" },
      optionalDependencies: {
        "@openai/codex-darwin-arm64": "npm:@openai/codex@0.151.0-darwin-arm64",
        "@openai/codex-darwin-x64": "npm:@openai/codex@0.151.0-darwin-x64",
        "@openai/codex-linux-arm64": "npm:@openai/codex@0.151.0-linux-arm64",
        "@openai/codex-linux-x64": "npm:@openai/codex@0.151.0-linux-x64",
        "@openai/codex-win32-arm64": "npm:@openai/codex@0.151.0-win32-arm64",
        "@openai/codex-win32-x64": "npm:@openai/codex@0.151.0-win32-x64",
      },
    },
    "node_modules/@openai/codex-darwin-arm64": platform(
      "0.151.0-darwin-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.151.0-darwin-arm64.tgz",
      "sha512-g7YzpaCZGCw19R/gly3vRPjnLqaW7JcBAu2WQQ6e8PIlvBPmS/gMplIUURMgNO6gi8LsPzdlQtLqkwoeOOlIdg==",
      "darwin",
      "arm64",
    ),
    "node_modules/@openai/codex-darwin-x64": platform(
      "0.151.0-darwin-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.151.0-darwin-x64.tgz",
      "sha512-0y+g8TVpP+Fn10mjoKYXER6qYjn29w7xBUsbPXJ6Accu/FoM4Qp4WbKXQPmE0G0yUACTQVZRjzTSsdWUezNgkg==",
      "darwin",
      "x64",
    ),
    "node_modules/@openai/codex-linux-arm64": platform(
      "0.151.0-linux-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.151.0-linux-arm64.tgz",
      "sha512-CsLgFeX4TQ6I2Gdrxd2r5UbgIbDLCdtcLAlnMYjr06bCL057MTNGec7Ewb3+Z2DBiMuXCljdTBGqLOePkMV0sQ==",
      "linux",
      "arm64",
    ),
    "node_modules/@openai/codex-linux-x64": platform(
      "0.151.0-linux-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.151.0-linux-x64.tgz",
      "sha512-xcVyY1FtwvVYhh2JBmz8fX8CQqFAxO/lxJ2IXsh8x5uwxZVHVl5fZHFHf8JdRaOGG0vpkYmu/DKKVoLd56/DDQ==",
      "linux",
      "x64",
    ),
    "node_modules/@openai/codex-win32-arm64": platform(
      "0.151.0-win32-arm64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.151.0-win32-arm64.tgz",
      "sha512-zDWzOoh9wHm+Om1Nhn7os47rAVeSGPh0SnM3YOttdq6iPJz2zn4vBnbGUZjeih1qW/3mvNF3Oyd4owlaHmphmg==",
      "win32",
      "arm64",
    ),
    "node_modules/@openai/codex-win32-x64": platform(
      "0.151.0-win32-x64",
      "https://registry.npmjs.org/@openai/codex/-/codex-0.151.0-win32-x64.tgz",
      "sha512-sLT7xvID3jhU6tkzcwRPnMEclKRwUPbpo0mtfxIF9KpdZH3VJV7sM2/kXWXyvUM7Zt/YeyOaeATTEysbRz8Yog==",
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
